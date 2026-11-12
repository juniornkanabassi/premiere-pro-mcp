import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const Commands = require("../../uxp-plugin/commands.cjs");
const Protocol = require("../../uxp-plugin/protocol.cjs");

const T = 254016000000n;
const FRAME = T / 25n;
const tk = (seconds: number) => String(BigInt(Math.round(seconds * 1000)) * T / 1000n);
const sec = (ticks: string) => Number(BigInt(ticks) * 1000n / T) / 1000;

type Kind = "video" | "audio";
type State = { pid: string; name: string; start: string; end: string; inPoint: string; outPoint: string; speed: number };
type HostOptions = {
  pauseFirstSnapshot?: boolean;
  /** A move that Premiere accepts but does not apply. */
  ignoreMoves?: boolean;
  /** A trim that Premiere accepts but does not apply. */
  ignoreSetStart?: boolean;
  missingAudioTrack?: boolean;
};

/**
 * A tick-exact timeline host. Actions and selections are only valid inside lockedAccess and a
 * selection dies when that callback returns, as measured live on Premiere 27.0.
 */
function timelineHost(video: State[][], audio: State[][] = [], options: HostOptions = {}) {
  let locked = false;
  let pausePending = options.pauseFirstSnapshot === true;
  let releasePause: () => void = () => undefined;
  let pauseStarted: () => void = () => undefined;
  const pauseGate = new Promise<void>((resolve) => { releasePause = resolve; });
  const firstSnapshot = new Promise<void>((resolve) => { pauseStarted = resolve; });
  const selections: Array<{ dead: boolean; items: Item[] }> = [];
  const lists: Record<Kind, Item[][]> = { video: [], audio: [] };

  function inLock() { if (!locked) throw new Error("A nullptr was dereferenced: action created outside lockedAccess"); }
  function shift(state: State, field: "start" | "end" | "inPoint" | "outPoint", ticks: bigint) { state[field] = String(BigInt(state[field]) + ticks); }

  function makeItem(state: State, kind: Kind, trackIndex: number) {
    const time = (value: string) => ({ ticks: value, seconds: Number(BigInt(value)) / Number(T) });
    const item = {
      state, kind, trackIndex,
      getProjectItem: vi.fn(async () => ({ getId: vi.fn(async () => state.pid) })),
      getName: vi.fn(async () => state.name),
      getStartTime: vi.fn(async () => time(state.start)),
      getEndTime: vi.fn(async () => time(state.end)),
      getInPoint: vi.fn(async () => {
        if (pausePending) { pausePending = false; pauseStarted(); await pauseGate; }
        return time(state.inPoint);
      }),
      getOutPoint: vi.fn(async () => time(state.outPoint)),
      getDuration: vi.fn(async () => time(String(BigInt(state.end) - BigInt(state.start)))),
      getSpeed: vi.fn(async () => state.speed),
      isSpeedReversed: vi.fn(async () => false),
      // Edge trims move the timeline edge and the matching source point together (live 26.0.2 / 27.0).
      createSetStartAction: vi.fn((to: { ticks: string }) => { inLock(); const d = BigInt(to.ticks) - BigInt(state.start); return { apply: () => { if (options.ignoreSetStart) return; shift(state, "start", d); shift(state, "inPoint", d); } }; }),
      createSetEndAction: vi.fn((to: { ticks: string }) => { inLock(); const d = BigInt(to.ticks) - BigInt(state.end); return { apply: () => { shift(state, "end", d); shift(state, "outPoint", d); } }; }),
      // A move is relative.
      createMoveAction: vi.fn((by: { ticks: string }) => { inLock(); return { apply: () => { if (options.ignoreMoves) return; shift(state, "start", BigInt(by.ticks)); shift(state, "end", BigInt(by.ticks)); } }; }),
    };
    return item;
  }
  type Item = ReturnType<typeof makeItem>;
  video.forEach((track, index) => lists.video.push(track.map((state) => makeItem(state, "video", index))));
  audio.forEach((track, index) => lists.audio.push(track.map((state) => makeItem(state, "audio", index))));
  const sorted = (list: Item[]) => [...list].sort((a, b) => Number(BigInt(a.state.start) - BigInt(b.state.start)));
  const sequence = {
    guid: "sequence-1",
    getTimebase: vi.fn(async () => String(FRAME)),
    getVideoTrackCount: vi.fn(async () => lists.video.length),
    getAudioTrackCount: vi.fn(async () => lists.audio.length),
    getVideoTrack: vi.fn(async (index: number) => lists.video[index] ? { getTrackItems: vi.fn(async () => sorted(lists.video[index]!)) } : null),
    getAudioTrack: vi.fn(async (index: number) => options.missingAudioTrack || !lists.audio[index] ? null : { getTrackItems: vi.fn(async () => sorted(lists.audio[index]!)) }),
  };
  const cloneAction = vi.fn((source: Item, offset: { ticks: string }, videoOffset: number, audioOffset: number, alignToVideo: boolean, isInsert: boolean) => {
    inLock();
    expect([videoOffset, audioOffset, alignToVideo, isInsert]).toEqual([0, 0, false, false]);
    return { apply: () => {
      const copy = makeItem({ ...source.state, start: String(BigInt(source.state.start) + BigInt(offset.ticks)), end: String(BigInt(source.state.end) + BigInt(offset.ticks)) }, source.kind, source.trackIndex);
      lists[source.kind][source.trackIndex]!.push(copy);
    } };
  });
  const removeAction = vi.fn((selection: { dead: boolean; items: Item[] }, ripple: boolean, mediaType: number, shiftOverlapping: boolean) => {
    inLock();
    expect([ripple, shiftOverlapping]).toEqual([false, false]);
    return { apply: () => {
      if (selection.dead) throw new Error("The script object is no longer valid");
      for (const item of selection.items) {
        const list = lists[item.kind][item.trackIndex]!;
        list.splice(list.indexOf(item), 1);
      }
    }, mediaType };
  });
  const addAction = vi.fn((action: { apply: () => void }) => { action.apply(); return true; });
  const project = {
    guid: "project-1",
    getActiveSequence: vi.fn(async () => sequence),
    lockedAccess: vi.fn((callback: () => void) => {
      locked = true;
      try { callback(); } finally { locked = false; for (const selection of selections) selection.dead = true; }
    }),
    executeTransaction: vi.fn((callback: (compound: { addAction: typeof addAction }) => void) => { callback({ addAction }); return true; }),
  };
  const ppro = {
    Project: { getActiveProject: vi.fn(async () => project) },
    TickTime: { createWithTicks: vi.fn((ticks: string) => ({ ticks, seconds: Number(BigInt(ticks)) / Number(T) })) },
    SequenceEditor: { getEditor: vi.fn(() => ({ createRemoveItemsAction: removeAction, createCloneTrackItemAction: cloneAction })) },
    TrackItemSelection: {
      createEmptySelection: vi.fn((callback: (selection: unknown) => void) => {
        inLock();
        const selection = { dead: false, items: [] as Item[], addItem: (item: Item) => { if (!locked) return false; selection.items.push(item); return true; } };
        selections.push(selection);
        callback(selection);
        return true;
      }),
    },
    Constants: { TrackItemType: { CLIP: 1 }, MediaType: { VIDEO: 1, AUDIO: 2, ANY: 3 } },
  };
  /** The track as [start, end, inPoint] seconds, in time order. */
  const track = (kind: Kind, index: number) => sorted(lists[kind][index]!).map((item) => [sec(item.state.start), sec(item.state.end), sec(item.state.inPoint)]);
  return {
    lists, project, removeAction, cloneAction, track, sequence,
    firstSnapshot, releaseFirstSnapshot: () => releasePause(),
    registry: Commands.createCommandRegistry({ ppro, Protocol }),
  };
}

