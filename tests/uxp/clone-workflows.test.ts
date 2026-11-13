import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const Commands = require("../../uxp-plugin/commands.cjs");
const Protocol = require("../../uxp-plugin/protocol.cjs");

type CloneHostOptions = { pauseFirstSnapshot?: boolean };

function cloneHost(options: CloneHostOptions = {}) {
  const states: Array<{ projectItemId: string; start: number; end: number; inPoint: number; outPoint: number; speed: number; reversed: boolean }> = [
    { projectItemId: "source-1", start: 0, end: 10, inPoint: 20, outPoint: 30, speed: 1, reversed: false },
  ];
  let releaseFirstSnapshot: (() => void) | null = null;
  let firstSnapshotStarted: (() => void) | null = null;
  const firstSnapshot = new Promise<void>((resolve) => { firstSnapshotStarted = resolve; });
  const firstSnapshotRelease = new Promise<void>((resolve) => { releaseFirstSnapshot = resolve; });
  let waitForFirstSnapshot = options.pauseFirstSnapshot === true;

  function itemFor(state: typeof states[number]) {
    return {
      getProjectItem: vi.fn(async () => ({ getId: vi.fn(async () => state.projectItemId) })),
      getStartTime: vi.fn(async () => ({ seconds: state.start })),
      getEndTime: vi.fn(async () => ({ seconds: state.end })),
      getInPoint: vi.fn(async () => {
        if (waitForFirstSnapshot) {
          waitForFirstSnapshot = false;
          firstSnapshotStarted?.();
          await firstSnapshotRelease;
        }
        return { seconds: state.inPoint };
      }),
      getOutPoint: vi.fn(async () => ({ seconds: state.outPoint })),
      getDuration: vi.fn(async () => ({ seconds: state.end - state.start })),
      getSpeed: vi.fn(async () => state.speed),
      isSpeedReversed: vi.fn(async () => state.reversed),
      createSetInPointAction: vi.fn((time: { seconds: number }) => ({ apply: () => { state.inPoint = time.seconds; } })),
      createSetOutPointAction: vi.fn((time: { seconds: number }) => ({ apply: () => { state.outPoint = time.seconds; } })),
    };
  }
  const items = states.map(itemFor);
  const videoTrack = { getTrackItems: vi.fn(async () => items) };
  const sequence = {
    guid: "sequence-1",
    getVideoTrackCount: vi.fn(async () => 1), getVideoTrack: vi.fn(async () => videoTrack),
    getAudioTrackCount: vi.fn(async () => 0), getAudioTrack: vi.fn(async () => null),
  };
  const cloneAction = vi.fn((item: ReturnType<typeof itemFor>, offset: { seconds: number }, videoOffset: number, audioOffset: number, alignToVideo: boolean, isInsert: boolean) => ({
    apply: () => {
      const sourceIndex = items.indexOf(item);
      const source = states[sourceIndex]!;
      const copy = {
        projectItemId: source.projectItemId, start: source.start + offset.seconds, end: source.end + offset.seconds,
        inPoint: source.inPoint, outPoint: source.outPoint, speed: source.speed, reversed: source.reversed,
      };
      states.splice(sourceIndex + 1, 0, copy);
      items.splice(sourceIndex + 1, 0, itemFor(copy));
    },
  }));
  const addAction = vi.fn((action: { apply: () => void }) => { action.apply(); return true; });
  const project = {
    guid: "project-1", getActiveSequence: vi.fn(async () => sequence), lockedAccess: vi.fn((callback: () => void) => callback()),
    executeTransaction: vi.fn((callback: (compound: { addAction: typeof addAction }) => void) => { callback({ addAction }); return true; }),
  };
  const ppro = {
    Project: { getActiveProject: vi.fn(async () => project) }, TickTime: { createWithSeconds: vi.fn((seconds: number) => ({ seconds })) },
    SequenceEditor: { getEditor: vi.fn(() => ({ createCloneTrackItemAction: cloneAction })) }, Constants: { TrackItemType: { CLIP: 1 } },
  };
  return { states, items, cloneAction, project, firstSnapshot, releaseFirstSnapshot: () => releaseFirstSnapshot?.(), registry: Commands.createCommandRegistry({ ppro, Protocol }) };
}

