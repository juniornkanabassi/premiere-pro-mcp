import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";
import { withInvocationContext, currentInvocation } from "../../src/workflows/invocation-context.js";
import { cleanupTempDirs, makePrivateBridgeTempDir } from "../helpers/temp-dir.js";

const active: UxpWebSocketBridge[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map((bridge) => bridge.stop())); cleanupTempDirs(); });

type Frame = { requestId: string; command: string; args: Record<string, unknown>; pinnedSequenceId?: string; type: string; payload?: unknown };

async function connected(options: { workspaceRoot?: string; commands?: Record<string, unknown> } = {}) {
  const token = "no-host-write-token-sixteen";
  const tempDir = makePrivateBridgeTempDir("uxp-nhw-lease-");
  const bridge = new UxpWebSocketBridge({ token, port: 0, requestTimeoutMs: 200, tempDir, ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}) });
  active.push(bridge);
  await bridge.start();
  const address = bridge.address();
  const client = new WebSocket(`ws://${address.host}:${address.port}${address.path}?token=${token}`);
  const frames: Frame[] = [];
  client.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await once(client, "open");
  const ready = once(bridge, "connected");
  client.send(JSON.stringify({
    protocolVersion: 2, type: "hello",
    payload: {
      backend: "uxp", protocolVersion: 2, commandSchemaVersion: 1, receiptVersion: 1, replayPersistence: "durable_hashed_tombstones",
      commands: {
        "test.mutate": { supported: true, readOnly: false },
        "test.select": { supported: true, readOnly: false, nonFencing: true },
        "state.get": { supported: true, readOnly: true },
        "sequences.activate": { supported: true, readOnly: false },
        "sequences.close": { supported: true, readOnly: false },
        "sequences.createEmpty": { supported: true, readOnly: false },
        "sequences.inspect": { supported: true, readOnly: true },
        "sequence.createPreset": { supported: true, readOnly: false },
        "frame.export": { supported: false, readOnly: false, reason: "No workspace folder is approved. Set PREMIERE_UXP_WORKSPACE_ROOT on the MCP server." },
        ...options.commands,
      },
    },
  }));
  await ready;
  return { bridge, client, frames };
}

const realTemp = () => realpathSync(mkdtempSync(join(tmpdir(), "uxp-root-")));

const reply = (client: WebSocket, frame: Frame, payload: unknown) =>
  client.send(JSON.stringify({ protocolVersion: 2, type: "result", requestId: frame.requestId, payload }));

describe("noHostWrite refusals (item 10)", () => {
  it("does not record an uncertain operation for a handler refusal that wrote nothing", async () => {
    const { bridge, client } = await connected();
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.command === "test.mutate") reply(client, frame, { ok: false, error: { code: "UXP_INVALID_ARGUMENT", message: "Unknown argument: x", noHostWrite: true, dispatchEvidence: "handler_pre_write" } });
    });
    await expect(bridge.request("test.mutate", { x: 1 })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    expect(bridge.getOperationRecovery().recoveryRequired).toBe(false);
    await expect(bridge.request("test.mutate", {})).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
  });

  it("still records uncertainty for a failure without the flag, or with the wrong evidence", async () => {
    for (const error of [
      { code: "UXP_VERIFICATION_FAILED", message: "after write" },
      { code: "UXP_INVALID_ARGUMENT", message: "claimed", noHostWrite: true, dispatchEvidence: "something_else" },
    ]) {
      const { bridge, client } = await connected();
      client.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Frame;
        if (frame.command === "test.mutate") reply(client, frame, { ok: false, error });
      });
      await expect(bridge.request("test.mutate", {})).rejects.toMatchObject({ code: error.code });
      expect(bridge.getOperationRecovery().recoveryRequired).toBe(true);
    }
  });

  it("clears the invocation's dispatched mark for a no-write refusal but keeps an earlier real dispatch", async () => {
    const { bridge, client } = await connected();
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.command !== "test.mutate") return;
      if (frame.args.refuse) reply(client, frame, { ok: false, error: { code: "UXP_INVALID_ARGUMENT", message: "no", noHostWrite: true, dispatchEvidence: "handler_pre_write" } });
      else reply(client, frame, { ok: true, result: { outcome: "verified" } });
    });
    await withInvocationContext({}, async () => {
      await expect(bridge.request("test.mutate", { refuse: true })).rejects.toBeTruthy();
      expect(currentInvocation()?.dispatched).toBe(false);
    });
    await withInvocationContext({}, async () => {
      await bridge.request("test.mutate", {});
      await expect(bridge.request("test.mutate", { refuse: true })).rejects.toBeTruthy();
      expect(currentInvocation()?.dispatched).toBe(true);
    });
  });

  it("treats a nonFencing command as non-mutating, so a lost reply never blocks later writes", async () => {
    const { bridge } = await connected();
    await expect(bridge.request("test.select", {})).rejects.toMatchObject({ code: "UXP_TIMEOUT" });
    expect(bridge.getOperationRecovery().recoveryRequired).toBe(false);
  });
});

