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
  const makeClip = (startSeconds: number) => {
    const position = makeParam("Position", new PointF(0.5, 0.5)), scale = makeParam("Scale", 100);
    const component = { getMatchName: vi.fn(async () => "AE.ADBE Motion"), getDisplayName: vi.fn(async () => "Motion"), getParamCount: vi.fn(() => 2), getParam: vi.fn((index: number) => index === 0 ? position : scale) };
    const trackItem = { getComponentChain: vi.fn(async () => ({ getComponentCount: () => 1, getComponentAtIndex: () => component })), getStartTime: async () => ({ seconds: startSeconds }) };
    return { position, scale, trackItem };
  };
  const { position, scale, trackItem } = makeClip(0), items: unknown[] = [trackItem];
  const track = { getTrackItems: vi.fn(async () => [...items]) };
  const sequence = { guid: "sequence-1", getVideoTrackCount: vi.fn(async () => 1), getVideoTrack: vi.fn(async () => track), getAudioTrackCount: vi.fn(async () => 0), getAudioTrack: vi.fn() };
  const addAction = (action: { apply: () => void }) => { action.apply(); return true; };
  const project = { guid: "project-1", getActiveSequence: vi.fn(async () => sequence), lockedAccess: vi.fn((callback: () => void) => callback()), executeTransaction: vi.fn((callback: (compound: { addAction: typeof addAction }) => void) => { callback({ addAction }); return true; }) };
  const ppro = {
    Project: { getActiveProject: vi.fn(async () => project) }, PointF,
    TickTime: { createWithSeconds: (seconds: number) => ({ seconds }) },
    Constants: { TrackItemType: { CLIP: 1 }, InterpolationMode: { LINEAR: 1, HOLD: 2, BEZIER: 3, TIME: 4 } },
  };
  const registry = Commands.createCommandRegistry({ ppro, Protocol, storage: stored() });
  return { registry, project, position, scale, sequence, addAction, items, makeClip };
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
    // A point key turns animation on in its own commit first, so a failure after it is a half-done write.
    host.position.createAddKeyframeAction.mockImplementationOnce(() => { throw new Error("host refused the keyframe"); });
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 1, point: { x: 0.1, y: 0.5 }, operationId: "half-done" })).rejects.toThrow(/animation was already turned on/);
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
    // A scalar first key keeps its single baseline transaction (inspection A5), so no automatic key is removed.
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 1, timeSeconds: 2, value: 120, operationId: "scale" })).resolves.toMatchObject({ outcome: "verified", automaticKeyframeCleanup: "none", after: { value: 120, keyframeTimesSeconds: [0, 2] } });
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 2, value: 1, point: { x: 0, y: 0 }, operationId: "both" })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT", noHostWrite: true });
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 2, point: { x: 0 }, operationId: "half-point" })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT", noHostWrite: true });
  });
  it("reports a point that reads back different as committed_unverified", async () => {
    const host = parameterHost();
    host.position.getValueAtTime.mockImplementation(async () => ({ x: 0.9, y: 0.9 }));
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 1, point: { x: 0.1, y: 0.5 }, operationId: "drift" })).resolves.toMatchObject({ outcome: "committed_unverified", verified: false });
  });
});

