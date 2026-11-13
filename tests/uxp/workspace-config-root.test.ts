import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const Workspace = require("../../uxp-plugin/workspace.cjs");

function folder(nativePath: string, children: Record<string, unknown> = {}) {
  const name = nativePath.split("/").pop() as string;
  return {
    isFolder: true, name, nativePath,
    getEntry: vi.fn(async (child: string) => {
      if (!(child in children)) throw new Error("missing");
      return children[child];
    }),
  };
}

function fsFor(root: ReturnType<typeof folder>, extra: Record<string, unknown> = {}) {
  return {
    getEntryWithUrl: vi.fn(async (url: string) => {
      if (url === "file:" + root.nativePath.split("/").map(encodeURIComponent).join("/")) return root;
      throw new Error("not found");
    }),
    getFolder: vi.fn(),
    createPersistentToken: vi.fn(async () => "token"),
    getDataFolder: vi.fn(async () => { throw new Error("no data folder"); }),
    ...extra,
  };
}

describe("server-configured workspace root (item 3)", () => {
  it("ships the panel with fullAccess so no picker click is needed", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "uxp-plugin", "manifest.json"), "utf8"));
    expect(manifest.requiredPermissions.localFileSystem).toBe("fullAccess");
  });

  it("approves the configured folder without the picker and keeps the path guard", async () => {
    const media = { isFolder: false, name: "frame.png", nativePath: "/Users/j/Workspace/frames/frame.png" };
    const frames = folder("/Users/j/Workspace/frames", { "frame.png": media });
    const root = folder("/Users/j/Workspace", { frames });
    const fs = fsFor(root);
    const broker = Workspace.createWorkspaceBroker({ fs });
    expect(broker.status()).toMatchObject({ configured: false, canonicalPathValidation: "unavailable" });

    await expect(broker.configureRoot("/Users/j/Workspace")).resolves.toMatchObject({
      configured: true, accessMode: "configured", persistent: false, rootName: "Workspace", canonicalPathValidation: "available",
    });
    expect(fs.getFolder).not.toHaveBeenCalled();
    await expect(broker.assertPathAllowed("/Users/j/Workspace/frames/frame.png", { label: "path", kind: "file" }))
      .resolves.toBe("/Users/j/Workspace/frames/frame.png");
    await expect(broker.assertPathAllowed("/Users/j/Elsewhere/frame.png", { label: "path", kind: "file" }))
      .rejects.toMatchObject({ code: "UXP_PATH_OUTSIDE_WORKSPACE" });
    await expect(broker.assertPathAllowed("/Users/j/Workspace/../Elsewhere/x.png", { label: "path", kind: "file" }))
      .rejects.toMatchObject({ code: "UXP_PATH_OUTSIDE_WORKSPACE" });
  });

  it("refuses a filesystem root, a relative path and a file", async () => {
    const root = folder("/Users/j/Workspace");
    const broker = Workspace.createWorkspaceBroker({ fs: fsFor(root) });
    await expect(broker.configureRoot("/")).rejects.toMatchObject({ code: "UXP_WORKSPACE_TOO_BROAD" });
    await expect(broker.configureRoot("Workspace")).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    const file = { isFolder: false, name: "a.txt", nativePath: "/Users/j/a.txt" };
    const fileBroker = Workspace.createWorkspaceBroker({ fs: { getEntryWithUrl: async () => file } });
    await expect(fileBroker.configureRoot("/Users/j/a.txt")).rejects.toMatchObject({ code: "UXP_WORKSPACE_NOT_SELECTED" });
    expect(broker.status().configured).toBe(false);
  });

  it("explains a missing folder and a runtime without getEntryWithUrl", async () => {
    const broker = Workspace.createWorkspaceBroker({ fs: { getEntryWithUrl: async () => { throw new Error("nope"); } } });
    await expect(broker.configureRoot("/Users/j/Gone")).rejects.toMatchObject({ code: "UXP_WORKSPACE_UNAVAILABLE", message: expect.stringContaining("fullAccess") });
    const bare = Workspace.createWorkspaceBroker({ fs: {} });
    await expect(bare.configureRoot("/Users/j/Workspace")).rejects.toMatchObject({ code: "UXP_WORKSPACE_UNAVAILABLE" });
  });

  it("uses the configured root when a different folder was also picked, and reports the conflict", async () => {
    const picked = folder("/Users/j/Picked");
    const root = folder("/Users/j/Workspace");
    const files = new Map<string, string>();
    const dataFolder = {
      getEntry: vi.fn(async (name: string) => ({ read: async () => files.get(name), delete: async () => { files.delete(name); } })),
      createFile: vi.fn(async (name: string) => ({ write: async (value: string) => { files.set(name, value); } })),
    };
    const fs = fsFor(root, { getFolder: vi.fn(async () => picked), getDataFolder: vi.fn(async () => dataFolder) });
    const pickedFirst = Workspace.createWorkspaceBroker({ fs });
    await pickedFirst.requestRoot();
    await expect(pickedFirst.configureRoot("/Users/j/Workspace")).resolves.toMatchObject({
      rootName: "Workspace", accessMode: "configured", pickedFolderIgnored: "Picked", configError: null,
    });
    // Picking after the server's root was applied cannot displace it either.
    const configuredFirst = Workspace.createWorkspaceBroker({ fs });
    await configuredFirst.configureRoot("/Users/j/Workspace");
    await expect(configuredFirst.requestRoot()).resolves.toMatchObject({ rootName: "Workspace", accessMode: "configured", pickedFolderIgnored: "Picked" });
    // Picking the same folder is no conflict.
    const same = Workspace.createWorkspaceBroker({ fs: fsFor(root, { getFolder: vi.fn(async () => root), getDataFolder: vi.fn(async () => dataFolder) }) });
    await same.configureRoot("/Users/j/Workspace");
    await expect(same.requestRoot()).resolves.toMatchObject({ pickedFolderIgnored: null });

    const fresh = Workspace.createWorkspaceBroker({ fs: fsFor(root) });
    await fresh.configureRoot("/Users/j/Workspace");
    await expect(fresh.revoke()).resolves.toMatchObject({ configured: false, accessMode: "request" });
  });

  it("refuses a depth-1 root and the home folder, and carries the reason as configError", async () => {
    const broker = Workspace.createWorkspaceBroker({ fs: fsFor(folder("/Users/j/Workspace")) });
    for (const bad of ["/Users", "/Users/j", "/home/j", "C:/Users/j"]) {
      await expect(broker.configureRoot(bad)).rejects.toMatchObject({ code: "UXP_WORKSPACE_TOO_BROAD" });
    }
    expect(broker.status()).toMatchObject({ configured: false, configError: expect.stringContaining("home folder") });
    await broker.configureRoot("/Users/j/Workspace");
    expect(broker.status().configError).toBeNull();
    const missing = Workspace.createWorkspaceBroker({ fs: { getEntryWithUrl: async () => { throw new Error("nope"); } } });
    await expect(missing.configureRoot("/Users/j/Gone")).rejects.toBeTruthy();
    expect(missing.status().configError).toContain("fullAccess");
  });

  it("fails closed: a refused server root leaves no approved folder, old or picked", async () => {
    const root = folder("/Users/j/Workspace");
    const file = { isFolder: false, name: "x.png", nativePath: "/Users/j/Workspace/x.png" };
    const check = (broker: any) => broker.assertPathAllowed(file.nativePath, { label: "path", kind: "file" });
    // (a) an earlier server root, then a refused new root
    const earlier = Workspace.createWorkspaceBroker({ fs: fsFor(root) });
    await earlier.configureRoot("/Users/j/Workspace");
    await expect(earlier.configureRoot("/Users/j")).rejects.toMatchObject({ code: "UXP_WORKSPACE_TOO_BROAD" });
    expect(earlier.status()).toMatchObject({ configured: false, accessMode: "request", persistent: false, configError: expect.any(String) });
    await expect(check(earlier)).rejects.toMatchObject({ code: "UXP_WORKSPACE_REQUIRED" });
    // (b) a picked home folder, then a failed configure
    const home = folder("/Users/j");
    const store = new Map<string, string>();
    const dataFolder = { getEntry: async (name: string) => ({ read: async () => store.get(name), delete: async () => {} }), createFile: async (name: string) => ({ write: async (value: string) => { store.set(name, value); } }) };
    const picked = Workspace.createWorkspaceBroker({ fs: fsFor(root, { getFolder: vi.fn(async () => home), getDataFolder: vi.fn(async () => dataFolder) }) });
    await picked.requestRoot();
    await expect(picked.configureRoot("/Users/j/Gone")).rejects.toMatchObject({ code: "UXP_WORKSPACE_UNAVAILABLE" });
    expect(picked.status().configured).toBe(false);
    await expect(picked.assertPathAllowed("/Users/j/Workspace/x.png", { label: "path", kind: "file" })).rejects.toMatchObject({ code: "UXP_WORKSPACE_REQUIRED" });
    // picking a folder again does not reopen it while the server's root is refused
    await picked.requestRoot();
    expect(picked.status().configured).toBe(false);
    // a later good config frame recovers
    await expect(picked.configureRoot("/Users/j/Workspace")).resolves.toMatchObject({ configured: true, configError: null, accessMode: "configured" });
  });

  it("keeps /root and /root-evil apart", async () => {
    const evil = { isFolder: false, name: "x.png", nativePath: "/Users/j/Workspace-evil/x.png" };
    const root = folder("/Users/j/Workspace", {});
    const broker = Workspace.createWorkspaceBroker({ fs: fsFor(root) });
    await broker.configureRoot("/Users/j/Workspace");
    await expect(broker.assertPathAllowed(evil.nativePath, { label: "path", kind: "file" })).rejects.toMatchObject({ code: "UXP_PATH_OUTSIDE_WORKSPACE" });
    await expect(broker.assertPathAllowed("/Users/j/Workspace-evil", { label: "path", kind: "directory" })).rejects.toMatchObject({ code: "UXP_PATH_OUTSIDE_WORKSPACE" });
    await expect(broker.assertPathAllowed("/Users/j/Workspace", { label: "path", kind: "directory" })).resolves.toBe("/Users/j/Workspace");
  });

  it("applies only the first config frame per connection and passes other frames through", async () => {
    const root = folder("/Users/j/Workspace");
    const other = folder("/Users/j/Other");
    const fs = fsFor(root, { getEntryWithUrl: vi.fn(async (url: string) => url.endsWith("/Other") ? other : root) });
    const broker = Workspace.createWorkspaceBroker({ fs });
    const applied: unknown[] = [];
    const receiver = broker.createConfigReceiver({ onApplied: (value: unknown) => applied.push(value) });
    const frame = (workspaceRoot: string) => JSON.stringify({ protocolVersion: 2, type: "config", payload: { workspaceRoot } });
    expect(receiver.receive(JSON.stringify({ type: "command", command: "state.get" }))).toBe(false);
    expect(receiver.receive("not json but mentions \"config\"")).toBe(false);
    expect(receiver.receive(frame("/Users/j/Workspace"))).toBe(true);
    expect(receiver.receive(frame("/Users/j/Other"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(applied).toHaveLength(1);
    expect(broker.status().rootName).toBe("Workspace");
    // A new connection may configure again.
    receiver.reset();
    expect(receiver.receive(frame("/Users/j/Other"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(broker.status().rootName).toBe("Other");
  });

  it("names the server setting and the panel button when no folder is approved", async () => {
    const broker = Workspace.createWorkspaceBroker({ fs: {} });
    await expect(broker.assertPathAllowed("/Users/j/x.png", { label: "outputDirectory", kind: "directory" })).rejects.toMatchObject({
      code: "UXP_WORKSPACE_REQUIRED",
      message: expect.stringMatching(/PREMIERE_UXP_WORKSPACE_ROOT.*Choose folder/),
    });
  });
});

describe("panel source (items 3, 4, 13)", () => {
  const panel = readFileSync(join(process.cwd(), "uxp-plugin", "index.cjs"), "utf8");
  it("applies the server's config frame through the broker", () => {
    expect(panel).toContain("workspaceBroker.createConfigReceiver(");
    expect(panel).toContain("serverConfig.receive(event.data)");
    expect(panel).toContain("serverConfig.reset()");
  });
  it("keeps captions.create unsupported with the real reason and alternatives", () => {
    const line = panel.split("\n").find((entry) => entry.includes('"captions.create"')) ?? "";
    expect(line).toContain("supported: false");
    expect(line).toContain("27.0");
    expect(line).toContain("Captions panel");
    expect(line).toContain("transcript.import");
  });
  it("serialises GUIDs as strings in state.get and forwards the pin and noHostWrite flag", () => {
    expect(panel).toContain("id: idString(sequence.guid)");
    expect(panel).toContain("id: idString(project.guid)");
    expect(panel).toContain("pinnedSequenceIdOf(raw)");
    expect(panel).toContain('{ noHostWrite: true, dispatchEvidence: "handler_pre_write" }');
  });
});

describe("configured root with spaces in the path (live Premiere 27)", () => {
  it("falls back to the plain file: path when the %20 form is rejected", async () => {
    const root = folder("/Users/j/05 Other/Codex Workspace");
    const fs = { ...fsFor(root), getEntryWithUrl: vi.fn(async (url: string) => { if (url === "file:" + root.nativePath) return root; throw new Error("not found"); }) };
    const broker = Workspace.createWorkspaceBroker({ fs });
    await broker.configureRoot(root.nativePath);
    expect(broker.status()).toMatchObject({ configured: true, configError: null });
    expect(fs.getEntryWithUrl).toHaveBeenCalledWith("file:/Users/j/05%20Other/Codex%20Workspace");
  });
});