describe("sequence pin (item 13)", () => {
  it("pins after a verified activate and sends the pin beside args on later mutating requests only", async () => {
    const { bridge, client, frames } = await connected();
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.type !== "command") return;
      if (frame.command === "sequences.activate") reply(client, frame, { ok: true, result: { outcome: "verified", sequence: { id: "seq-A", name: "A" } } });
      else reply(client, frame, { ok: true, result: { outcome: "verified" } });
    });
    await bridge.request("test.mutate", {});
    await bridge.request("sequences.activate", { sequenceId: "seq-A" });
    expect(bridge.getPinnedSequence()).toBe("seq-A");
    await bridge.request("test.mutate", { value: 1 });
    await bridge.request("state.get");
    await bridge.request("sequences.activate", { sequenceId: "seq-A" });
    const byCommand = (command: string) => frames.filter((frame) => frame.command === command);
    expect(byCommand("test.mutate")[0].pinnedSequenceId).toBeUndefined();
    expect(byCommand("test.mutate")[1].pinnedSequenceId).toBe("seq-A");
    expect(byCommand("test.mutate")[1].args).toEqual({ value: 1 });
    expect(byCommand("state.get")[0].pinnedSequenceId).toBeUndefined();
    expect(byCommand("sequences.activate")[1].pinnedSequenceId).toBeUndefined();
  });

  it("pins from any accepted activate, and forgets a closed or deleted pinned sequence", async () => {
    const { bridge, client } = await connected();
    let outcome = "committed_unverified";
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.type === "command") reply(client, frame, { ok: true, result: { outcome, sequence: { id: "seq-B", name: "B" } } });
    });
    await bridge.request("sequences.activate", {});
    expect(bridge.getPinnedSequence()).toBe("seq-B");
    outcome = "verified";
    await bridge.request("sequences.activate", {});
    expect(bridge.getPinnedSequence()).toBe("seq-B");
    await bridge.request("sequences.close", {});
    expect(bridge.getPinnedSequence()).toBeNull();
  });

  it("keeps the pin when an activate is refused, and clears it after a project open or close", async () => {
    const { bridge, client } = await connected({ commands: { "project.sessions.open": { supported: true, readOnly: false }, "project.sessions.close": { supported: true, readOnly: false } } });
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.type !== "command") return;
      if (frame.args.refuse) reply(client, frame, { ok: false, error: { code: "UXP_INVALID_ARGUMENT", message: "no", noHostWrite: true, dispatchEvidence: "handler_pre_write" } });
      else reply(client, frame, { ok: true, result: { outcome: "verified", sequence: { id: "seq-A", name: "A" } } });
    });
    await bridge.request("sequences.activate", {});
    await expect(bridge.request("sequences.activate", { refuse: true })).rejects.toBeTruthy();
    expect(bridge.getPinnedSequence()).toBe("seq-A");
    await bridge.request("project.sessions.open", {});
    expect(bridge.getPinnedSequence()).toBeNull();
    await bridge.request("sequences.activate", {});
    await bridge.request("project.sessions.close", {});
    expect(bridge.getPinnedSequence()).toBeNull();
  });

  it("clears the pin after any successful mutating sequence command, but not after a read", async () => {
    const { bridge, client } = await connected();
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.type !== "command") return;
      if (frame.command === "sequences.activate") reply(client, frame, { ok: true, result: { outcome: "verified", sequence: { id: "seq-A", name: "A" } } });
      else if (frame.command === "sequences.createEmpty") reply(client, frame, { ok: true, result: { outcome: "verified", sequence: { id: "seq-B", name: "B" } } });
      else reply(client, frame, { ok: true, result: { outcome: "verified" } });
    });
    await bridge.request("sequences.activate", {});
    await bridge.request("sequences.inspect", {});
    expect(bridge.getPinnedSequence()).toBe("seq-A");
    await bridge.request("sequences.createEmpty", {});
    expect(bridge.getPinnedSequence()).toBeNull();
    await bridge.request("sequences.activate", {});
    await bridge.request("sequence.createPreset", {});
    expect(bridge.getPinnedSequence()).toBeNull();
  });

  it("lets the caller pin and clear explicitly", async () => {
    const { bridge } = await connected();
    bridge.pinSequence("seq-C");
    expect(bridge.getPinnedSequence()).toBe("seq-C");
    bridge.pinSequence(null);
    expect(bridge.getPinnedSequence()).toBeNull();
  });
});