describe("output paths that do not exist yet", () => {
  const Workspace = require("../../uxp-plugin/workspace.cjs");
  // Approved folder /Work with Renders/ (real) and Escape/ (a link that resolves outside). Nothing else exists.
  function walkingBroker() {
    const folder = (nativePath: string, children: Record<string, unknown> = {}) => ({ isFolder: true, nativePath, getEntry: vi.fn(async (name: string) => { if (!(name in children)) throw new Error("missing"); return children[name]; }), getEntries: vi.fn(async () => Object.keys(children).map((name) => ({ name }))) });
    const root = folder("/Work", { Renders: folder("/Work/Renders"), Escape: folder("/Elsewhere") });
    const fs = { getFolder: vi.fn(async () => root), createPersistentToken: vi.fn(async () => "token"), getDataFolder: vi.fn(async () => ({ createFile: vi.fn(async () => ({ write: vi.fn() })) })) };
    const broker = Workspace.createWorkspaceBroker({ fs });
    return broker;
  }
  it("accepts a new file in an approved folder only when the caller says it may be created", async () => {
    const broker = walkingBroker(); await broker.requestRoot();
    await expect(broker.assertPathAllowed("/Work/Renders/preview.mp4", { label: "outputFile", kind: "file" })).rejects.toMatchObject({ code: "UXP_CANONICAL_PATH_UNAVAILABLE" });
    await expect(broker.assertPathAllowed("/Work/Renders/preview.mp4", { label: "outputFile", kind: "file", mayCreate: true })).resolves.toBe("/Work/Renders/preview.mp4");
    await expect(broker.assertPathAllowed("/Work/new.prproj", { label: "path", kind: "file", mayCreate: true })).resolves.toBe("/Work/new.prproj");
  });
  it("still refuses a new file whose folder resolves outside or does not exist", async () => {
    const broker = walkingBroker(); await broker.requestRoot();
    await expect(broker.assertPathAllowed("/Work/Escape/out.mp4", { label: "outputFile", kind: "file", mayCreate: true })).rejects.toMatchObject({ code: "UXP_PATH_OUTSIDE_WORKSPACE" });
    await expect(broker.assertPathAllowed("/Work/Missing/out.mp4", { label: "outputFile", kind: "file", mayCreate: true })).rejects.toMatchObject({ code: "UXP_CANONICAL_PATH_UNAVAILABLE" });
    await expect(broker.assertPathAllowed("/Other/out.mp4", { label: "outputFile", kind: "file", mayCreate: true })).rejects.toMatchObject({ code: "UXP_PATH_OUTSIDE_WORKSPACE" });
  });
  it("project create asks for a may-create check (encode, AAF and interchange outputs do too)", async () => {
    const assertPathAllowed = vi.fn(async (path: string) => path);
    const project = { guid: "p", path: "/Work/new.prproj", name: "new" };
    const ppro = { Project: { getActiveProject: vi.fn(async () => null), getProject: vi.fn(), createProject: vi.fn(async () => project), isProject: vi.fn(() => false), open: vi.fn() }, ProjectUtils: { getProjectViewIds: vi.fn(async () => []), getProjectFromViewId: vi.fn() } };
    const registry = Commands.createCommandRegistry({ ppro, Protocol, storage: stored(), workspace: { assertPathAllowed, status: () => ({ configured: true, canonicalPathValidation: "available" }), fileExists: async () => false } });
    await registry.dispatch("project.sessions.create", { path: "/Work/new.prproj", confirmExternalWrite: true, operationId: "create-1" }).catch(() => undefined);
    expect(assertPathAllowed).toHaveBeenCalledWith("/Work/new.prproj", expect.objectContaining({ kind: "file", mayCreate: true }));
  });
});

