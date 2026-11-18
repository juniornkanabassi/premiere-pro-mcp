// Lane E (native route repairs): ledger retirement, pre-write refusals, point keyframes and the small RESULTS.md bugs.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const Ledger = require("../../uxp-plugin/operation-ledger.cjs");
const Commands = require("../../uxp-plugin/commands.cjs");
const Protocol = require("../../uxp-plugin/protocol.cjs");
const digest = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const identity = { projectGuid: "project-1", sequenceGuid: "sequence-1" };
function stored() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) };
}
function host(storage: ReturnType<typeof stored>, handler?: (args: Record<string, unknown>) => Promise<unknown>) {
  const sequence = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0, getVideoTrack: vi.fn(), getAudioTrack: vi.fn() };
  const project = { guid: "project-1", getActiveSequence: async () => sequence };
  const mutation = vi.fn(handler || (async (args: { value?: number }) => ({ value: args.value, outcome: "verified" })));
  const registry = Commands.createCommandRegistry({ ppro: { Project: { getActiveProject: async () => project } }, Protocol, storage, sessionId: "session-1", Workflows: { createWorkflowDefinitions: () => ({ "test.mutate": { handler: mutation } }) } });
  return { registry, mutation };
}
const storedRecords = (storage: ReturnType<typeof stored>) => JSON.parse(storage.values.get(Ledger.STORAGE_KEY)!).records as { id: string; outcome: string }[];