const source = { projectItemId: "source-1", startSeconds: 0, endSeconds: 10, inSeconds: 20, outSeconds: 30, durationSeconds: 10, speed: 1, reversed: false };
const expectedSnapshot = { projectGuid: "project-1", sequenceId: "sequence-1", mediaType: "video", trackIndex: 0, clipIndex: 0, trackItemCount: 1, source };
const targetCoordinates = { mediaType: "video", trackIndex: 0, clipIndex: 0 };

describe("guarded documented UXP append-only track-item duplicate workflow", () => {
  it("retains a partial commit receipt and prevents a replay from cloning again", async () => {
    const value = cloneHost();
    const original = value.cloneAction.getMockImplementation()!;
    value.cloneAction.mockImplementation((...args) => {
      const action = original(...args);
      return { apply: () => { action.apply(); value.states[0].end = 8; } };
    });
    const input = { ...targetCoordinates, expectedSnapshot, confirmDuplicate: true, operationId: "partial-copy" };
    await expect(value.registry.dispatch("trackItem.clone", input)).resolves.toMatchObject({ outcome: "committed_unverified", partial: true, committed: true, rollbackPerformed: false });
    await expect(value.registry.dispatch("trackItem.clone", input)).resolves.toMatchObject({ replayed: true });
    expect(value.cloneAction).toHaveBeenCalledTimes(1);
  });
  it("advertises bounded inspection and an idempotent undoable transaction command", async () => {
    const value = cloneHost();
    await expect(value.registry.capabilities()).resolves.toMatchObject({ commands: {
      "trackItem.clone.inspect": { supported: true, readOnly: true, minHostVersion: "25.6.0" },
      "trackItem.clone": { supported: true, destructive: true, undoable: true, idempotent: true, targetCapabilityProbe: "invocation" },
    } });
    await expect(value.registry.dispatch("trackItem.clone.inspect", targetCoordinates)).resolves.toEqual(expectedSnapshot);
    expect(value.project.executeTransaction).not.toHaveBeenCalled();
  });

  it("appends one reviewed final item in one transaction and reads only the source plus deterministic new coordinate", async () => {
    const value = cloneHost();
    await expect(value.registry.dispatch("trackItem.clone", {
      ...targetCoordinates, expectedSnapshot, confirmDuplicate: true, operationId: "clone-apply-1",
    })).resolves.toMatchObject({
      operationId: "clone-apply-1", duplicated: true, outcome: "verified", before: expectedSnapshot,
      after: {
        projectGuid: "project-1", sequenceId: "sequence-1", mediaType: "video", trackIndex: 0,
        sourceClipIndex: 0, duplicateClipIndex: 1, trackItemCount: 2, source,
        duplicate: { ...source, startSeconds: 10, endSeconds: 20 },
      },
      verificationBoundary: "source_and_appended_track_item_readback",
    });
    expect(value.project.executeTransaction).toHaveBeenCalledTimes(1);
    expect(value.project.executeTransaction.mock.calls[0]?.[1]).toBe("Duplicate timeline item after source");
    expect(value.cloneAction).toHaveBeenCalledWith(value.items[0], { seconds: 10 }, 0, 0, false, true);
    expect(value.states).toEqual([
      { projectItemId: "source-1", start: 0, end: 10, inPoint: 20, outPoint: 30, speed: 1, reversed: false },
      { projectItemId: "source-1", start: 10, end: 20, inPoint: 20, outPoint: 30, speed: 1, reversed: false },
    ]);
  });

  it("does not invoke unrelated earlier item getters during append preflight or readback", async () => {
    const value = cloneHost();
    const unrelatedGetter = vi.fn(async () => { throw new Error("unrelated item must not be read"); });
    value.states.unshift({ projectItemId: "unrelated-1", start: 0, end: 5, inPoint: 0, outPoint: 5, speed: 1, reversed: false });
    // Only the start is read, to order the track (the host lists items in creation order); nothing else of it is.
    const startOnly = vi.fn(async () => ({ ticks: "0", seconds: 0 }));
    value.items.unshift({
      getProjectItem: unrelatedGetter, getStartTime: startOnly, getEndTime: unrelatedGetter,
      getInPoint: unrelatedGetter, getOutPoint: unrelatedGetter, getDuration: unrelatedGetter,
      getSpeed: unrelatedGetter, isSpeedReversed: unrelatedGetter,
      createSetInPointAction: unrelatedGetter, createSetOutPointAction: unrelatedGetter,
    });
    const target = { mediaType: "video", trackIndex: 0, clipIndex: 1 };
    const expected = { ...expectedSnapshot, clipIndex: 1, trackItemCount: 2 };
    await expect(value.registry.dispatch("trackItem.clone", {
      ...target, expectedSnapshot: expected, confirmDuplicate: true, operationId: "bounded-readback",
    })).resolves.toMatchObject({ outcome: "verified", after: { trackItemCount: 3, duplicateClipIndex: 2 } });
    expect(unrelatedGetter).not.toHaveBeenCalled();
  });

  it("rejects missing confirmation/replay, stale state, and non-final sources before action creation", async () => {
    const attempts = [
      { args: { ...targetCoordinates, expectedSnapshot, operationId: "missing-confirmation" }, code: "UXP_CONFIRMATION_REQUIRED" },
      { args: { ...targetCoordinates, expectedSnapshot, confirmDuplicate: true }, code: "UXP_INVALID_ARGUMENT" },
      { args: { ...targetCoordinates, expectedSnapshot: { ...expectedSnapshot, source: { ...source, outSeconds: 31 } }, confirmDuplicate: true, operationId: "stale" }, code: "UXP_STALE_TRACK_ITEM" },
    ];
    for (const attempt of attempts) {
      const value = cloneHost();
      await expect(value.registry.dispatch("trackItem.clone", attempt.args)).rejects.toMatchObject({ code: attempt.code });
      expect(value.project.executeTransaction).not.toHaveBeenCalled();
    }
    const nonFinal = cloneHost();
    nonFinal.states.push({ projectItemId: "later-1", start: 10, end: 20, inPoint: 0, outPoint: 10, speed: 1, reversed: false });
    nonFinal.items.push({ ...nonFinal.items[0], getProjectItem: vi.fn(async () => ({ getId: vi.fn(async () => "later-1") })) });
    await expect(nonFinal.registry.dispatch("trackItem.clone.inspect", targetCoordinates)).rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED" });
    expect(nonFinal.project.executeTransaction).not.toHaveBeenCalled();
  });

  it("replays a completed operation ID without creating a second host transaction", async () => {
    const value = cloneHost();
    const args = { ...targetCoordinates, expectedSnapshot, confirmDuplicate: true, operationId: "replay-clone" };
    await expect(value.registry.dispatch("trackItem.clone", args)).resolves.toMatchObject({ outcome: "verified" });
    await expect(value.registry.dispatch("trackItem.clone", args)).resolves.toMatchObject({ outcome: "verified", replayed: true });
    expect(value.project.executeTransaction).toHaveBeenCalledTimes(1);
    expect(value.states).toHaveLength(2);
  });

  it("serializes different operation IDs so a stale reviewed final-item snapshot cannot create a second duplicate", async () => {
    const value = cloneHost({ pauseFirstSnapshot: true });
    const first = value.registry.dispatch("trackItem.clone", { ...targetCoordinates, expectedSnapshot, confirmDuplicate: true, operationId: "concurrent-first" });
    await value.firstSnapshot;
    const second = value.registry.dispatch("trackItem.clone", { ...targetCoordinates, expectedSnapshot, confirmDuplicate: true, operationId: "concurrent-second" });
    const secondExpectation = expect(second).rejects.toMatchObject({ code: "UXP_STALE_TRACK_ITEM" });
    value.releaseFirstSnapshot();
    await expect(first).resolves.toMatchObject({ outcome: "verified" });
    await secondExpectation;
    expect(value.project.executeTransaction).toHaveBeenCalledTimes(1);
    expect(value.states).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Destination mode: copy a clip into an empty range, on any track, not only after the last clip.
// ---------------------------------------------------------------------------------------------

type DestState = { projectItemId: string; start: number; end: number; inPoint: number; outPoint: number };
const TICKS = 254016000000;
const FRAME_TICKS = TICKS / 25;

type DestOptions = { kind?: "video" | "audio"; trimNeighbour?: boolean };
const ticksOf = (seconds: number) => String(Math.round(seconds * 1000) * (TICKS / 1000));

function destinationHost(tracks: DestState[][], options: DestOptions = {}) {
  const kind = options.kind ?? "video";
  const lists = tracks.map((track) => track.map((state) => ({ ...state })));
  const itemFor = (state: DestState) => ({
    state,
    getProjectItem: vi.fn(async () => ({ getId: vi.fn(async () => state.projectItemId) })),
    getStartTime: vi.fn(async () => ({ seconds: state.start, ticks: ticksOf(state.start) })),
    getEndTime: vi.fn(async () => ({ seconds: state.end, ticks: ticksOf(state.end) })),
    getInPoint: vi.fn(async () => ({ seconds: state.inPoint })),
    getOutPoint: vi.fn(async () => ({ seconds: state.outPoint })),
    getDuration: vi.fn(async () => ({ seconds: state.end - state.start })),
    getSpeed: vi.fn(async () => 1),
    isSpeedReversed: vi.fn(async () => false),
  });
  const items = lists.map((track) => track.map(itemFor));
  const sorted = (index: number) => [...items[index]!].sort((a, b) => a.state.start - b.state.start);
  const sequence = {
    guid: "sequence-1",
    getTimebase: vi.fn(async () => String(FRAME_TICKS)),
    getVideoTrackCount: vi.fn(async () => kind === "video" ? items.length : 0),
    getVideoTrack: vi.fn(async (index: number) => ({ getTrackItems: vi.fn(async () => sorted(index)) })),
    getAudioTrackCount: vi.fn(async () => kind === "audio" ? items.length : 0),
    getAudioTrack: vi.fn(async (index: number) => kind === "audio" ? { getTrackItems: vi.fn(async () => sorted(index)) } : null),
  };
  // Ticks are exact; the host rounds nothing, so the offset must arrive as ticks, not float seconds.
  const cloneAction = vi.fn((item: ReturnType<typeof itemFor>, offset: { ticks: string }, videoOffset: number, audioOffset: number, _align: boolean, isInsert: boolean) => ({
    apply: () => {
      const trackIndex = items.findIndex((track) => track.includes(item));
      const target = trackIndex + (kind === "video" ? videoOffset : audioOffset);
      if (!items[target]) items[target] = [];
      const by = Number(BigInt(offset.ticks)) / TICKS, start = item.state.start + by, end = item.state.end + by;
      // An overwriting host trims whatever the copy lands next to.
      if (options.trimNeighbour) for (const other of items[target]!) if (other.state.end > start - 5 && other.state.start < start) other.state.end = start - 1;
      items[target]!.push(itemFor({ ...item.state, start, end }));
    },
    isInsert,
  }));
  const addAction = vi.fn((action: { apply: () => void }) => { action.apply(); return true; });
  const project = {
    guid: "project-1", getActiveSequence: vi.fn(async () => sequence), lockedAccess: vi.fn((callback: () => void) => callback()),
    executeTransaction: vi.fn((callback: (compound: { addAction: typeof addAction }) => void) => { callback({ addAction }); return true; }),
  };
  const ppro = {
    Project: { getActiveProject: vi.fn(async () => project) }, TickTime: { createWithSeconds: vi.fn((seconds: number) => ({ seconds })), createWithTicks: vi.fn((ticks: string) => ({ ticks, seconds: Number(BigInt(ticks)) / TICKS })) },
    SequenceEditor: { getEditor: vi.fn(() => ({ createCloneTrackItemAction: cloneAction })) }, Constants: { TrackItemType: { CLIP: 1 } },
  };
  const track = (index: number) => sorted(index).map((item) => [item.state.start, item.state.end, item.state.inPoint]);
  return { items, cloneAction, project, track, ppro, registry: Commands.createCommandRegistry({ ppro, Protocol }) };
}

const snapshotOf = (value: ReturnType<typeof destinationHost>, trackIndex: number, clipIndex: number, mediaType = "video") => {
  const items = [...value.items[trackIndex]!].sort((a, b) => a.state.start - b.state.start), state = items[clipIndex]!.state;
  return {
    projectGuid: "project-1", sequenceId: "sequence-1", mediaType, trackIndex, clipIndex, trackItemCount: items.length,
    source: { projectItemId: state.projectItemId, startSeconds: state.start, endSeconds: state.end, inSeconds: state.inPoint, outSeconds: state.outPoint, durationSeconds: state.end - state.start, speed: 1, reversed: false },
  };
};

describe("trackItem.clone with a destination", () => {
  const apply = (value: ReturnType<typeof destinationHost>, trackIndex: number, clipIndex: number, extra: Record<string, unknown>, operationId: string) =>
    value.registry.dispatch("trackItem.clone", { mediaType: "video", trackIndex, clipIndex, expectedSnapshot: snapshotOf(value, trackIndex, clipIndex), confirmDuplicate: true, operationId, ...extra });

  it("copies a middle clip into an empty gap on the same track, frame-snapped, without inserting", async () => {
    const value = destinationHost([[
      { projectItemId: "a", start: 0, end: 10, inPoint: 0, outPoint: 10 },
      { projectItemId: "b", start: 10, end: 20, inPoint: 5, outPoint: 15 },
      { projectItemId: "c", start: 20, end: 30, inPoint: 0, outPoint: 10 },
      { projectItemId: "d", start: 60, end: 70, inPoint: 0, outPoint: 10 },
    ]]);
    const result = await apply(value, 0, 1, { destinationSeconds: 40.013 }, "dest-1");
    expect(result).toMatchObject({ duplicated: true, outcome: "verified", verificationBoundary: "source_and_destination_track_item_readback", after: { duplicateClipIndex: 3, destinationTrackIndex: 0, duplicate: { projectItemId: "b", startSeconds: 40, endSeconds: 50, inSeconds: 5, outSeconds: 15 } } });
    expect(value.track(0)).toEqual([[0, 10, 0], [10, 20, 5], [20, 30, 0], [40, 50, 5], [60, 70, 0]]);
    // Offset is relative to the source start, in exact ticks, vertical offset 0, isInsert false.
    expect(value.cloneAction).toHaveBeenCalledWith(expect.anything(), { ticks: String(30 * TICKS), seconds: 30 }, 0, 0, false, false);
    expect(value.ppro.TickTime.createWithSeconds).not.toHaveBeenCalled();
    expect(value.project.executeTransaction.mock.calls[0]?.[1]).toBe("Duplicate timeline item to destination");
  });

  it("copies to another track at the same time, and creates a new track when the index equals the track count", async () => {
    const value = destinationHost([[{ projectItemId: "a", start: 0, end: 10, inPoint: 0, outPoint: 10 }], [{ projectItemId: "x", start: 20, end: 30, inPoint: 0, outPoint: 10 }]]);
    await expect(apply(value, 0, 0, { destinationTrackIndex: 1 }, "dest-2")).resolves.toMatchObject({ outcome: "verified", after: { destinationTrackIndex: 1, duplicate: { projectItemId: "a", startSeconds: 0, endSeconds: 10 } } });
    expect(value.track(1)).toEqual([[0, 10, 0], [20, 30, 0]]);
    await expect(apply(value, 0, 0, { destinationTrackIndex: 2, destinationSeconds: 5 }, "dest-3")).resolves.toMatchObject({ outcome: "verified", after: { destinationTrackIndex: 2 } });
    expect(value.track(2)).toEqual([[5, 15, 0]]);
  });

  it("refuses an occupied destination, or one more than a track past the end, before any action, tagged noHostWrite", async () => {
    const make = () => destinationHost([[{ projectItemId: "a", start: 0, end: 10, inPoint: 0, outPoint: 10 }, { projectItemId: "b", start: 10, end: 20, inPoint: 0, outPoint: 10 }]]);
    const attempts: Array<[Record<string, unknown>, string]> = [
      [{ destinationSeconds: 15 }, "UXP_TARGET_OCCUPIED"],
      [{ destinationSeconds: 5 }, "UXP_TARGET_OCCUPIED"],
      [{ destinationTrackIndex: 3 }, "UXP_TARGET_NOT_FOUND"],
    ];
    for (const [extra, code] of attempts) {
      const value = make();
      await expect(apply(value, 0, 0, extra, "dest-refuse")).rejects.toMatchObject({ code, noHostWrite: true });
      expect(value.cloneAction).not.toHaveBeenCalled();
      expect(value.project.executeTransaction).not.toHaveBeenCalled();
    }
    // Inspect refuses the same way and still returns the plain snapshot when the range is free.
    await expect(make().registry.dispatch("trackItem.clone.inspect", { mediaType: "video", trackIndex: 0, clipIndex: 0, destinationSeconds: 15 })).rejects.toMatchObject({ code: "UXP_TARGET_OCCUPIED" });
    const free = make();
    await expect(free.registry.dispatch("trackItem.clone.inspect", { mediaType: "video", trackIndex: 0, clipIndex: 0, destinationSeconds: 30 })).resolves.toEqual(snapshotOf(free, 0, 0));
  });

  it("uses a whole-tick offset for a frame that is not a whole number of seconds", async () => {
    const value = destinationHost([[{ projectItemId: "a", start: 0, end: 10, inPoint: 0, outPoint: 10 }]]);
    await expect(apply(value, 0, 0, { destinationSeconds: 20.04 }, "dest-ticks")).resolves.toMatchObject({ outcome: "verified", after: { duplicate: { startSeconds: 20.04 } } });
    expect(value.cloneAction.mock.calls[0]![1]).toEqual({ ticks: String(Math.round(20.04 * 25) / 25 * TICKS), seconds: 20.04 });
  });

  it("reports committed_unverified when the host trims a neighbour of the copy, which an overwrite would", async () => {
    const value = destinationHost([[{ projectItemId: "a", start: 0, end: 10, inPoint: 0, outPoint: 10 }, { projectItemId: "n", start: 20, end: 30, inPoint: 0, outPoint: 10 }]], { trimNeighbour: true });
    const result = await apply(value, 0, 0, { destinationSeconds: 32 }, "dest-trim");
    expect(result).toMatchObject({ duplicated: false, outcome: "committed_unverified", committed: true, rollbackPerformed: false });
    expect((result as { readbackError: string }).readbackError).toContain("requested destination");
  });

  it("checks the other track grew by exactly one and its clips are unchanged", async () => {
    const value = destinationHost([[{ projectItemId: "a", start: 0, end: 10, inPoint: 0, outPoint: 10 }], [{ projectItemId: "x", start: 12, end: 22, inPoint: 0, outPoint: 10 }]], { trimNeighbour: true });
    await expect(apply(value, 0, 0, { destinationTrackIndex: 1, destinationSeconds: 25 }, "dest-other")).resolves.toMatchObject({ outcome: "committed_unverified" });
    const clean = destinationHost([[{ projectItemId: "a", start: 0, end: 10, inPoint: 0, outPoint: 10 }], [{ projectItemId: "x", start: 12, end: 22, inPoint: 0, outPoint: 10 }]]);
    await expect(apply(clean, 0, 0, { destinationTrackIndex: 1, destinationSeconds: 25 }, "dest-other-ok")).resolves.toMatchObject({ outcome: "verified", after: { destinationGrewByOne: true, destinationNeighboursUnchanged: true } });
  });

  it("refuses a new audio track as unproven on 27.0, but an existing audio track works", async () => {
    const audio = () => destinationHost([[{ projectItemId: "a", start: 0, end: 10, inPoint: 0, outPoint: 10 }]], { kind: "audio" });
    const refused = audio();
    await expect(refused.registry.dispatch("trackItem.clone", {
      mediaType: "audio", trackIndex: 0, clipIndex: 0, destinationTrackIndex: 1, expectedSnapshot: snapshotOf(refused, 0, 0, "audio"), confirmDuplicate: true, operationId: "dest-audio-new",
    })).rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED", noHostWrite: true, message: expect.stringContaining("new audio track") });
    expect(refused.cloneAction).not.toHaveBeenCalled();
    const ok = audio();
    await expect(ok.registry.dispatch("trackItem.clone", {
      mediaType: "audio", trackIndex: 0, clipIndex: 0, destinationSeconds: 30, expectedSnapshot: snapshotOf(ok, 0, 0, "audio"), confirmDuplicate: true, operationId: "dest-audio",
    })).resolves.toMatchObject({ outcome: "verified" });
  });
});