describe("source in/out on audio-only clips", () => {
  const NextWorkflows = require("../../uxp-plugin/next-workflows.cjs");
  // An audio-only clip: its video in/out reads as Premiere's unset value; setting in/out moves the audio points.
  function audioOnly() {
    const points = { in: -400000, out: -400000 };
    const clip = {
      name: "Music", getId: vi.fn(() => "music-1"),
      getInPoint: vi.fn(async (type: number) => ({ seconds: type === 2 ? points.in : -400000 })),
      getOutPoint: vi.fn(async (type: number) => ({ seconds: type === 2 ? points.out : -400000 })),
      createSetInOutPointsAction: vi.fn((inPoint: { seconds: number }, outPoint: { seconds: number }) => ({ apply: () => { points.in = inPoint.seconds; points.out = outPoint.seconds; } })),
      createSetInPointAction: vi.fn(), createSetOutPointAction: vi.fn(), createClearInOutPointsAction: vi.fn(), createSetScaleToFrameSizeAction: vi.fn(),
    };
    const project = {
      getRootItem: vi.fn(async () => ({ getItems: vi.fn(async () => [clip]) })),
      lockedAccess: vi.fn((callback: () => void) => callback()),
      executeTransaction: vi.fn((callback: (compound: { addAction: (action: { apply: () => void }) => boolean }) => void) => { callback({ addAction: (action) => { action.apply(); return true; } }); return true; }),
    };
    const definitions = NextWorkflows.createNextWorkflowDefinitions({ ppro: {
      Project: { getActiveProject: vi.fn(async () => project) }, ClipProjectItem: { cast: vi.fn((item: unknown) => item) }, ProjectItem: { cast: vi.fn((item: unknown) => item) },
      FolderItem: { cast: vi.fn(() => null) }, TickTime: { createWithSeconds: vi.fn((seconds: number) => ({ seconds })) }, Constants: { MediaType: { VIDEO: 1, AUDIO: 2 } },
    } });
    return { definitions, points };
  }
  it("reports unset points as null and verifies an audio-only trim when media type is left out", async () => {
    const { definitions } = audioOnly();
    await expect(definitions["source.clip.inspect"].handler({ items: [{ projectItemId: "music-1" }] })).resolves.toMatchObject({ items: [{ mediaType: "video", inSeconds: null, outSeconds: null }] });
    await expect(definitions["source.clip.update"].handler({ items: [{ projectItemId: "music-1", inSeconds: 12, outSeconds: 40 }] })).resolves.toMatchObject({ outcome: "verified", items: [{ mediaType: "audio", trimVerified: true, after: { inSeconds: 12, outSeconds: 40 } }] });
    // Unset video with set audio marks is ambiguous to a later read (inspection A7): it names the media type.
    await expect(definitions["source.clip.inspect"].handler({ items: [{ projectItemId: "music-1" }] })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT", noHostWrite: true });
    await expect(definitions["source.clip.inspect"].handler({ items: [{ projectItemId: "music-1", mediaType: "audio" }] })).resolves.toMatchObject({ items: [{ mediaType: "audio", inSeconds: 12, outSeconds: 40 }] });
  });
  it("still reads exactly the media type a caller names", async () => {
    const { definitions } = audioOnly();
    await expect(definitions["source.clip.inspect"].handler({ items: [{ projectItemId: "music-1", mediaType: "video" }] })).resolves.toMatchObject({ items: [{ mediaType: "video", inSeconds: null }] });
  });
});

describe("track item update", () => {
  it("refuses timeline edges and source in/out in one update before any write, and leaves no fence", async () => {
    const host = parameterHost();
    await expect(host.registry.dispatch("trackItem.update", { mediaType: "video", trackIndex: 0, clipIndex: 0, startSeconds: 0, endSeconds: 3.4, inSeconds: 71.5, outSeconds: 74.9, operationId: "full-trim" })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT", noHostWrite: true, message: expect.stringContaining("two separate updates") });
    await expect(host.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: false });
    expect(host.project.executeTransaction).not.toHaveBeenCalled();
  });
});

// Inspection (Sol, 18 Nov 2026) section A: each test failed before its fix.
describe("inspection A1: a failed ledger write never clears the running panel's fence", () => {
  function flaky() {
    const storage = stored(); let failing = false;
    const setItem = storage.setItem;
    storage.setItem = (key: string, value: string) => { if (failing) throw new Error("QuotaExceededError"); return setItem(key, value); };
    return { storage, fail: (value: boolean) => { failing = value; } };
  }
  it("keeps the operation unknown in memory when the acknowledgement cannot be stored", () => {
    const { storage, fail } = flaky();
    const ledger = Ledger.createOperationLedger({ storage, sessionId: "session-1", digest });
    ledger.reserve("op-1", digest("a"), identity); ledger.unknown("op-1");
    const view = ledger.inspect(identity);
    fail(true);
    expect(() => ledger.acknowledge(identity, { reviewed: true, expectedRecoveryRevision: view.recoveryRevision, expectedIdentityRevision: view.identityRevision, operationIds: ["op-1"] })).toThrow(/Cannot preserve/);
    expect(ledger.inspect(identity)).toMatchObject({ recoveryRequired: true, operations: [expect.objectContaining({ id: "op-1", outcome: "unknown" })] });
    expect(Ledger.createOperationLedger({ storage, digest }).inspect(identity)).toMatchObject({ recoveryRequired: true });
  });
  it("keeps a finish that cannot be stored unresolved, as a restarted panel sees it", () => {
    const { storage, fail } = flaky();
    const ledger = Ledger.createOperationLedger({ storage, sessionId: "session-1", digest });
    ledger.reserve("op-2", digest("b"), identity);
    fail(true);
    expect(() => ledger.finish("op-2", "verified")).toThrow(/Cannot preserve/);
    expect(ledger.inspect(identity).recoveryRequired).toBe(true);
    expect(Ledger.createOperationLedger({ storage, digest }).inspect(identity)).toMatchObject({ recoveryRequired: true, operations: [expect.objectContaining({ id: "op-2", outcome: "unknown" })] });
  });
});

describe("inspection A2: a panel-generated anonymous key cannot be sent back as an operation ID", () => {
  it("runs the handler once even when a caller replays the anonymous key it saw in recovery", async () => {
    const storage = stored();
    let release: () => void = () => {}, calls = 0;
    const panel = host(storage, async () => { if (++calls === 1) await new Promise<void>((resolve) => { release = resolve; }); return { outcome: "verified" }; });
    const first = panel.registry.dispatch("test.mutate", { value: 1 });
    await vi.waitFor(() => expect(panel.mutation).toHaveBeenCalledTimes(1));
    const seen = (await panel.registry.dispatch("operations.recovery.inspect", {})).operations[0].id as string;
    expect(seen).toMatch(/^anonymous:/);
    release(); await first;
    await expect(panel.registry.dispatch("test.mutate", { value: 1, operationId: seen })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    expect(panel.mutation).toHaveBeenCalledTimes(1);
  });
});

describe("inspection A4/A5: first keyframe safety", () => {
  it("writes only the original clip when the active sequence changes between the commits, and reports it unverified", async () => {
    const host = parameterHost(), other = parameterHost();
    other.sequence.guid = "sequence-2";
    other.position.state.varying = true; other.position.state.keys.set(0, { x: 0, y: 0 }); other.position.state.keys.set(2, { x: 1, y: 1 });
    host.project.executeTransaction.mockImplementationOnce((callback: (compound: { addAction: typeof host.addAction }) => void) => { callback({ addAction: host.addAction }); host.project.getActiveSequence.mockResolvedValue(other.sequence); return true; });
    const result = await host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 1, point: { x: 0.1, y: 0.5 }, operationId: "switched" });
    expect([...other.position.state.keys.keys()]).toEqual([0, 2]);
    expect(other.position.createRemoveKeyframeAction).not.toHaveBeenCalled();
    expect([...host.position.state.keys.keys()]).toEqual([1]);
    expect(result).toMatchObject({ outcome: "committed_unverified", targetLocated: false, automaticKeyframeCleanup: "done", removedAutomaticKeyframeTimesSeconds: [0] });
  });
  it("keeps a key the editor added between the two commits and reports the cleanup as skipped", async () => {
    const host = parameterHost();
    // The editor adds a key at 3 just before the second lock is taken.
    host.project.lockedAccess.mockImplementationOnce((callback: () => void) => callback()).mockImplementationOnce((callback: () => void) => { host.position.state.keys.set(3, { x: 0.9, y: 0.9 }); return callback(); });
    const result = await host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, timeSeconds: 1, point: { x: 0.1, y: 0.5 }, operationId: "editor-key" });
    expect(result).toMatchObject({ outcome: "committed_unverified", automaticKeyframeCleanup: "skipped", removedAutomaticKeyframeTimesSeconds: [] });
    expect([...host.position.state.keys.keys()].sort()).toEqual([0, 1, 3]);
  });
  it("never touches another clip that takes the index between the two commits (round 2, new finding 1)", async () => {
    const host = parameterHost(), b = host.makeClip(10);
    host.items.push(b.trackItem);
    // Clip B, same Motion effect and Position name, already animated with a user key at 0.
    b.position.state.varying = true; b.position.state.keys.set(0, { x: 0.7, y: 0.7 });
    // The editor removes clip A right after the stopwatch commit, so B becomes clip 0.
    host.project.executeTransaction.mockImplementationOnce((callback: (compound: { addAction: typeof host.addAction }) => void) => { callback({ addAction: host.addAction }); host.items.shift(); return true; });
    const result = await host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 0, expectedParamName: "Position", timeSeconds: 1, point: { x: 0.1, y: 0.5 }, operationId: "replaced" });
    expect([...b.position.state.keys.entries()]).toEqual([[0, { x: 0.7, y: 0.7 }]]);
    expect(b.position.createRemoveKeyframeAction).not.toHaveBeenCalled();
    expect(b.position.createAddKeyframeAction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "committed_unverified", verified: false });
  });
  it("adds a first scalar key in one undoable transaction, as before", async () => {
    const host = parameterHost();
    await expect(host.registry.dispatch("parameters.keyframeAdd", { ...motion, paramIndex: 1, timeSeconds: 2, value: 120, operationId: "scale-1" })).resolves.toMatchObject({ outcome: "verified" });
    expect(host.project.executeTransaction).toHaveBeenCalledTimes(1);
    expect(host.scale.state.varying).toBe(true);
  });
});