const clip = (pid: string, start: number, end: number, inPoint: number, extra: Partial<State> = {}): State => ({
  pid, name: pid, start: tk(start), end: tk(end), inPoint: tk(inPoint), outPoint: tk(inPoint + end - start), speed: 1, ...extra,
});

// ---------------------------------------------------------------------------------------------
// trackItem.rippleDelete (guarded single clip)
// ---------------------------------------------------------------------------------------------

const target = { projectItemId: "target-1", startSeconds: 0, endSeconds: 10, inSeconds: 20, outSeconds: 30, durationSeconds: 10, speed: 1, reversed: false };
const following = { projectItemId: "following-1", startSeconds: 10, endSeconds: 20, inSeconds: 40, outSeconds: 50, durationSeconds: 10, speed: 1, reversed: false };
const expectedSnapshot = { projectGuid: "project-1", sequenceId: "sequence-1", mediaType: "video", trackIndex: 0, clipIndex: 0, trackItemCount: 2, target, following };
const targetCoordinates = { mediaType: "video", trackIndex: 0, clipIndex: 0 };
const rippleArgs = (operationId: string, extra: Record<string, unknown> = {}) => ({ ...targetCoordinates, expectedSnapshot, confirmRippleDelete: true, operationId, ...extra });
const rippleTrack = () => [clip("target-1", 0, 10, 20), clip("following-1", 10, 20, 40)];