describe("operation ledger retires finished records instead of filling up", () => {
  it("passes 4,096 edits with a restart in the middle, and refuses a retired ID even after restart", async () => {
    const storage = stored();
    let panel = host(storage);
    const total = Ledger.MAX_OPERATIONS + 600;
    for (let index = 0; index < total; index++) {
      if (index === 3000) panel = host(storage); // simulated panel reload
      await expect(panel.registry.dispatch("test.mutate", { operationId: "edit-" + index, value: index })).resolves.toMatchObject({ outcome: "verified" });
    }
    expect(storedRecords(storage).length).toBeLessThanOrEqual(Ledger.MAX_OPERATIONS);
    await expect(panel.registry.dispatch("test.mutate", { operationId: "edit-0", value: 0 })).rejects.toMatchObject({ code: "UXP_OPERATION_EXPIRED" });
    const restarted = host(storage);
    await expect(restarted.registry.dispatch("test.mutate", { operationId: "edit-1", value: 1 })).rejects.toMatchObject({ code: "UXP_OPERATION_EXPIRED" });
    await expect(restarted.registry.dispatch("test.mutate", { operationId: "edit-1", value: 999 })).rejects.toMatchObject({ code: "UXP_OPERATION_EXPIRED" });
    expect(restarted.mutation).not.toHaveBeenCalled();
    // Recent IDs are still held with their outcome.
    await expect(restarted.registry.dispatch("test.mutate", { operationId: "edit-" + (total - 1), value: total - 1 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONSUMED" });
    await expect(restarted.registry.dispatch("test.mutate", { operationId: "fresh", value: 1 })).resolves.toMatchObject({ outcome: "verified" });
  }, 60000);
  it("keeps panel-generated anonymous keys out of the store once finished", async () => {
    const storage = stored(), panel = host(storage);
    for (let index = 0; index < 50; index++) await panel.registry.dispatch("test.mutate", { value: index });
    expect(storedRecords(storage)).toHaveLength(0);
  });
  it("never retires an unresolved record and still refuses when only unresolved records remain", () => {
    const value = Ledger.createOperationLedger({ sessionId: "session-1", digest });
    const other = { projectGuid: "project-2", sequenceGuid: "s" };
    value.reserve("uncertain", digest("u"), identity); value.unknown("uncertain");
    for (let index = 0; index < Ledger.MAX_OPERATIONS + 10; index++) { value.reserve("id-" + index, digest(String(index)), other); value.finish("id-" + index, "verified"); }
    expect(value.get("uncertain", digest("u"))).toMatchObject({ outcome: "unknown" });
    expect(value.inspect(identity).operations.map((item: { id: string }) => item.id)).toEqual(["uncertain"]);
    const stuck = Ledger.createOperationLedger({ sessionId: "session-1", digest });
    for (let index = 0; index < Ledger.MAX_OPERATIONS; index++) stuck.reserve("p-" + index, digest(String(index)), other);
    expect(() => stuck.reserve("one-more", digest("x"), other)).toThrow(/unresolved operations/);
    expect(stuck.get("p-0", digest("0"))).toMatchObject({ outcome: "pending" });
  });
  it("migrates a full version 1 store without making its IDs reusable", () => {
    const storage = stored();
    const records = Array.from({ length: Ledger.MAX_OPERATIONS }, (_, index) => ({ id: "old-" + index, binding: digest("b" + index), scope: digest("s"), outcome: "verified" }));
    storage.setItem(Ledger.STORAGE_KEY, JSON.stringify({ version: 1, sessionId: "panel-old", records }));
    const value = Ledger.createOperationLedger({ storage, digest });
    expect(value.sessionId).toBe("panel-old");
    value.reserve("new-1", digest("n"), identity);
    const raw = JSON.parse(storage.values.get(Ledger.STORAGE_KEY)!);
    expect(raw).toMatchObject({ version: 2, sessionId: "panel-old" });
    expect(raw.retiredCount).toBeGreaterThan(0);
    expect(() => value.get("old-0", digest("b0"))).toThrow(/retired/);
    expect(() => Ledger.createOperationLedger({ storage, digest }).reserve("old-0", digest("b0"), identity)).toThrow(/retired/);
    expect(value.get("old-" + (Ledger.MAX_OPERATIONS - 1), digest("b" + (Ledger.MAX_OPERATIONS - 1)))).toMatchObject({ outcome: "verified" });
  });
  it("retires by size when long IDs reach the storage limit first", () => {
    const storage = stored(), value = Ledger.createOperationLedger({ storage, sessionId: "session-1", digest });
    // About 660 characters a record: the 1 MB limit is reached near 1,400 records, long before 4,096.
    for (let index = 0; index < 1700; index++) { const id = "x".repeat(500) + "-" + index; value.reserve(id, digest(id), identity); value.finish(id, "verified"); }
    expect(storage.values.get(Ledger.STORAGE_KEY)!.length).toBeLessThanOrEqual(1024 * 1024);
    expect(() => value.get("x".repeat(500) + "-0", digest("x"))).toThrow(/retired/);
  }, 60000);
  it("refuses a tampered retired filter as corrupt", () => {
    const storage = stored(), value = Ledger.createOperationLedger({ storage, sessionId: "session-1", digest });
    value.reserve("a", digest("a"), identity);
    const raw = JSON.parse(storage.values.get(Ledger.STORAGE_KEY)!);
    storage.setItem(Ledger.STORAGE_KEY, JSON.stringify({ ...raw, retired: "00" }));
    expect(Ledger.createOperationLedger({ storage, digest }).inspect(identity)).toMatchObject({ ledgerCorrupt: true });
  });
});

// A Motion-like effect with one point param (Position) and one scalar param (Scale). Turning the stopwatch on
// makes a keyframe of its own at media time 0 holding the static value, as Premiere does.
function parameterHost(options: { keyframesSupported?: boolean } = {}) {
  class PointF { constructor(readonly x: number, readonly y: number) {} }
  const makeParam = (displayName: string, initial: unknown) => {
    const state = { value: initial, varying: false, keys: new Map<number, unknown>() };
    const at = (seconds: number) => {
      const times = [...state.keys.keys()].sort((a, b) => a - b);
      if (!state.varying || !times.length) return state.value;
      const previous = times.filter((time) => time <= seconds).at(-1) ?? times[0];
      return state.keys.get(previous);
    };
    const param = {
      displayName, state,
      areKeyframesSupported: vi.fn(async () => options.keyframesSupported !== false),
      isTimeVarying: vi.fn(() => state.varying),
      getKeyframeListAsTickTimes: vi.fn(() => [...state.keys.keys()].sort((a, b) => a - b).map((seconds) => ({ seconds }))),
      getStartValue: vi.fn(async () => ({ value: { value: at(0) } })),
      getValueAtTime: vi.fn(async (time: { seconds: number }) => at(time.seconds)),
      createKeyframe: vi.fn((value: unknown) => ({ value: { value }, position: null as { seconds: number } | null })),
      createSetValueAction: vi.fn((keyframe: { value: { value: unknown } }) => ({ apply: () => { state.value = keyframe.value.value; } })),
      createSetTimeVaryingAction: vi.fn((varying: boolean) => ({ apply: () => { state.varying = varying; if (varying && !state.keys.size) state.keys.set(0, state.value); if (!varying) state.keys.clear(); } })),
      createAddKeyframeAction: vi.fn((keyframe: { value: { value: unknown }; position: { seconds: number } }) => ({ apply: () => { state.keys.set(keyframe.position.seconds, keyframe.value.value); } })),
      createRemoveKeyframeAction: vi.fn((time: { seconds: number }) => ({ apply: () => { state.keys.delete(time.seconds); } })),
    };
    return param;
  };
  const position = makeParam("Position", new PointF(0.5, 0.5)), scale = makeParam("Scale", 100);
  const component = { getMatchName: vi.fn(async () => "AE.ADBE Motion"), getDisplayName: vi.fn(async () => "Motion"), getParamCount: vi.fn(() => 2), getParam: vi.fn((index: number) => index === 0 ? position : scale) };
  const trackItem = { getComponentChain: vi.fn(async () => ({ getComponentCount: () => 1, getComponentAtIndex: () => component })), getStartTime: async () => ({ seconds: 0 }) };
  const track = { getTrackItems: vi.fn(async () => [trackItem]) };
  const sequence = { guid: "sequence-1", getVideoTrackCount: vi.fn(async () => 1), getVideoTrack: vi.fn(async () => track), getAudioTrackCount: vi.fn(async () => 0), getAudioTrack: vi.fn() };
  const addAction = (action: { apply: () => void }) => { action.apply(); return true; };
  const project = { guid: "project-1", getActiveSequence: vi.fn(async () => sequence), lockedAccess: vi.fn((callback: () => void) => callback()), executeTransaction: vi.fn((callback: (compound: { addAction: typeof addAction }) => void) => { callback({ addAction }); return true; }) };
  const ppro = {
    Project: { getActiveProject: vi.fn(async () => project) }, PointF,
    TickTime: { createWithSeconds: (seconds: number) => ({ seconds }) },
    Constants: { TrackItemType: { CLIP: 1 }, InterpolationMode: { LINEAR: 1, HOLD: 2, BEZIER: 3, TIME: 4 } },
  };
  const registry = Commands.createCommandRegistry({ ppro, Protocol, storage: stored() });
  return { registry, project, position, scale };
}
const motion = { mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 0 };

describe("refusals made before any host write never block the next edit", () => {
  it("set_value on an animated parameter is refused without a fence, and the next edit runs", async () => {
    const host = parameterHost();
    host.scale.state.varying = true; host.scale.state.keys.set(0, 100);
    await expect(host.registry.dispatch("parameters.set", { ...motion, paramIndex: 1, value: 50, operationId: "refused-1" })).rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED", noHostWrite: true });
    await expect(host.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: false, operations: [] });
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 1, timeSeconds: 1, value: 50, operationId: "next-1" })).resolves.toMatchObject({ outcome: "verified" });
    expect(host.project.executeTransaction).toHaveBeenCalledTimes(1);
  });
  it("a stale parameter name and a non-keyframable parameter are refused without a fence", async () => {
    const host = parameterHost({ keyframesSupported: false });
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 1, expectedParamName: "Rotation", timeSeconds: 0, value: 1, operationId: "stale" })).rejects.toMatchObject({ code: "UXP_STALE_PARAMETER", noHostWrite: true });
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 1, timeSeconds: 0, value: 1, operationId: "unsupported" })).rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED", noHostWrite: true });
    await expect(host.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: false });
    expect(host.project.executeTransaction).not.toHaveBeenCalled();
  });
  it("a write that then fails still fences", async () => {
    const host = parameterHost();
    host.scale.createAddKeyframeAction.mockImplementationOnce(() => { throw new Error("host refused the keyframe"); });
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 1, timeSeconds: 1, value: 50, operationId: "half-done" })).rejects.toThrow(/animation was already turned on/);
    await expect(host.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: true, operations: [expect.objectContaining({ id: "half-done" })] });
  });
});