describe("inspection A6: a new output file needs proof that its name is free", () => {
  const Workspace = require("../../uxp-plugin/workspace.cjs");
  // /Work/Renders holds a dangling link "old.mp4": listed in the folder, but looking it up fails like a missing file.
  function broker(options: { listing?: boolean } = {}) {
    const renders = { isFolder: true, nativePath: "/Work/Renders", getEntry: vi.fn(async () => { throw new Error("missing"); }), ...(options.listing === false ? {} : { getEntries: vi.fn(async () => [{ name: "old.mp4" }]) }) };
    const root = { isFolder: true, nativePath: "/Work", getEntry: vi.fn(async (name: string) => { if (name !== "Renders") throw new Error("missing"); return renders; }), getEntries: vi.fn(async () => [renders]) };
    return Workspace.createWorkspaceBroker({ fs: { getFolder: vi.fn(async () => root), createPersistentToken: vi.fn(async () => "token"), getDataFolder: vi.fn(async () => ({ createFile: vi.fn(async () => ({ write: vi.fn() })) })) } });
  }
  it("refuses a name that is listed but cannot be resolved (a dangling link), in any letter case", async () => {
    const value = broker(); await value.requestRoot();
    await expect(value.assertPathAllowed("/Work/Renders/old.mp4", { label: "outputFile", kind: "file", mayCreate: true })).rejects.toMatchObject({ code: "UXP_CANONICAL_PATH_UNAVAILABLE" });
    await expect(value.assertPathAllowed("/Work/Renders/OLD.mp4", { label: "outputFile", kind: "file", mayCreate: true })).rejects.toMatchObject({ code: "UXP_CANONICAL_PATH_UNAVAILABLE" });
    await expect(value.assertPathAllowed("/Work/Renders/new.mp4", { label: "outputFile", kind: "file", mayCreate: true })).resolves.toBe("/Work/Renders/new.mp4");
  });
  it("refuses when the folder cannot be listed, because absence is not proven", async () => {
    const value = broker({ listing: false }); await value.requestRoot();
    await expect(value.assertPathAllowed("/Work/Renders/new.mp4", { label: "outputFile", kind: "file", mayCreate: true })).rejects.toMatchObject({ code: "UXP_CANONICAL_PATH_UNAVAILABLE" });
  });
});

