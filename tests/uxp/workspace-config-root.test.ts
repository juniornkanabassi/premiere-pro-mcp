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

  it("keeps a folder picked in the panel as the fallback and lets revoke clear a configured one", async () => {
    const picked = folder("/Users/j/Picked");
    const root = folder("/Users/j/Workspace");
    const files = new Map<string, string>();
    const dataFolder = {
      getEntry: vi.fn(async (name: string) => ({ read: async () => files.get(name), delete: async () => { files.delete(name); } })),
      createFile: vi.fn(async (name: string) => ({ write: async (value: string) => { files.set(name, value); } })),
    };
    const fs = fsFor(root, { getFolder: vi.fn(async () => picked), getDataFolder: vi.fn(async () => dataFolder) });
    const broker = Workspace.createWorkspaceBroker({ fs });
    await broker.requestRoot();
    await expect(broker.configureRoot("/Users/j/Workspace")).resolves.toMatchObject({ rootName: "Picked", accessMode: "request", persistent: true });

    const fresh = Workspace.createWorkspaceBroker({ fs: fsFor(root) });
    await fresh.configureRoot("/Users/j/Workspace");
    await expect(fresh.revoke()).resolves.toMatchObject({ configured: false, accessMode: "request" });
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
    expect(panel).toContain("workspaceBroker.configureRoot(root)");
    expect(panel).toContain("applyServerConfig(event.data)");
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