describe("add_keyframe takes a point", () => {
  it("adds point keyframes, reads both coordinates back and removes only the stopwatch's own keyframe", async () => {
    const host = parameterHost();
    const first = await host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, expectedParamName: "Position", timeSeconds: 1, point: { x: 0.1, y: 0.5 }, operationId: "slide-1" });
    expect(first).toMatchObject({ outcome: "verified", timeBase: "clip_media_time", point: { x: 0.1, y: 0.5 }, removedAutomaticKeyframeTimesSeconds: [0], after: { value: { x: 0.1, y: 0.5 }, keyframeTimesSeconds: [1] } });
    const second = await host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 1.5, point: { x: 0.5, y: 0.5 }, operationId: "slide-2" });
    expect(second).toMatchObject({ outcome: "verified", removedAutomaticKeyframeTimesSeconds: [], after: { keyframeTimesSeconds: [1, 1.5] } });
    const created = host.position.createKeyframe.mock.calls.map(([value]) => value);
    expect(created.every((value) => value instanceof Object && "x" in (value as object))).toBe(true);
    expect([...host.position.state.keys.entries()].map(([time, point]) => [time, (point as { x: number }).x])).toEqual([[1, 0.1], [1.5, 0.5]]);
  });
  it("keeps a requested keyframe at the stopwatch's own time and leaves earlier keys alone", async () => {
    const host = parameterHost();
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 0, point: { x: 0.2, y: 0.3 }, operationId: "at-zero" })).resolves.toMatchObject({ outcome: "verified", removedAutomaticKeyframeTimesSeconds: [], after: { keyframeTimesSeconds: [0] } });
  });
  it("keeps the scalar contract and refuses a point and a value together", async () => {
    const host = parameterHost();
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 1, timeSeconds: 2, value: 120, operationId: "scale" })).resolves.toMatchObject({ outcome: "verified", after: { value: 120, keyframeTimesSeconds: [2] } });
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 2, value: 1, point: { x: 0, y: 0 }, operationId: "both" })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT", noHostWrite: true });
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 2, point: { x: 0 }, operationId: "half-point" })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT", noHostWrite: true });
  });
  it("reports a point that reads back different as committed_unverified", async () => {
    const host = parameterHost();
    host.position.getValueAtTime.mockImplementation(async () => ({ x: 0.9, y: 0.9 }));
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 1, point: { x: 0.1, y: 0.5 }, operationId: "drift" })).resolves.toMatchObject({ outcome: "committed_unverified", verified: false });
  });
});