describe("inspection A7: unset source marks round-trip as a stale guard", () => {
  const NextWorkflows = require("../../uxp-plugin/next-workflows.cjs");
  // An AV clip whose video marks are unset and whose audio marks are set.
  function clipHost(points: { videoIn: number; videoOut: number; audioIn: number; audioOut: number }) {
    const clip = {
      name: "Interview", getId: vi.fn(() => "av-1"),
      getInPoint: vi.fn(async (type: number) => ({ seconds: type === 2 ? points.audioIn : points.videoIn })),
      getOutPoint: vi.fn(async (type: number) => ({ seconds: type === 2 ? points.audioOut : points.videoOut })),
      createSetInOutPointsAction: vi.fn((inPoint: { seconds: number }, outPoint: { seconds: number }) => ({ apply: () => { points.videoIn = inPoint.seconds; points.videoOut = outPoint.seconds; } })),
      createSetInPointAction: vi.fn(), createSetOutPointAction: vi.fn(), createClearInOutPointsAction: vi.fn(), createSetScaleToFrameSizeAction: vi.fn(),
    };
    const project = {
      getRootItem: vi.fn(async () => ({ getItems: vi.fn(async () => [clip]) })),
      lockedAccess: vi.fn((callback: () => void) => callback()),
      executeTransaction: vi.fn((callback: (compound: { addAction: (action: { apply: () => void }) => boolean }) => void) => { callback({ addAction: (action) => { action.apply(); return true; } }); return true; }),
    };
    return NextWorkflows.createNextWorkflowDefinitions({ ppro: {
      Project: { getActiveProject: vi.fn(async () => project) }, ClipProjectItem: { cast: vi.fn((item: unknown) => item) }, ProjectItem: { cast: vi.fn((item: unknown) => item) },
      FolderItem: { cast: vi.fn(() => null) }, TickTime: { createWithSeconds: vi.fn((seconds: number) => ({ seconds })) }, Constants: { MediaType: { VIDEO: 1, AUDIO: 2 } },
    } });
  }
  it("asks for a media type when unset video marks and set audio marks leave it ambiguous", async () => {
    const definitions = clipHost({ videoIn: -400000, videoOut: -400000, audioIn: 5, audioOut: 9 });
    await expect(definitions["source.clip.inspect"].handler({ items: [{ projectItemId: "av-1" }] })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT", message: expect.stringContaining("mediaType") });
    await expect(definitions["source.clip.update"].handler({ items: [{ projectItemId: "av-1", inSeconds: 1, outSeconds: 2 }] })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    await expect(definitions["source.clip.inspect"].handler({ items: [{ projectItemId: "av-1", mediaType: "audio" }] })).resolves.toMatchObject({ items: [{ mediaType: "audio", inSeconds: 5, outSeconds: 9 }] });
  });
  it("treats an explicit null expectation as 'still unset' and refuses once a mark was set", async () => {
    const points = { videoIn: -400000, videoOut: -400000, audioIn: -400000, audioOut: -400000 };
    const definitions = clipHost(points);
    points.videoIn = 3; // someone set a mark after the inspection
    await expect(definitions["source.clip.update"].handler({ items: [{ projectItemId: "av-1", mediaType: "video", expectedInSeconds: null, expectedOutSeconds: null, inSeconds: 1, outSeconds: 2 }] })).rejects.toMatchObject({ code: "UXP_STALE_TARGET" });
    points.videoIn = -400000;
    await expect(definitions["source.clip.update"].handler({ items: [{ projectItemId: "av-1", mediaType: "video", expectedInSeconds: null, expectedOutSeconds: null, inSeconds: 1, outSeconds: 2 }] })).resolves.toMatchObject({ outcome: "verified" });
  });
});

describe("inspection A8: OTIO, FCPXML and AAF never overwrite an existing file", () => {
  it("refuses an existing interchange destination before calling the converter, and leaves no fence", async () => {
    const exporter = vi.fn(async () => true);
    const sequence = { guid: "sequence-1" }, project = { guid: "project-1", getActiveSequence: async () => sequence };
    const registry = Commands.createCommandRegistry({ ppro: { Project: { getActiveProject: async () => project }, ProjectConverter: { exportAsOpenTimelineIO: exporter, exportAsFinalCutProXML: exporter } }, Protocol, storage: stored(), fileExists: async (path: string) => path.endsWith("taken.otio"), workspace: { status: () => ({ configured: true, canonicalPathValidation: "available" }), assertPathAllowed: async (path: string) => path } });
    await expect(registry.dispatch("interchange.export", { format: "otio", outputFilePath: "/Work/taken.otio", operationId: "x1" })).rejects.toMatchObject({ code: "UXP_DESTINATION_EXISTS", noHostWrite: true });
    expect(exporter).not.toHaveBeenCalled();
    await expect(registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: false });
    await expect(registry.dispatch("interchange.export", { format: "otio", outputFilePath: "/Work/fresh.otio", operationId: "x2" })).resolves.toMatchObject({ exported: true });
  });
});