describe("guarded documented UXP contiguous track-item ripple delete workflow", () => {
  it("advertises bounded inspection and idempotent undoable transaction commands, including the new range editors", async () => {
    const value = timelineHost([rippleTrack()]);
    await expect(value.registry.capabilities()).resolves.toMatchObject({ commands: {
      "trackItem.rippleDelete.inspect": { supported: true, readOnly: true, minHostVersion: "25.6.0" },
      "trackItem.rippleDelete": { supported: true, destructive: true, undoable: true, idempotent: true, targetCapabilityProbe: "invocation" },
      "trackItems.remove": { supported: true, destructive: true, undoable: true, idempotent: true },
      "trackItem.razor": { supported: true, destructive: true, undoable: true, idempotent: true },
      "timeline.range.extract": { supported: true, destructive: true, undoable: true, idempotent: true },
    } });
    await expect(value.registry.dispatch("trackItem.rippleDelete.inspect", targetCoordinates)).resolves.toEqual(expectedSnapshot);
    expect(value.project.executeTransaction).not.toHaveBeenCalled();
  });

  it("no longer refuses when another track has an item over the deleted range, and reports it instead", async () => {
    // Live 27.0 refused every real edit for this; the ripple is now driven here, so the overlap is only a warning.
    const value = timelineHost([rippleTrack()], [[clip("partner", 0, 10, 0)]]);
    await expect(value.registry.dispatch("trackItem.rippleDelete", rippleArgs("ripple-overlap"))).resolves.toMatchObject({
      rippleDeleted: true, outcome: "verified", otherTrackItemsOverRange: [{ mediaType: "audio", trackIndex: 0, clipIndex: 0 }],
    });
    expect(value.track("video", 0)).toEqual([[0, 10, 40]]);
    expect(value.track("audio", 0)).toEqual([[0, 10, 0]]);
  });

  it("removes without ripple, then moves the successor in a second transaction and verifies it", async () => {
    const value = timelineHost([rippleTrack()]);
    await expect(value.registry.dispatch("trackItem.rippleDelete", rippleArgs("ripple-apply-1"))).resolves.toMatchObject({
      operationId: "ripple-apply-1", rippleDeleted: true, outcome: "verified", before: expectedSnapshot, undoSteps: 2,
      after: { projectGuid: "project-1", sequenceId: "sequence-1", mediaType: "video", trackIndex: 0, successorClipIndex: 0, trackItemCount: 1, successor: { ...following, startSeconds: 0, endSeconds: 10 } },
      verificationBoundary: "planned_track_layout_and_successor_readback",
    });
    expect(value.project.executeTransaction).toHaveBeenCalledTimes(2);
    expect(value.project.executeTransaction.mock.calls.map((call) => call[1])).toEqual(["Ripple delete timeline item (remove)", "Ripple delete timeline item (close gap)"]);
    // Never Premiere's own ripple (the helper asserts ripple === false and shiftOverlapping === false).
    expect(value.removeAction).toHaveBeenCalledWith(expect.objectContaining({ items: expect.any(Array) }), false, 1, false);
    expect(value.track("video", 0)).toEqual([[0, 10, 40]]);
  });

  it("moves every later item by the exact amount, nearest first, leaving gaps between them alone", async () => {
    const value = timelineHost([[clip("target-1", 0, 10, 20), clip("following-1", 10, 20, 40), clip("c", 25, 30, 0), clip("d", 30, 31, 0)]]);
    const order: string[] = [];
    for (const item of value.lists.video[0]!) item.createMoveAction.mockImplementation(((by: { ticks: string }) => ({ apply: () => { order.push(item.state.pid); item.state.start = String(BigInt(item.state.start) + BigInt(by.ticks)); item.state.end = String(BigInt(item.state.end) + BigInt(by.ticks)); } })) as never);
    await expect(value.registry.dispatch("trackItem.rippleDelete", rippleArgs("ripple-many", { expectedSnapshot: { ...expectedSnapshot, trackItemCount: 4 } }))).resolves.toMatchObject({ outcome: "verified" });
    expect(order).toEqual(["following-1", "c", "d"]);
    expect(value.track("video", 0)).toEqual([[0, 10, 40], [15, 20, 0], [20, 21, 0]]);
  });

  it("closes a clip that is not a whole number of frames by its exact length (no 17 ms gap)", async () => {
    // 9.46 s at 25 fps is 236.5 frames; Premiere's own ripple shifted by 236 frames and left half a frame open.
    const value = timelineHost([[clip("target-1", 0, 9.46, 20), clip("following-1", 9.46, 19.46, 40)]]);
    const odd = { ...expectedSnapshot, target: { ...target, endSeconds: 9.46, outSeconds: 29.46, durationSeconds: 9.46 }, following: { ...following, startSeconds: 9.46, endSeconds: 19.46 } };
    await expect(value.registry.dispatch("trackItem.rippleDelete", rippleArgs("ripple-odd", { expectedSnapshot: odd }))).resolves.toMatchObject({ outcome: "verified" });
    expect(value.track("video", 0)).toEqual([[0, 10, 40]]);
  });

  it("does not invoke unrelated earlier item getters during preflight or the follow-up readbacks", async () => {
    const value = timelineHost([[clip("unrelated-1", 0, 5, 0), clip("target-1", 5, 15, 20), clip("following-1", 15, 25, 40)]]);
    const unrelatedGetter = vi.fn(async () => { throw new Error("unrelated item must not be read"); });
    const unrelated = value.lists.video[0]![0]! as unknown as Record<string, unknown>;
    for (const key of ["getProjectItem", "getStartTime", "getEndTime", "getInPoint", "getOutPoint", "getDuration", "getSpeed", "isSpeedReversed"]) unrelated[key] = unrelatedGetter;
    const shifted = (item: typeof target) => ({ ...item, startSeconds: item.startSeconds + 5, endSeconds: item.endSeconds + 5 });
    await expect(value.registry.dispatch("trackItem.rippleDelete", {
      mediaType: "video", trackIndex: 0, clipIndex: 1, confirmRippleDelete: true, operationId: "bounded-readback",
      expectedSnapshot: { ...expectedSnapshot, clipIndex: 1, trackItemCount: 3, target: shifted(target), following: shifted(following) },
    })).resolves.toMatchObject({ outcome: "verified", after: { trackItemCount: 2, successorClipIndex: 1 } });
    expect(unrelatedGetter).not.toHaveBeenCalled();
  });

  it("rejects missing authority, stale state, a final item, and a gap before action creation, tagging each noHostWrite", async () => {
    const attempts = [
      { args: { ...targetCoordinates, expectedSnapshot, operationId: "missing-confirmation" }, code: "UXP_CONFIRMATION_REQUIRED" },
      { args: { ...targetCoordinates, expectedSnapshot, confirmRippleDelete: true }, code: "UXP_INVALID_ARGUMENT" },
      { args: rippleArgs("stale", { expectedSnapshot: { ...expectedSnapshot, following: { ...following, outSeconds: 51 } } }), code: "UXP_STALE_TRACK_ITEM" },
    ];
    for (const attempt of attempts) {
      const value = timelineHost([rippleTrack()]);
      await expect(value.registry.dispatch("trackItem.rippleDelete", attempt.args)).rejects.toMatchObject({ code: attempt.code, noHostWrite: true });
      expect(value.project.executeTransaction).not.toHaveBeenCalled();
    }
    const gap = timelineHost([[clip("target-1", 0, 10, 20), clip("following-1", 11, 21, 40)]]);
    await expect(gap.registry.dispatch("trackItem.rippleDelete.inspect", targetCoordinates)).rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED", noHostWrite: true });
    const finalItem = timelineHost([rippleTrack()]);
    await expect(finalItem.registry.dispatch("trackItem.rippleDelete.inspect", { ...targetCoordinates, clipIndex: 1 })).rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED" });
    expect(gap.project.executeTransaction).not.toHaveBeenCalled();
    expect(finalItem.project.executeTransaction).not.toHaveBeenCalled();
  });

  it("replays a completed operation ID without creating a second host transaction", async () => {
    const value = timelineHost([rippleTrack()]);
    const args = rippleArgs("replay-ripple");
    await expect(value.registry.dispatch("trackItem.rippleDelete", args)).resolves.toMatchObject({ outcome: "verified" });
    await expect(value.registry.dispatch("trackItem.rippleDelete", args)).resolves.toMatchObject({ outcome: "verified", replayed: true });
    expect(value.project.executeTransaction).toHaveBeenCalledTimes(2);
    expect(value.track("video", 0)).toHaveLength(1);
  });

  it("serializes distinct operation IDs so a stale reviewed ripple cannot remove the wrong successor", async () => {
    const value = timelineHost([rippleTrack()], [], { pauseFirstSnapshot: true });
    const first = value.registry.dispatch("trackItem.rippleDelete", rippleArgs("concurrent-first"));
    await value.firstSnapshot;
    const second = value.registry.dispatch("trackItem.rippleDelete", rippleArgs("concurrent-second"));
    const secondExpectation = expect(second).rejects.toMatchObject({ code: "UXP_STALE_TRACK_ITEM" });
    value.releaseFirstSnapshot();
    await expect(first).resolves.toMatchObject({ outcome: "verified" });
    await secondExpectation;
    expect(value.project.executeTransaction).toHaveBeenCalledTimes(2);
    expect(value.track("video", 0)).toEqual([[0, 10, 40]]);
  });

  it("throws committed_unverified with Undo guidance when the gap-closing move is not applied", async () => {
    const value = timelineHost([rippleTrack()], [], { ignoreMoves: true });
    const failure = await value.registry.dispatch("trackItem.rippleDelete", rippleArgs("ripple-no-move")).catch((error: Error & { code?: string }) => error);
    expect(failure).toMatchObject({ code: "UXP_COMMITTED_UNVERIFIED" });
    expect((failure as Error).message).toContain("the project has already changed");
    expect((failure as Error).message).toContain("the delete left a gap of 10s");
    expect((failure as Error).message).toContain("Do not retry this call");
    expect((failure as Error).message).toContain("Undo 2 times");
    expect((failure as { noHostWrite?: boolean }).noHostWrite).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// trackItems.remove
// ---------------------------------------------------------------------------------------------

describe("trackItems.remove", () => {
  const items = (...coordinates: Array<[Kind, number, number]>) => coordinates.map(([mediaType, trackIndex, clipIndex]) => ({ mediaType, trackIndex, clipIndex }));
  const apply = (value: ReturnType<typeof timelineHost>, args: Record<string, unknown>, operationId: string) =>
    value.registry.dispatch("trackItems.remove", { confirmRemove: true, operationId, ...args });

  it("removes in one transaction and leaves a gap when ripple is off, building the selection inside lockedAccess", async () => {
    const value = timelineHost([[clip("a", 0, 10, 0), clip("b", 10, 20, 0), clip("c", 20, 30, 0)]]);
    await expect(apply(value, { items: items(["video", 0, 1]) }, "rm-1")).resolves.toMatchObject({ removed: true, verified: true, outcome: "verified", ripple: false, itemsRemoved: 1, itemsMoved: 0, undoSteps: 1 });
    expect(value.track("video", 0)).toEqual([[0, 10, 0], [20, 30, 0]]);
    expect(value.project.executeTransaction).toHaveBeenCalledTimes(1);
  });

  it("closes each track with exact moves when ripple is on, across video and audio in one selection", async () => {
    const value = timelineHost([[clip("a", 0, 10, 0), clip("b", 10, 20, 0), clip("c", 20, 30, 0)]], [[clip("x", 0, 10, 0), clip("y", 10, 20, 0)]]);
    await expect(apply(value, { items: items(["video", 0, 1], ["audio", 0, 0]), ripple: true }, "rm-2")).resolves.toMatchObject({ removed: true, outcome: "verified", itemsRemoved: 2, itemsMoved: 2, undoSteps: 2 });
    expect(value.track("video", 0)).toEqual([[0, 10, 0], [10, 20, 0]]);
    expect(value.track("audio", 0)).toEqual([[0, 10, 0]]);
    expect(value.removeAction).toHaveBeenCalledWith(expect.anything(), false, 3, false);
  });

  it("refuses a reviewed coordinate that no longer matches, before any write", async () => {
    // A fresh host per attempt: the dispatcher fences a registry after an untagged failure until it honours noHostWrite.
    const fresh = () => timelineHost([[clip("a", 0, 10, 0), clip("b", 10, 20, 0)]]);
    const attempts: Array<[(value: ReturnType<typeof timelineHost>) => Promise<unknown>, string]> = [
      [(v) => apply(v, { items: [{ mediaType: "video", trackIndex: 0, clipIndex: 1, expectedProjectItemId: "somebody-else" }] }, "rm-3"), "UXP_STALE_TRACK_ITEM"],
      [(v) => apply(v, { items: [{ mediaType: "video", trackIndex: 0, clipIndex: 1, expectedStartTicks: tk(11) }] }, "rm-4"), "UXP_STALE_TRACK_ITEM"],
      [(v) => apply(v, { items: items(["video", 0, 5]) }, "rm-5"), "UXP_TARGET_NOT_FOUND"],
      [(v) => apply(v, { items: items(["video", 0, 1], ["video", 0, 1]) }, "rm-6"), "UXP_INVALID_ARGUMENT"],
      [(v) => v.registry.dispatch("trackItems.remove", { items: items(["video", 0, 1]), operationId: "rm-7" }), "UXP_CONFIRMATION_REQUIRED"],
    ];
    for (const [run, code] of attempts) {
      const value = fresh();
      await expect(run(value)).rejects.toMatchObject({ code, noHostWrite: true });
      expect(value.project.executeTransaction).not.toHaveBeenCalled();
      expect(value.track("video", 0)).toHaveLength(2);
    }
  });

  it("reports committed_unverified with the Undo count when the ripple move does not land", async () => {
    const value = timelineHost([[clip("a", 0, 10, 0), clip("b", 10, 20, 0)]], [], { ignoreMoves: true });
    await expect(apply(value, { items: items(["video", 0, 0]), ripple: true }, "rm-8")).resolves.toMatchObject({
      removed: false, committed: true, verified: false, partial: true, outcome: "committed_unverified", undoSteps: 2, rollbackPerformed: false,
      problems: [expect.stringContaining("instead of")],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// trackItem.razor
// ---------------------------------------------------------------------------------------------

describe("trackItem.razor", () => {
  const razor = (value: ReturnType<typeof timelineHost>, args: Record<string, unknown>, operationId: string) =>
    value.registry.dispatch("trackItem.razor", { confirmRazor: true, operationId, ...args });

  it("splits one clip with clone, trim and move in three transactions, parked past the end of the track", async () => {
    const value = timelineHost([[clip("a", 0, 10, 0)]], [[clip("a-audio", 0, 10, 0)]]);
    await expect(razor(value, { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 4 }, "rz-1")).resolves.toMatchObject({
      razored: true, verified: true, outcome: "verified", cutSeconds: 4, undoSteps: 3, linkedHalvesRelinked: false,
      halves: [{ mediaType: "video", trackIndex: 0, projectItemId: "a", leftStartSeconds: 0, rightEndSeconds: 10 }],
    });
    expect(value.track("video", 0)).toEqual([[0, 4, 0], [4, 10, 4]]);
    // The linked audio is untouched, and the receipt says the halves are not relinked.
    expect(value.track("audio", 0)).toEqual([[0, 10, 0]]);
    expect(value.project.executeTransaction.mock.calls.map((call) => call[1])).toEqual(["Razor timeline item (cut)", "Razor timeline item (trim)", "Razor timeline item (place)"]);
    // The clone is offset to 10 s past the end of the track (frame aligned), never over a neighbour.
    const [, offset] = value.cloneAction.mock.calls[0]!;
    expect(sec(offset.ticks)).toBe(20);
  });

  it("razors every item that crosses the cut when allTracks is set, linked audio included", async () => {
    const value = timelineHost([[clip("a", 0, 10, 0)], [clip("b", 2, 6, 0)], [clip("c", 8, 9, 0)]], [[clip("a-audio", 0, 10, 0)]]);
    const result = await razor(value, { allTracks: true, timeSeconds: 4 }, "rz-2");
    expect(result).toMatchObject({ razored: true, outcome: "verified", undoSteps: 3 });
    expect((result as { halves: unknown[] }).halves).toHaveLength(3);
    expect(value.track("video", 0)).toEqual([[0, 4, 0], [4, 10, 4]]);
    expect(value.track("video", 1)).toEqual([[2, 4, 0], [4, 6, 2]]);
    expect(value.track("video", 2)).toEqual([[8, 9, 0]]);
    expect(value.track("audio", 0)).toEqual([[0, 4, 0], [4, 10, 4]]);
  });

  it("snaps the cut to a frame of the sequence", async () => {
    const value = timelineHost([[clip("a", 0, 10, 0)]]);
    await expect(razor(value, { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 4.013 }, "rz-3")).resolves.toMatchObject({ outcome: "verified", cutSeconds: 4.0 });
    expect(value.track("video", 0)).toEqual([[0, 4, 0], [4, 10, 4]]);
  });

  it("refuses before any write: a cut at an edge, a retimed clip, nothing under the cut, or an ambiguous target", async () => {
    const fresh = () => timelineHost([[clip("a", 0, 10, 0), clip("slow", 10, 20, 0, { speed: 0.5 })]]);
    const attempts: Array<[(value: ReturnType<typeof timelineHost>) => Promise<unknown>, string]> = [
      [(v) => razor(v, { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 10 }, "rz-4"), "UXP_INVALID_ARGUMENT"],
      [(v) => razor(v, { mediaType: "video", trackIndex: 0, clipIndex: 1, timeSeconds: 15 }, "rz-5"), "UXP_TARGET_UNSUPPORTED"],
      [(v) => razor(v, { allTracks: true, timeSeconds: 50 }, "rz-6"), "UXP_TARGET_NOT_FOUND"],
      [(v) => razor(v, { allTracks: true, mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 5 }, "rz-7"), "UXP_INVALID_ARGUMENT"],
      [(v) => v.registry.dispatch("trackItem.razor", { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 5, operationId: "rz-8" }), "UXP_CONFIRMATION_REQUIRED"],
    ];
    for (const [run, code] of attempts) {
      const value = fresh();
      await expect(run(value)).rejects.toMatchObject({ code, noHostWrite: true });
      expect(value.project.executeTransaction).not.toHaveBeenCalled();
    }
  });

  it("returns committed_unverified with the Undo count when the trim step is ignored", async () => {
    // The clone never reaches its trimmed start, so the move step cannot find it; two transactions have committed.
    const value = timelineHost([[clip("a", 0, 10, 0)]], [], { ignoreSetStart: true });
    const result = await razor(value, { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 4 }, "rz-9");
    expect(result).toMatchObject({ razored: false, committed: true, verified: false, outcome: "committed_unverified", undoSteps: 2, readbackError: expect.stringContaining("parking position") });
  });

  it("returns committed_unverified after the first transaction when a later step cannot find the clone", async () => {
    const value = timelineHost([[clip("a", 0, 10, 0)]]);
    const original = value.cloneAction.getMockImplementation()!;
    value.cloneAction.mockImplementation(((...args: Parameters<typeof original>) => { const action = original(...args); return { apply: () => undefined, mediaType: action.mediaType }; }) as never);
    const result = await razor(value, { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 4 }, "rz-10");
    expect(result).toMatchObject({ razored: false, outcome: "committed_unverified", undoSteps: 1, rollbackPerformed: false, readbackError: expect.stringContaining("parking position") });
    // The original was already trimmed, so the Undo count matters.
    expect(value.track("video", 0)).toEqual([[0, 4, 0]]);
  });
});

// ---------------------------------------------------------------------------------------------
// timeline.range.extract
// ---------------------------------------------------------------------------------------------

describe("timeline.range.extract", () => {
  const extract = (value: ReturnType<typeof timelineHost>, args: Record<string, unknown>, operationId: string) =>
    value.registry.dispatch("timeline.range.extract", { confirmExtract: true, operationId, ...args });

  it("cuts a range out of every track and closes the gap, with the moves in one transaction in ascending order", async () => {
    const value = timelineHost(
      [[clip("long", 0, 30, 0), clip("later", 30, 40, 0)], [clip("v2", 15, 25, 100)]],
      [[clip("mix", 0, 40, 0)]],
    );
    const order: string[] = [];
    for (const list of [...value.lists.video, ...value.lists.audio]) for (const item of list) item.createMoveAction.mockImplementation(((by: { ticks: string }) => ({ apply: () => { order.push(item.state.pid); item.state.start = String(BigInt(item.state.start) + BigInt(by.ticks)); item.state.end = String(BigInt(item.state.end) + BigInt(by.ticks)); } })) as never);
    const result = await extract(value, { startSeconds: 20, endSeconds: 22 }, "ex-1");
    expect(result).toMatchObject({ extracted: true, verified: true, outcome: "verified", startSeconds: 20, endSeconds: 22, removedSeconds: 2, tracks: 3 });
    expect(value.track("video", 0)).toEqual([[0, 20, 0], [20, 28, 22], [28, 38, 0]]);
    expect(value.track("video", 1)).toEqual([[15, 20, 100], [20, 23, 107]]);
    expect(value.track("audio", 0)).toEqual([[0, 20, 0], [20, 38, 22]]);
    // Each later item moved once, and the moves ran in ascending start order on every track.
    const moves = value.project.executeTransaction.mock.calls.filter((call) => String(call[1]).endsWith("(close gap)"));
    expect(moves).toHaveLength(1);
    expect(order.indexOf("long")).toBeLessThan(order.indexOf("later"));
  });

  it("limits the edit to chosen tracks and refuses when an unchosen track has an item over the range", async () => {
    const value = timelineHost([[clip("a", 0, 30, 0)]], [[clip("partner", 0, 30, 0)]]);
    await expect(extract(value, { startSeconds: 10, endSeconds: 12, videoTracks: [0], audioTracks: [] }, "ex-2")).rejects.toMatchObject({
      code: "UXP_TARGET_UNSUPPORTED", noHostWrite: true, message: expect.stringContaining("audio track 0 clip 0"),
    });
    expect(value.project.executeTransaction).not.toHaveBeenCalled();
    // An unchosen track with nothing over the range is fine and is left alone.
    const clear = timelineHost([[clip("a", 0, 30, 0)]], [[clip("partner", 0, 5, 0)]]);
    await expect(extract(clear, { startSeconds: 10, endSeconds: 12, videoTracks: [0], audioTracks: [] }, "ex-3")).resolves.toMatchObject({ outcome: "verified", tracks: 1 });
    expect(clear.track("audio", 0)).toEqual([[0, 5, 0]]);
  });

  it("removes whole clips inside the range and shifts a clip that starts inside it", async () => {
    const value = timelineHost([[clip("a", 0, 10, 0), clip("b", 10, 12, 0), clip("c", 12, 20, 0)]]);
    // Cuts at 14 and 8 leave three pieces inside the range (the right of a, all of b, the left of c).
    await expect(extract(value, { startSeconds: 8, endSeconds: 14 }, "ex-4")).resolves.toMatchObject({ outcome: "verified", itemsRemoved: 3 });
    expect(value.track("video", 0)).toEqual([[0, 8, 0], [8, 14, 2]]);
  });

  it("refuses retimed edge clips, bad ranges and empty ranges before any write", async () => {
    const fresh = () => timelineHost([[clip("slow", 0, 30, 0, { speed: 2 })]]);
    const attempts: Array<[Record<string, unknown>, string, string]> = [
      [{ startSeconds: 10, endSeconds: 12 }, "ex-5", "UXP_TARGET_UNSUPPORTED"],
      [{ startSeconds: 12, endSeconds: 10 }, "ex-6", "UXP_INVALID_ARGUMENT"],
      [{ startSeconds: 40, endSeconds: 45 }, "ex-7", "UXP_TARGET_NOT_FOUND"],
      [{ startSeconds: 1, endSeconds: 2, videoTracks: [3] }, "ex-8", "UXP_TARGET_NOT_FOUND"],
    ];
    for (const [args, id, code] of attempts) {
      const value = fresh();
      await expect(extract(value, args, id)).rejects.toMatchObject({ code, noHostWrite: true });
      expect(value.project.executeTransaction).not.toHaveBeenCalled();
    }
  });

  it("reports committed_unverified with the Undo count when the closing moves do not land", async () => {
    // The range edges already sit on clip edges, so no razor is needed: one remove, then the ignored close-up move.
    const value = timelineHost([[clip("a", 0, 2, 0), clip("b", 2, 4, 0), clip("c", 4, 10, 0), clip("d", 10, 20, 0)]], [], { ignoreMoves: true });
    const result = await extract(value, { startSeconds: 2, endSeconds: 4 }, "ex-9");
    expect(result).toMatchObject({ extracted: false, committed: true, verified: false, outcome: "committed_unverified", rollbackPerformed: false, undoSteps: 2 });
    expect((result as { problems: string[] }).problems.length).toBeGreaterThan(0);
  });
});
