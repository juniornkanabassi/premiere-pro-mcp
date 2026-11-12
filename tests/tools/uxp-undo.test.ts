import { describe, expect, it, vi } from "vitest";
import { getUxpUndoTools, observeUxpEdits } from "../../src/tools/uxp-undo.js";
import type { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";

const clip = (over: Record<string, unknown> = {}) => ({ mediaType: "video", trackIndex: 0, clipIndex: 0, startSeconds: 0, endSeconds: 10, inSeconds: 0, outSeconds: 10, disabled: false, name: "A", ...over });
const moved = { verified: true, updated: true, before: clip(), after: clip({ startSeconds: 1, endSeconds: 11 }) };

type Live = (command: string, args: any, ctx: { identity: { sequence: string; project: string } }) => unknown;

// A fake panel. Identity reads answer from `ctx`; everything else from `live` (default: verified).
function setup(live: Live | Record<string, unknown> = {}) {
  const ctx = { identity: { sequence: "seq-1", project: "/p.prproj" } };
  const request = vi.fn(async (command: string, args: any) => {
    if (command === "sequences.inspect") return { activeSequenceId: ctx.identity.sequence };
    if (command === "sequenceSettings.get") return typeof live === "function" ? (live(command, args, ctx) as any)?.settings ? live(command, args, ctx) : { settings: { videoFrameRate: 25 } } : { settings: { videoFrameRate: 25 } };
    if (command === "state.get") return { project: { id: {}, path: ctx.identity.project } };
    if (typeof live === "function") return live(command, args, ctx);
    return live[command] ?? { verified: true, outcome: "verified" };
  });
  const bridge = { request } as unknown as UxpWebSocketBridge;
  const observed = observeUxpEdits(bridge);
  const tools = getUxpUndoTools(bridge);
  const writes = () => request.mock.calls.map(([command]) => command).filter((command) => !/\.(inspect|get)$/.test(command));
  const list = async () => ((await tools.inspect_undo_stack_uxp.handler()) as any).data.entries as any[];
  return { request, observed, tools, ctx, writes, list };
}

const razorReceipt = { verified: true, outcome: "verified", cutSeconds: 4, cutTicks: "40640000000", halves: [{ mediaType: "video", trackIndex: 0, projectItemId: "pi-1", leftStartSeconds: 0, rightEndSeconds: 10 }] };
const razorArgs = { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 4, confirmRazor: true, operationId: "razor-1" };

describe("MCP-side undo stack: recording", () => {
  it("pushes a blocker for anything mutating it cannot reverse, and nothing for reads or pre-write refusals", async () => {
    const { observed, list, request } = setup({ "trackItem.update": { ...moved, verified: false }, "trackItem.clone": { verified: true }, "timeline.overwrite": { verified: true } });
    await observed.request("trackItem.inspect", {});
    await observed.request("state.get", {});
    expect(await list()).toHaveLength(0);

    await observed.request("trackItem.update", {});      // not verified
    await observed.request("trackItem.clone", {});       // verified but no inverse
    await observed.request("some.newCommand", {});        // unknown mutating command
    request.mockImplementationOnce(async () => { throw Object.assign(new Error("lost"), { code: "UXP_TIMEOUT" }); });
    await expect(observed.request("markers.add", {})).rejects.toThrow("lost");
    request.mockImplementationOnce(async () => { throw Object.assign(new Error("refused"), { noHostWrite: true }); });
    await expect(observed.request("markers.add", {})).rejects.toThrow("refused");
    request.mockImplementationOnce(async () => { throw Object.assign(new Error("offline"), { code: "UXP_NOT_CONNECTED" }); });
    await expect(observed.request("markers.add", {})).rejects.toThrow("offline");

    const entries = await list();
    expect(entries.map((entry) => entry.command)).toEqual(["markers.add", "some.newCommand", "trackItem.clone", "trackItem.update"]);
    expect(entries.every((entry) => entry.invertible === false)).toBe(true);
  });

  it("records a razor across all tracks as not undoable and a single-clip razor as undoable", async () => {
    const { observed, list } = setup({ "trackItem.razor": razorReceipt });
    await observed.request("trackItem.razor", { allTracks: true, timeSeconds: 4 });
    await observed.request("trackItem.razor", { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 4 });
    expect((await list()).map((entry) => entry.invertible)).toEqual([true, false]);
  });
});

describe("MCP-side undo stack: undo", () => {
  it("undoes a move, finding the clip again when it changed index, and reads the result back", async () => {
    // After the move the clip sits at index 1, behind a neighbour; undoing puts it back at index 0.
    let clips = [clip({ name: "B", startSeconds: 0.5, endSeconds: 0.9, inSeconds: 0, outSeconds: 0.4 }), clip({ clipIndex: 1, startSeconds: 1, endSeconds: 11 })];
    const { observed, tools, request, writes } = setup((command, args) => {
      if (command === "trackItem.inspect") return clips[args.clipIndex] ?? (() => { throw new Error("out of range"); })();
      if (command === "trackItem.update") { if (!args.operationId) return moved; clips = [clip(), clips[0]]; return { verified: true }; }
      return moved;
    });
    await observed.request("trackItem.update", {});
    request.mockClear();
    const result: any = await tools.undo_last_edit_uxp.handler({});
    const update = request.mock.calls.find(([command]) => command === "trackItem.update")!;
    expect(update[1]).toMatchObject({ mediaType: "video", trackIndex: 0, clipIndex: 1, expectedStartSeconds: 1, expectedEndSeconds: 11, moveBySeconds: -1 });
    expect(update[1].operationId).toMatch(/^undo-1-\d+-1$/);
    expect(result).toMatchObject({ success: true, data: { outcome: "verified", verified: true, remaining: 0 } });
    expect(writes()).toEqual(["trackItem.update"]);
  });

  it("restores only the edge when the source point followed a start trim, and records name-only edits", async () => {
    const trimmed = { verified: true, updated: true, before: clip(), after: clip({ startSeconds: 2, inSeconds: 2 }) };
    const clips = [trimmed.after];
    const { observed, tools, request } = setup((command, args) => command === "trackItem.inspect" ? (clips[args.clipIndex] ?? (() => { throw new Error("end"); })()) : args.operationId ? (clips[0] = clip(), { verified: true }) : trimmed);
    await observed.request("trackItem.update", {});
    request.mockClear();
    await tools.undo_last_edit_uxp.handler({});
    const args = request.mock.calls.find(([command]) => command === "trackItem.update")![1] as any;
    expect(args.startSeconds).toBe(0);
    expect("inSeconds" in args).toBe(false);

    const named = setup({ "trackItem.update": { verified: true, before: clip({ name: "Old" }), after: clip({ name: "New" }) } });
    await named.observed.request("trackItem.update", {});
    expect(await named.list()).toMatchObject([{ invertible: true }]);
  });

  it("refuses, writing nothing, when the clip changed, the sequence differs or the project changed", async () => {
    const changed = setup((command) => command === "trackItem.inspect" ? clip({ startSeconds: 5, endSeconds: 15 }) : moved);
    await changed.observed.request("trackItem.update", {});
    expect(await changed.tools.undo_last_edit_uxp.handler({})).toMatchObject({ success: false, noHostWrite: true, error: expect.stringContaining("changed since") });

    const other = setup({ "trackItem.update": moved });
    await other.observed.request("trackItem.update", {});
    other.ctx.identity.sequence = "seq-2";
    expect(await other.tools.undo_last_edit_uxp.handler({})).toMatchObject({ success: false, noHostWrite: true, error: expect.stringContaining("another sequence") });
    expect(other.writes()).toEqual(["trackItem.update"]);

    other.ctx.identity.project = "/other.prproj";
    expect(await other.tools.undo_last_edit_uxp.handler({})).toMatchObject({ success: false, noHostWrite: true, error: expect.stringContaining("Nothing to undo") });
    expect(await other.list()).toHaveLength(0);
  });

  it("refuses a non-invertible entry with the checkpoint hint, and can forget it", async () => {
    const { observed, tools } = setup({ "trackItem.update": moved, "timeline.overwrite": { verified: true } });
    await observed.request("trackItem.update", {});
    await observed.request("timeline.overwrite", {});
    const refused: any = await tools.undo_last_edit_uxp.handler({});
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("Clone the sequence first");
    expect(((await tools.undo_last_edit_uxp.handler({ forget_uninvertible: true })) as any).data.remaining).toBe(1);
  });

  it("razor: removes the right half with every guard, then stretches the left half back", async () => {
    let whole = false;
    const left = clip({ endSeconds: 4, outSeconds: 4 }), right = clip({ clipIndex: 1, startSeconds: 4, inSeconds: 4 });
    const { observed, tools, request } = setup((command, args) => {
      if (command === "trackItem.razor") return razorReceipt;
      if (command === "trackItems.remove") return { verified: true };
      if (command === "trackItem.update") { whole = true; return { verified: true }; }
      if (command === "trackItem.inspect") {
        if (whole) return args.clipIndex === 0 ? clip() : (() => { throw new Error("end"); })();
        return args.clipIndex === 0 ? left : right;
      }
    });
    await observed.request("trackItem.razor", razorArgs);
    request.mockClear();
    const result: any = await tools.undo_last_edit_uxp.handler({});
    const remove = request.mock.calls.find(([command]) => command === "trackItems.remove")![1] as any;
    expect(remove).toEqual({
      items: [{ mediaType: "video", trackIndex: 0, clipIndex: 1, expectedProjectItemId: "pi-1", expectedStartSeconds: 4 }],
      ripple: false, confirmRemove: true, operationId: expect.stringMatching(/^undo-1-\d+-1$/),
    });
    expect(remove.operationId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    const update = request.mock.calls.find(([command]) => command === "trackItem.update")![1] as any;
    expect(update).toMatchObject({ mediaType: "video", trackIndex: 0, clipIndex: 0, expectedStartSeconds: 0, expectedEndSeconds: 4, endSeconds: 10 });
    expect(result).toMatchObject({ success: true, data: { outcome: "verified", remaining: 0 } });
  });

  it("razor: refuses when the original end is between frames or the frame rate is unknown, writing nothing", async () => {
    for (const settings of [{ rightEndSeconds: 10.013 }, { rate: null }]) {
      const half = { ...razorReceipt.halves[0], rightEndSeconds: settings.rightEndSeconds ?? 10 };
      const { observed, tools, writes } = setup((command, args) => command === "trackItem.razor" ? { ...razorReceipt, halves: [half] }
        : command === "sequenceSettings.get" ? { settings: { videoFrameRate: settings.rate === null ? null : 25 } }
        : command === "trackItem.inspect" ? (args.clipIndex === 0 ? clip({ endSeconds: 4, outSeconds: 4 }) : clip({ clipIndex: 1, startSeconds: 4, endSeconds: half.rightEndSeconds, inSeconds: 4 })) : { verified: true });
      await observed.request("trackItem.razor", razorArgs);
      expect(await tools.undo_last_edit_uxp.handler({})).toMatchObject({ success: false, noHostWrite: true });
      expect(writes()).toEqual(["trackItem.razor"]);
    }
  });

  it("razor: refuses when the halves moved, writing nothing", async () => {
    const { observed, tools, writes } = setup((command, args) => command === "trackItem.razor" ? razorReceipt : command === "trackItem.inspect" ? clip({ clipIndex: args.clipIndex, startSeconds: 9, endSeconds: 12 }) : { verified: true });
    await observed.request("trackItem.razor", razorArgs);
    expect(await tools.undo_last_edit_uxp.handler({})).toMatchObject({ success: false, noHostWrite: true });
    expect(writes()).toEqual(["trackItem.razor"]);
  });

  it("a step that fails with an unknown outcome, or does not verify, replaces the entry with a blocker", async () => {
    const throwing = setup({ "trackItem.update": moved, "trackItem.inspect": moved.after });
    await throwing.observed.request("trackItem.update", {});
    throwing.request.mockImplementation(async (command: string) => {
      if (command === "trackItem.update") throw Object.assign(new Error("timed out"), { code: "UXP_TIMEOUT" });
      return command === "sequences.inspect" ? { activeSequenceId: "seq-1" } : command === "state.get" ? { project: { path: "/p.prproj" } } : moved.after;
    });
    const failed: any = await throwing.tools.undo_last_edit_uxp.handler({});
    expect(failed).toMatchObject({ success: false });
    expect(failed.noHostWrite).toBeUndefined();
    expect(await throwing.list()).toMatchObject([{ invertible: false, label: expect.stringContaining("Undo of") }]);

    const refused = setup({ "trackItem.update": moved, "trackItem.inspect": moved.after });
    await refused.observed.request("trackItem.update", {});
    refused.request.mockImplementation(async (command: string) => {
      if (command === "trackItem.update") throw Object.assign(new Error("bad args"), { noHostWrite: true });
      return command === "sequences.inspect" ? { activeSequenceId: "seq-1" } : command === "state.get" ? { project: { path: "/p.prproj" } } : moved.after;
    });
    expect(await refused.tools.undo_last_edit_uxp.handler({})).toMatchObject({ success: false, noHostWrite: true, error: expect.stringContaining("before changing anything") });
    expect(await refused.list()).toMatchObject([{ invertible: true }]);

    const unverified = setup((command) => command === "trackItem.inspect" ? moved.after : command === "trackItem.update" ? { ...moved, verified: true } : { verified: true });
    await unverified.observed.request("trackItem.update", {});
    unverified.request.mockImplementation(async (command: string) => command === "trackItem.update" ? { verified: false } : command === "sequences.inspect" ? { activeSequenceId: "seq-1" } : command === "state.get" ? { project: { path: "/p.prproj" } } : moved.after);
    expect(await unverified.tools.undo_last_edit_uxp.handler({})).toMatchObject({ success: false, partial: true });
    expect(await unverified.list()).toMatchObject([{ invertible: false }]);
  });

  it("serialises concurrent undo calls so one entry is undone once", async () => {
    let undone = false;
    const { observed, tools, writes } = setup((command, args) => command === "trackItem.inspect" ? (undone ? clip() : moved.after) : command === "trackItem.update" ? (args.operationId ? (undone = true, { verified: true }) : moved) : { verified: true });
    await observed.request("trackItem.update", {});
    const [first, second]: any[] = await Promise.all([tools.undo_last_edit_uxp.handler({}), tools.undo_last_edit_uxp.handler({})]);
    expect([first.success, second.success].sort()).toEqual([false, true]);
    expect(writes().filter((command) => command === "trackItem.update")).toHaveLength(2); // the edit, then one undo
  });

  it("marker add: removes by GUID with an operation id", async () => {
    const { observed, tools, request } = setup((command) => command === "markers.add" ? { verified: true, marker: { guid: "g1", name: "M" } } : { verified: true });
    await observed.request("markers.add", { ownerType: "sequence" });
    request.mockClear();
    const result: any = await tools.undo_last_edit_uxp.handler({});
    expect(request.mock.calls.find(([command]) => command === "markers.remove")![1]).toMatchObject({ ownerType: "sequence", markerGuid: "g1", expectedName: "M", operationId: expect.stringMatching(/^undo-1-/) });
    expect(result.success).toBe(true);
  });

  it("keeps a separate stack per bridge", async () => {
    const a = setup({ "trackItem.update": moved }), b = setup();
    await a.observed.request("trackItem.update", {});
    expect(await a.list()).toHaveLength(1);
    expect(await b.list()).toHaveLength(0);
  });
});