describe("configured workspace root (item 3)", () => {
  it("sends the approved root to the panel after the handshake", async () => {
    const root = realTemp();
    const { frames, client } = await connected({ workspaceRoot: root });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames.find((frame) => frame.type === "config")).toMatchObject({ protocolVersion: 2, payload: { workspaceRoot: root } });
    client.close();
  });

  it("sends nothing when no root is configured", async () => {
    const saved = process.env.PREMIERE_UXP_WORKSPACE_ROOT;
    delete process.env.PREMIERE_UXP_WORKSPACE_ROOT;
    try {
      const { frames } = await connected();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(frames.some((frame) => frame.type === "config")).toBe(false);
    } finally {
      if (saved !== undefined) process.env.PREMIERE_UXP_WORKSPACE_ROOT = saved;
    }
  });

  it("refuses a relative path, a filesystem root, a share root and the home folder", () => {
    const make = (workspaceRoot: string) => () => new UxpWebSocketBridge({ token: "x".repeat(16), workspaceRoot });
    expect(make("relative/dir")).toThrow(/absolute project folder/);
    expect(make("/")).toThrow(/not a filesystem root/);
    expect(make("/Volumes")).toThrow(/not a filesystem root/);
    expect(make(homedir())).toThrow(/home folder/);
  });

  it("fails closed when the root is missing, is a symlink, or sits under one", () => {
    const real = realTemp();
    mkdirSync(join(real, "target"));
    symlinkSync(join(real, "target"), join(real, "link"));
    const make = (workspaceRoot: string) => () => new UxpWebSocketBridge({ token: "x".repeat(16), workspaceRoot });
    expect(make(join(real, "missing"))).toThrow(/cannot be resolved/);
    expect(make(join(real, "link"))).toThrow(/is or contains a symlink.*resolves to/);
    mkdirSync(join(real, "target", "inner"));
    expect(make(join(real, "link", "inner"))).toThrow(/is or contains a symlink/);
    expect(make(join(real, "target"))).not.toThrow();
  });

  it("puts the panel's own reason in the unsupported-command error", async () => {
    const { bridge } = await connected();
    await expect(bridge.request("frame.export", {})).rejects.toMatchObject({
      code: "UXP_COMMAND_UNSUPPORTED",
      message: expect.stringContaining("PREMIERE_UXP_WORKSPACE_ROOT"),
    });
  });
});
