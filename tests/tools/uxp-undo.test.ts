import { describe, expect, it, vi } from "vitest";
import { getUxpUndoTools, observeUxpEdits } from "../../src/tools/uxp-undo.js";
import type { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";

const snap = (over: Record<string, unknown> = {}) => ({ mediaType: "video", trackIndex: 0, clipIndex: 0, startSeconds: 0, endSeconds: 10, inSeconds: 0, outSeconds: 10, disabled: false, name: "A", ...over });

function setup(live: Record<string, unknown> | ((command: string, args: any) => unknown) = {}) {
  const request = vi.fn(async (command: string, args: any) => {
    if (typeof live === "function") return live(command, args);
    return live[command] ?? { verified: true, outcome: "verified" };
  });
  const bridge = { request } as unknown as UxpWebSocketBridge;
  const observed = observeUxpEdits(bridge);
  const tools = getUxpUndoTools(bridge);
  return { request, observed, tools, calls: () => request.mock.calls.map(([command]) => command) };
}
const moved = { verified: true, updated: true, before: snap(), after: snap({ startSeconds: 1, endSeconds: 11 }) };

describe("MCP-side undo stack", () => {
  it("records only verified invertible edits, and keeps overwrite as a blocker", async () => {
    const { observed, tools } = setup({ "trackItem.update": { ...moved, verified: false } });
    await observed.request("trackItem.update", { mediaType: "video" });
    await observed.request("trackItem.inspect", {});
    const empty: any = await tools.inspect_undo_stack_uxp.handler();
    expect(empty.data.count).toBe(0);
    const second = setup({ "timeline.overwrite": { verified: true } });
    await second.observed.request("timeline.overwrite", {});
    const listed: any = await second.tools.inspect_undo_stack_uxp.handler();
    expect(listed.data.entries[0]).toMatchObject({ command: "timeline.overwrite", invertible: false });
  });

  it("undoes a move with a fresh inspect and a relative move back", async () => {
    const { observed, tools, request } = setup({ "trackItem.update": moved, "trackItem.inspect": moved.after });
    await observed.request("trackItem.update", {});
    request.mockClear();
    const result: any = await tools.undo_last_edit_uxp.handler({});
    expect(request.mock.calls[0][0]).toBe("trackItem.inspect");
    expect(request.mock.calls[1][0]).toBe("trackItem.update");
    expect(request.mock.calls[1][1]).toMatchObject({ moveBySeconds: -1, expectedStartSeconds: 1, expectedEndSeconds: 11 });
    expect(result).toMatchObject({ success: true, data: { outcome: "verified", verified: true, remaining: 0 } });
  });

  it("refuses, writing nothing, when the clip no longer matches the receipt", async () => {
    const { observed, tools, calls } = setup({ "trackItem.update": moved, "trackItem.inspect": snap({ startSeconds: 5, endSeconds: 15 }) });
    await observed.request("trackItem.update", {});
    const result: any = await tools.undo_last_edit_uxp.handler({});
    expect(result).toMatchObject({ success: false, noHostWrite: true });
    expect(result.error).toContain("changed since");
    expect(calls().filter((command) => command === "trackItem.update")).toHaveLength(1); // the original edit only
  });

  it("refuses a non-invertible entry with the checkpoint hint, and can forget it", async () => {
    const { observed, tools } = setup({ "trackItem.update": moved, "timeline.overwrite": { verified: true } });
    await observed.request("trackItem.update", {});
    await observed.request("timeline.overwrite", {});
    const refused: any = await tools.undo_last_edit_uxp.handler({});
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("Clone the sequence first");
    const forgotten: any = await tools.undo_last_edit_uxp.handler({ forget_uninvertible: true });
    expect(forgotten.data.remaining).toBe(1);
  });

  it("razor: removes the right half then stretches the left half back (mock of Batch B commands)", async () => {
    const left = snap({ endSeconds: 4, outSeconds: 4 }), right = snap({ clipIndex: 1, startSeconds: 4, inSeconds: 4 });
    const { observed, tools, request } = setup((command, args) => command === "trackItem.inspect" ? (args.clipIndex === 0 ? left : right) : { verified: true });
    await observed.request("trackItem.razor", { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 4 });
    request.mockClear();
    const result: any = await tools.undo_last_edit_uxp.handler({});
    expect(request.mock.calls.map(([command]) => command)).toEqual(["trackItem.inspect", "trackItem.inspect", "trackItems.remove", "trackItem.update"]);
    expect(request.mock.calls[3][1]).toMatchObject({ clipIndex: 0, endSeconds: 10 });
    expect(result.success).toBe(true);
  });

  it("marker add: removes by GUID and reports committed_unverified when the panel cannot verify", async () => {
    const { observed, tools } = setup((command) => command === "markers.add" ? { verified: true, marker: { guid: "g1", name: "M" } } : { verified: false });
    await observed.request("markers.add", { ownerType: "sequence" });
    const result: any = await tools.undo_last_edit_uxp.handler({});
    expect(result.data).toMatchObject({ outcome: "committed_unverified", verified: false });
  });

  it("keeps a separate stack per bridge", async () => {
    const a = setup({ "trackItem.update": moved }), b = setup();
    await a.observed.request("trackItem.update", {});
    expect(((await a.tools.inspect_undo_stack_uxp.handler()) as any).data.count).toBe(1);
    expect(((await b.tools.inspect_undo_stack_uxp.handler()) as any).data.count).toBe(0);
  });
});
