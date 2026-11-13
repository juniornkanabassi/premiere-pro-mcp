import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const Commands = require("../../uxp-plugin/commands.cjs");
const Protocol = require("../../uxp-plugin/protocol.cjs");

const T = 254016000000n;
const tick = (seconds: number) => String(BigInt(Math.round(seconds * 1000)) * T / 1000n);

type ItemState = { id: string; projectItemId: string; name: string; start: string; end: string; inPoint: string; outPoint: string; disabled: boolean; speed: number };
type Kind = "video" | "audio";

let counter = 0;

/**
 * Item objects that die like Premiere's ("The script object is no longer valid."): once a transaction has
 * committed since they were fetched, once a lockedAccess that used them has ended, or after `staleAfterCalls`
 * further host calls. Null (the default) keeps every object valid.
 */
let strict: null | { generation: number; hostCalls: number; staleAfterCalls: number | null; locked: boolean; used: Array<() => void>; deadReadAfterCommit?: boolean; nextReadDead?: boolean } = null;
/** Whether the objects handed out by this track read are born dead (the first read after a commit, when deadReadAfterCommit is on). */
function takeDead(): boolean { if (!strict || !strict.nextReadDead) return false; strict.nextReadDead = false; return true; }
function guard(entry: Item, bornDead = false): Item {
  const mode = strict;
  if (!mode) return entry;
  const born = { generation: mode.generation, hostCalls: mode.hostCalls };
  let dead = bornDead;
  const check = () => {
    if (dead || born.generation !== mode.generation || (mode.staleAfterCalls != null && mode.hostCalls - born.hostCalls > mode.staleAfterCalls)) throw new Error("The script object is no longer valid.");
  };
  return new Proxy(entry, {
    get(target, property) {
      if (property === "__item") return target;
      if (property === "__touch") return () => { check(); if (mode.locked) mode.used.push(() => { dead = true; }); };
      const value = (target as unknown as Record<string | symbol, unknown>)[property];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        check(); mode.hostCalls++;
        if (mode.locked && String(property).startsWith("create")) mode.used.push(() => { dead = true; });
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
}
const unwrap = (entry: Item): Item => (entry as unknown as { __item?: Item }).__item ?? entry;

function makeItem(state: ItemState, options: { brokenTrim?: boolean } = {}) {
  const shiftBy = (field: "start" | "end" | "inPoint" | "outPoint", ticks: bigint) => { state[field] = String(BigInt(state[field]) + ticks); };
  return {
    state,
    getProjectItem: vi.fn(async () => ({ getId: vi.fn(async () => state.projectItemId) })),
    getStartTime: vi.fn(async () => ({ ticks: state.start })),
    getEndTime: vi.fn(async () => ({ ticks: state.end })),
    getInPoint: vi.fn(async () => ({ ticks: state.inPoint })),
    getOutPoint: vi.fn(async () => ({ ticks: state.outPoint })),
    getSpeed: vi.fn(async () => state.speed),
    isSpeedReversed: vi.fn(async () => false),
    getName: vi.fn(async () => state.name),
    isDisabled: vi.fn(async () => state.disabled),
    // Premiere 26.0.2 (measured live): every one of these is an edge trim
    // that moves the timeline edge and the matching source point together,
    // by the difference measured when the action is created. Two of them on
    // one edge in one transaction therefore trim that edge twice.
    createSetInPointAction: vi.fn((time: { ticks: string }) => { const d = BigInt(time.ticks) - BigInt(state.inPoint); return { apply: () => { shiftBy("inPoint", d); shiftBy("start", d); } }; }),
    createSetOutPointAction: vi.fn((time: { ticks: string }) => { const d = BigInt(time.ticks) - BigInt(state.outPoint); return { apply: () => { shiftBy("outPoint", d); shiftBy("end", d); } }; }),
    createSetStartAction: vi.fn((time: { ticks: string }) => { const d = BigInt(time.ticks) - BigInt(state.start); return { apply: () => { if (options.brokenTrim) return; shiftBy("start", d); shiftBy("inPoint", d); } }; }),
    createSetEndAction: vi.fn((time: { ticks: string }) => { const d = BigInt(time.ticks) - BigInt(state.end); return { apply: () => { shiftBy("end", d); shiftBy("outPoint", d); } }; }),
    createMoveAction: vi.fn((time: { ticks: string }) => ({ apply: () => { shiftBy("start", BigInt(time.ticks)); shiftBy("end", BigInt(time.ticks)); } })),
  };
}
type Item = ReturnType<typeof makeItem>;

function makeSequence(guid: string, name: string, video: Item[][], audio: Item[][]) {
  const tracks = { video, audio };
  return {
    guid,
    name,
    tracks,
    getName: vi.fn(async () => name),
    getTimebase: vi.fn(async () => "254016000"),
    getVideoTrackCount: vi.fn(async () => video.length),
    getAudioTrackCount: vi.fn(async () => audio.length),
    getVideoTrack: vi.fn(async (index: number) => video[index] ? { getTrackItems: vi.fn(async () => { const dead = takeDead(); return [...video[index]].map((entry) => guard(entry, dead)); }) } : null),
    getAudioTrack: vi.fn(async (index: number) => audio[index] ? { getTrackItems: vi.fn(async () => { const dead = takeDead(); return [...audio[index]].map((entry) => guard(entry, dead)); }) } : null),
  };
}
type Seq = ReturnType<typeof makeSequence>;

function item(kind: Kind, projectItemId: string, start: number, end: number, inPoint: number, options: Partial<ItemState> = {}) {
  return makeItem({
    id: `${kind}-${++counter}`, projectItemId, name: options.name ?? projectItemId, start: tick(start), end: tick(end),
    inPoint: tick(inPoint), outPoint: tick(inPoint + end - start), disabled: false, speed: 1, ...options,
  });
}

/**
 * Source "Backup": host camera whole on V0 (0-100 s), a guest camera cut in
 * two on V1 (0-40, 40-100, the second disabled), b-roll on V2 at 30-35, mixdown
 * on A0 (0-100). Destination "Segment": a body clip on V0 at 20-30 s.
 */
function host(options: { brokenTrim?: boolean; readbackBreaks?: boolean; drift?: (state: ItemState, kind: Kind) => void; strict?: { staleAfterCalls: number | null; deadReadAfterCommit?: boolean }; layout?: { video: Item[][]; audio: Item[][]; destinationVideo: Item[][]; destinationAudio: Item[][] } } = {}) {
  counter = 0;
  strict = options.strict ? { generation: 0, hostCalls: 0, staleAfterCalls: options.strict.staleAfterCalls, locked: false, used: [], deadReadAfterCommit: options.strict.deadReadAfterCommit } : null;
  const source = makeSequence("seq-backup", "Backup", options.layout?.video ?? [
    [item("video", "host", 0, 100, 1000, { name: "Host.MXF" })],
    [item("video", "guest", 0, 40, 2000, { name: "Guest A" }), item("video", "guest", 40, 100, 2040, { name: "Guest B", disabled: true })],
    [item("video", "broll", 30, 35, 5, { name: "Broll.mp4" })],
  ], options.layout?.audio ?? [
    [item("audio", "mix", 0, 100, 3000, { name: "Mixdown.wav" })],
  ]);
  const destination = makeSequence("seq-segment", "Segment", options.layout?.destinationVideo ?? [
    [item("video", "body", 20, 30, 0, { name: "Body" })], [], [],
  ], options.layout?.destinationAudio ?? [[]]);
  const sequences: Seq[] = [source, destination];
  const findTrack = (sequence: Seq, target: Item) => {
    for (const kind of ["video", "audio"] as Kind[]) {
      const index = sequence.tracks[kind].findIndex((list) => list.includes(target));
      if (index !== -1) return { kind, index };
    }
    return null;
  };
  const cloneAction = vi.fn((sourceItem: Item, offset: { ticks: string }, videoOffset: number, audioOffset: number, alignToVideo: boolean, isInsert: boolean) => {
    (sourceItem as unknown as { __touch?: () => void }).__touch?.();
    sourceItem = unwrap(sourceItem);
    return {
    apply: () => {
      const found = sequences.map((sequence) => findTrack(sequence, sourceItem)).find(Boolean);
      if (!found) throw new Error("clone source not found");
      const shift = BigInt(offset.ticks);
      const copy = makeItem({ ...sourceItem.state, id: `clone-${++counter}`, start: String(BigInt(sourceItem.state.start) + shift), end: String(BigInt(sourceItem.state.end) + shift) }, options);
      if (options.readbackBreaks) copy.state.disabled = !copy.state.disabled;
      options.drift?.(copy.state, found.kind);
      destination.tracks[found.kind][found.index + (found.kind === "video" ? videoOffset : audioOffset)].push(copy);
      expect(alignToVideo).toBe(false);
      expect(isInsert).toBe(false);
    },
  }; });
  const addAction = vi.fn((action: { apply: () => void }) => { action.apply(); return true; });
  const project = {
    guid: "project-1",
    getSequences: vi.fn(async () => sequences),
    lockedAccess: vi.fn((callback: () => void) => {
      if (strict) strict.locked = true;
      try { callback(); } finally { if (strict) { strict.locked = false; for (const kill of strict.used) kill(); strict.used = []; } }
    }),
    executeTransaction: vi.fn((callback: (compound: { addAction: typeof addAction }) => void) => { callback({ addAction }); if (strict) { strict.generation++; if (strict.deadReadAfterCommit) strict.nextReadDead = true; } return true; }),
  };
  const ppro = {
    Project: { getActiveProject: vi.fn(async () => project) },
    TickTime: { createWithTicks: vi.fn((ticks: string) => ({ ticks })), createWithSeconds: vi.fn((seconds: number) => ({ seconds })) },
    SequenceEditor: { getEditor: vi.fn((sequence: Seq) => {
      expect(sequence).toBe(destination);
      return { createCloneTrackItemAction: cloneAction };
    }) },
    Constants: { TrackItemType: { CLIP: 1 }, MediaType: { VIDEO: "video", AUDIO: "audio" } },
  };
  return { source, destination, project, cloneAction, addAction, registry: Commands.createCommandRegistry({ ppro, Protocol }) };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  sourceSequenceId: "seq-backup", destinationSequenceId: "seq-segment",
  sourceStartTicks: tick(30), sourceEndTicks: tick(35), destinationStartTicks: tick(0), ...overrides,
});
const names = (list: Item[]) => [...list].sort((a, b) => Number(BigInt(a.state.start) - BigInt(b.state.start))).map((entry) => entry.state.name);

describe("UXP copy clips between sequences", () => {
  it("plans every clip in the range with its trim and tick-exact destination", async () => {
    const value = host();
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", request());
    expect(plan).toMatchObject({ projectGuid: "project-1", sourceSequenceName: "Backup", destinationSequenceName: "Segment" });
    expect(plan.clips).toEqual([
      expect.objectContaining({ mediaType: "video", sourceTrackIndex: 0, targetTrackIndex: 0, name: "Host.MXF", startTicks: "0", endTicks: tick(5), inTicks: tick(1030), outTicks: tick(1035), trimHeadTicks: tick(30), trimTailTicks: tick(65) }),
      expect.objectContaining({ mediaType: "video", sourceTrackIndex: 1, name: "Guest A", startTicks: "0", endTicks: tick(5), inTicks: tick(2030), trimTailTicks: tick(5) }),
      expect.objectContaining({ mediaType: "video", sourceTrackIndex: 2, name: "Broll.mp4", startTicks: "0", endTicks: tick(5), inTicks: tick(5), trimHeadTicks: "0", trimTailTicks: "0" }),
      expect.objectContaining({ mediaType: "audio", sourceTrackIndex: 0, name: "Mixdown.wav", inTicks: tick(3030), outTicks: tick(3035) }),
    ]);
    expect(value.cloneAction).not.toHaveBeenCalled();
  });

  it("clones a range that holds only whole clips in one transaction", async () => {
    const value = host();
    const args = request({ videoTracks: [2], audioTracks: [], destinationStartTicks: tick(40) });
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
    const result = await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "whole" });
    expect(result).toMatchObject({ copied: true, verified: true, clipsCopied: 1, clipsTrimmed: 0, undoSteps: 1 });
    expect(value.project.executeTransaction).toHaveBeenCalledTimes(1);
    expect(value.destination.tracks.video[2][0].state).toMatchObject({ name: "Broll.mp4", start: tick(40), end: tick(45), inPoint: tick(5) });
  });

  it("trims clips that cross the range edges at a parking spot and moves them into place", async () => {
    const value = host();
    const args = request({ sourceStartTicks: tick(35), sourceEndTicks: tick(45), destinationStartTicks: tick(5) });
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
    const result = await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "trimmed" });
    expect(result).toMatchObject({ copied: true, verified: true, clipsCopied: 4, clipsTrimmed: 4, undoSteps: 3 });
    const [v0, v1] = value.destination.tracks.video;
    expect(names(v0)).toEqual(["Host.MXF", "Body"]);
    expect(v0.find((entry) => entry.state.name === "Host.MXF")?.state).toMatchObject({ start: tick(5), end: tick(15), inPoint: tick(1035), outPoint: tick(1045) });
    expect(names(v1)).toEqual(["Guest A", "Guest B"]);
    expect(v1[0].state).toMatchObject({ start: tick(5), end: tick(10), inPoint: tick(2035), outPoint: tick(2040), disabled: false });
    expect(v1[1].state).toMatchObject({ start: tick(10), end: tick(15), inPoint: tick(2040), outPoint: tick(2045), disabled: true });
    expect(value.destination.tracks.audio[0][0].state).toMatchObject({ start: tick(5), end: tick(15), inPoint: tick(3035) });
    await expect(value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "trimmed" })).resolves.toMatchObject({ replayed: true });
    expect(value.cloneAction).toHaveBeenCalledTimes(4);
  });

  it("moves clips to other tracks with a track offset", async () => {
    const value = host();
    value.destination.tracks.audio.push([]);
    const args = request({ videoTracks: [0], audioTracks: [0], videoTrackOffset: 2, audioTrackOffset: 1, destinationStartTicks: tick(60) });
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
    expect(plan.clips.map((placement: { targetTrackIndex: number }) => placement.targetTrackIndex)).toEqual([2, 1]);
    await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "offset" });
    expect(value.destination.tracks.video[2][0].state).toMatchObject({ name: "Host.MXF", start: tick(60) });
    expect(value.destination.tracks.audio[1][0].state).toMatchObject({ name: "Mixdown.wav", start: tick(60) });
  });

  it("copies within the same sequence", async () => {
    const value = host();
    const args = request({ destinationSequenceId: "seq-backup", videoTracks: [2], audioTracks: [], destinationStartTicks: tick(50) });
    value.cloneAction.mockClear();
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
    expect(plan.destinationSequenceName).toBe("Backup");
  });

  it("snaps times given in seconds to the sequence frame", async () => {
    const value = host();
    const frame = 10594584000n;
    for (const sequence of [value.source, value.destination]) sequence.getTimebase.mockResolvedValue(String(frame));
    value.source.tracks.video[0][0].state.end = String(frame * 3000n);
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", {
      sourceSequenceId: "seq-backup", destinationSequenceId: "seq-segment", videoTracks: [0], audioTracks: [],
      sourceStartSeconds: 50.0004, sourceEndSeconds: 52.02, destinationStartSeconds: 40,
    });
    for (const key of ["sourceStartTicks", "sourceEndTicks", "destinationStartTicks"]) expect(BigInt(plan[key]) % frame).toBe(0n);
    expect(plan.sourceStartTicks).toBe(String(1199n * frame));
    expect(plan.clips[0].startTicks).toBe(plan.destinationStartTicks);
    await expect(value.registry.dispatch("sequence.copyClips.inspect", { ...request(), sourceStartSeconds: 1 })).rejects.toThrow(/exactly one of sourceStartTicks/);
  });

  it("refuses sequences with different frame rates and times off the frame grid", async () => {
    const value = host();
    value.destination.getTimebase.mockResolvedValue("10160640000");
    await expect(value.registry.dispatch("sequence.copyClips.inspect", request())).rejects.toThrow(/different frame rates/);
    const other = host();
    await expect(other.registry.dispatch("sequence.copyClips.inspect", request({ destinationStartTicks: "1" }))).rejects.toThrow(/not on a frame boundary/);
  });

  it("refuses an occupied destination", async () => {
    const value = host();
    await expect(value.registry.dispatch("sequence.copyClips.inspect", request({ destinationStartTicks: tick(25) })))
      .rejects.toMatchObject({ code: "UXP_TARGET_OCCUPIED", message: expect.stringContaining("occupied by Body") });
  });

  it("refuses a missing destination track", async () => {
    const value = host();
    await expect(value.registry.dispatch("sequence.copyClips.inspect", request({ videoTrackOffset: 1 }))).rejects.toThrow(/video track 3 does not exist/);
  });

  it("refuses an unknown sequence, an empty range and a retimed clip on the edge", async () => {
    const value = host();
    await expect(value.registry.dispatch("sequence.copyClips.inspect", request({ sourceSequenceId: "nope" }))).rejects.toMatchObject({ code: "UXP_TARGET_NOT_FOUND" });
    await expect(value.registry.dispatch("sequence.copyClips.inspect", request({ videoTracks: [2], audioTracks: [], sourceStartTicks: tick(50), sourceEndTicks: tick(60) }))).rejects.toThrow(/No clips/);
    value.source.tracks.video[0][0].state.speed = 2;
    await expect(value.registry.dispatch("sequence.copyClips.inspect", request())).rejects.toThrow(/Host.MXF crosses the edge/);
  });

  it("requires confirmation and an operation ID", async () => {
    const value = host();
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", request());
    await expect(value.registry.dispatch("sequence.copyClips", { ...request(), expectedSnapshot: plan, operationId: "x" })).rejects.toMatchObject({ code: "UXP_CONFIRMATION_REQUIRED" });
    await expect(value.registry.dispatch("sequence.copyClips", { ...request(), expectedSnapshot: plan, confirmCopy: true })).rejects.toThrow();
    expect(value.project.executeTransaction).not.toHaveBeenCalled();
  });

  it("rejects a stale plan before any action", async () => {
    const value = host();
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", request());
    value.source.tracks.video[2][0].state.inPoint = tick(6);
    await expect(value.registry.dispatch("sequence.copyClips", { ...request(), expectedSnapshot: plan, confirmCopy: true, operationId: "stale" })).rejects.toMatchObject({ code: "UXP_STALE_TRACK_ITEM" });
    expect(value.project.executeTransaction).not.toHaveBeenCalled();
  });

  it("reports a readback mismatch as committed_unverified with the undo count", async () => {
    const value = host({ readbackBreaks: true });
    const args = request({ videoTracks: [2], audioTracks: [] });
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
    const result = await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "broken" });
    expect(result).toMatchObject({ copied: false, committed: true, outcome: "committed_unverified", undoSteps: 1 });
    expect(result.problems[0]).toContain("changed enabled state");
  });

  describe("host objects that die (live 27.0: 13 clips left 9 parked, \"The script object is no longer valid.\")", () => {
    const wide = () => host({
      strict: { staleAfterCalls: 60 },
      layout: {
        video: [0, 1, 2, 3, 4].map((n) => [item("video", `v${n}`, 0, 100, 1000 + n, { name: `V${n}` })]),
        audio: [0, 1, 2, 3].map((n) => [item("audio", `a${n}`, 0, 100, 3000 + n, { name: `A${n}` })]),
        destinationVideo: [[], [], [], [], []],
        destinationAudio: [[], [], [], []],
      },
    });
    const args = () => request({ sourceStartTicks: tick(30), sourceEndTicks: tick(35), destinationStartTicks: tick(0) });

    it("copies 9 trimmed clips across 9 tracks by reading every item again just before it is used", async () => {
      const value = wide();
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", args());
      const result = await value.registry.dispatch("sequence.copyClips", { ...args(), expectedSnapshot: plan, confirmCopy: true, operationId: "wide-1" });
      expect(result).toMatchObject({ copied: true, verified: true, outcome: "verified", clipsCopied: 9, clipsTrimmed: 9 });
      // At most 4 parked clones per round: the first clone transaction, then 2 + 3 + 3 steps over 3 rounds.
      expect(result.undoSteps).toBe(9);
      for (const list of [...value.destination.tracks.video, ...value.destination.tracks.audio]) {
        expect(list).toHaveLength(1);
        expect(list[0].state).toMatchObject({ start: tick(0), end: tick(5) });
      }
    });

    it("copies 9 trimmed clips when every read right after a commit hands out dead handles", async () => {
      const value = host({
        strict: { staleAfterCalls: 60, deadReadAfterCommit: true },
        layout: {
          video: [0, 1, 2, 3, 4].map((n) => [item("video", `v${n}`, 0, 100, 1000 + n, { name: `V${n}` })]),
          audio: [0, 1, 2, 3].map((n) => [item("audio", `a${n}`, 0, 100, 3000 + n, { name: `A${n}` })]),
          destinationVideo: [[], [], [], [], []], destinationAudio: [[], [], [], []],
        },
      });
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", args());
      await expect(value.registry.dispatch("sequence.copyClips", { ...args(), expectedSnapshot: plan, confirmCopy: true, operationId: "wide-dead" })).resolves.toMatchObject({ copied: true, verified: true, clipsTrimmed: 9 });
    });

    it("tries once more on new objects when one died before the transaction ran, and writes nothing twice", async () => {
      const value = host({ strict: { staleAfterCalls: null } });
      const real = value.cloneAction.getMockImplementation()!;
      value.cloneAction.mockImplementationOnce((() => { throw new Error("The script object is no longer valid."); }) as never);
      const wholeArgs = request({ videoTracks: [2], audioTracks: [], destinationStartTicks: tick(40) });
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", wholeArgs);
      const result = await value.registry.dispatch("sequence.copyClips", { ...wholeArgs, expectedSnapshot: plan, confirmCopy: true, operationId: "retry-1" });
      expect(result).toMatchObject({ copied: true, verified: true, undoSteps: 1 });
      expect(real).toBeDefined();
      expect(value.project.executeTransaction).toHaveBeenCalledTimes(1);
      expect(value.destination.tracks.video[2]).toHaveLength(1);
    });

    it("lists the clones still parked past the end when a later step fails", async () => {
      const value = host({ brokenTrim: true });
      const trimArgs = request({ videoTracks: [0], audioTracks: [] });
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", trimArgs);
      const result = await value.registry.dispatch("sequence.copyClips", { ...trimArgs, expectedSnapshot: plan, confirmCopy: true, operationId: "parked-1" });
      expect(result).toMatchObject({ copied: false, committed: true, outcome: "committed_unverified", undoSteps: 2 });
      expect(result.parkedClones).toEqual([expect.objectContaining({ mediaType: "video", trackIndex: 0, projectItemId: "host" })]);
      expect(BigInt(result.parkedClones[0].startTicks)).toBeGreaterThan(BigInt(tick(30)));
      expect(result.nextStep).toContain("still parked past the end");
    });

    it("tags a stale source clip as a refusal before any write", async () => {
      const value = host({ strict: { staleAfterCalls: null } });
      const wholeArgs = request({ videoTracks: [2], audioTracks: [], destinationStartTicks: tick(40) });
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", wholeArgs);
      value.source.tracks.video[2][0].state.start = tick(31); // moved after inspection, but the plan check ran first
      await expect(value.registry.dispatch("sequence.copyClips", { ...wholeArgs, expectedSnapshot: plan, confirmCopy: true, operationId: "stale-src" })).rejects.toMatchObject({ noHostWrite: true });
      expect(value.project.executeTransaction).not.toHaveBeenCalled();
    });
  });

  it("reports a trim that does not land as committed_unverified", async () => {
    const value = host({ brokenTrim: true });
    const args = request({ videoTracks: [0], audioTracks: [] });
    const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
    const result = await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "trim-broken" });
    expect(result).toMatchObject({ copied: false, committed: true, outcome: "committed_unverified" });
  });

  describe("readback tolerance", () => {
    const whole = (extra: Record<string, unknown> = {}) => request({ videoTracks: [2], audioTracks: [], destinationStartTicks: tick(40), ...extra });
    const run = async (value: ReturnType<typeof host>, args: Record<string, unknown>) => {
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
      return value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "tol-" + ++counter });
    };

    it("verifies a video end that lands 1 tick short and reports the deviation", async () => {
      const value = host({ drift: (state, kind) => { if (kind === "video") state.end = String(BigInt(state.end) - 1n); } });
      await expect(run(value, whole())).resolves.toMatchObject({ copied: true, verified: true, outcome: "verified", maxDeviationTicks: "1" });
    });

    it("verifies audio that lands less than one sample away", async () => {
      const value = host({ drift: (state, kind) => { if (kind === "audio") { state.start = String(BigInt(state.start) + 3000000n); state.end = String(BigInt(state.end) + 3000000n); } } });
      const args = request({ videoTracks: [], audioTracks: [0], sourceStartTicks: tick(0), sourceEndTicks: tick(100), destinationStartTicks: tick(0) });
      await expect(run(value, args)).resolves.toMatchObject({ copied: true, verified: true, outcome: "verified", maxDeviationTicks: "3000000" });
    });

    it("takes the sample from the sequence audio rate, falling back to 44.1 kHz", async () => {
      const drift = (state: ItemState, kind: Kind) => { if (kind === "audio") { state.start = String(BigInt(state.start) + 5500000n); state.end = String(BigInt(state.end) + 5500000n); } };
      const args = request({ videoTracks: [], audioTracks: [0], sourceStartTicks: tick(0), sourceEndTicks: tick(100), destinationStartTicks: tick(0) });
      // No rate on the sequence: the larger 44.1 kHz sample (5,760,000 ticks) applies.
      await expect(run(host({ drift }), args)).resolves.toMatchObject({ verified: true, maxDeviationTicks: "5500000" });
      // A 48 kHz sequence has a 5,292,000 tick sample, so the same landing is a real miss.
      const value = host({ drift });
      (value.destination as unknown as { getAudioSampleRate: () => Promise<number> }).getAudioSampleRate = async () => 48000;
      await expect(run(value, args)).resolves.toMatchObject({ verified: false, outcome: "committed_unverified" });
    });

    it("does not verify a video clip that lands a whole frame away", async () => {
      const frame = 254016000n;
      const value = host({ drift: (state, kind) => { if (kind === "video") state.end = String(BigInt(state.end) + frame); } });
      const result = await run(value, whole());
      expect(result).toMatchObject({ copied: false, committed: true, partial: true, outcome: "committed_unverified", maxDeviationTicks: String(frame) });
      expect(result.problems[0]).toContain("planned source range");
    });
  });

  describe("camera cut segments", () => {
    /** One sequence: cam1 on V0 and cam2 on V1 as ready-cut pieces (or whole when long), plus a mic on A0. */
    function stack(long = false, options: { createsTrack?: boolean; video?: Item[][] } = {}) {
      counter = 0;
      strict = null;
      const piece = (id: string, start: number, end: number) => item("video", id, long ? 0 : start, long ? 100 : end, 1000 + (long ? 0 : start), { name: id + "@" + start });
      const sequence = makeSequence("seq-stack", "Stack",
        options.video ?? [long ? [piece("cam1", 0, 10)] : [piece("cam1", 0, 10), piece("cam1", 20, 30)], [piece("cam2", 10, 20)]],
        [[item("audio", "mic", 0, 100, 0)]]);
      let latestEnd = 0n;
      const clone = vi.fn((sourceItem: Item, offset: { ticks: string }, videoOffset: number) => ({
        apply: () => {
          let index = sequence.tracks.video.findIndex((list) => list.includes(sourceItem)) + videoOffset;
          // Without track creation a clone aimed past the last track lands on it.
          if (options.createsTrack === false) index = Math.min(index, sequence.tracks.video.length - 1);
          sequence.tracks.video[index] ??= [];
          const shift = BigInt(offset.ticks);
          const copy = makeItem({ ...sourceItem.state, id: `clone-${++counter}`, start: String(BigInt(sourceItem.state.start) + shift), end: String(BigInt(sourceItem.state.end) + shift) });
          if (BigInt(copy.state.end) > latestEnd) latestEnd = BigInt(copy.state.end);
          sequence.tracks.video[index].push(copy);
        },
      }));
      const addAction = vi.fn((action: { apply: () => void }) => { action.apply(); return true; });
      const project = {
        guid: "project-1", getSequences: vi.fn(async () => [sequence]),
        lockedAccess: vi.fn((callback: () => void) => callback()),
        executeTransaction: vi.fn((callback: (compound: { addAction: typeof addAction }) => void) => { callback({ addAction }); return true; }),
      };
      const ppro = {
        Project: { getActiveProject: vi.fn(async () => project) },
        TickTime: { createWithTicks: vi.fn((ticks: string) => ({ ticks })) },
        SequenceEditor: { getEditor: vi.fn(() => ({ createCloneTrackItemAction: clone })) },
        Constants: { TrackItemType: { CLIP: 1 } },
      };
      return { sequence, project, clone, latestEnd: () => latestEnd, registry: Commands.createCommandRegistry({ ppro, Protocol }) };
    }
    const cut = (programTrack: number, segments: Array<Record<string, unknown>> = [
      { sourceStartTicks: tick(0), sourceEndTicks: tick(10), videoTrack: 0 },
      { sourceStartTicks: tick(10), sourceEndTicks: tick(20), videoTrack: 1 },
      { sourceStartTicks: tick(20), sourceEndTicks: tick(30), videoTrack: 0 },
    ]) => ({ sourceSequenceId: "seq-stack", destinationSequenceId: "seq-stack", programTrack, segments });
    const program = (value: ReturnType<typeof stack>, index: number) => [...value.sequence.tracks.video[index]]
      .sort((a, b) => Number(BigInt(a.state.start) - BigInt(b.state.start)))
      .map((entry) => [entry.state.projectItemId, entry.state.start, entry.state.end, entry.state.inPoint]);

    it("plans exact placements on the program track, one per segment", async () => {
      const value = stack();
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", cut(2));
      expect(plan.clips.map((clip: { projectItemId: string; targetTrackIndex: number; startTicks: string; endTicks: string }) => [clip.projectItemId, clip.targetTrackIndex, clip.startTicks, clip.endTicks])).toEqual([
        ["cam1", 2, tick(0), tick(10)], ["cam2", 2, tick(10), tick(20)], ["cam1", 2, tick(20), tick(30)],
      ]);
      expect(plan).toMatchObject({ sourceStartTicks: tick(0), sourceEndTicks: tick(30), destinationStartTicks: tick(0) });
      expect(value.clone).not.toHaveBeenCalled();
    });

    it("builds the cut on a new program track with contiguous edges and the cameras untouched", async () => {
      const value = stack();
      const args = cut(2);
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
      const result = await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "cut-1" });
      expect(result).toMatchObject({ copied: true, verified: true, outcome: "verified", clipsCopied: 3 });
      expect(program(value, 2)).toEqual([["cam1", tick(0), tick(10), tick(1000)], ["cam2", tick(10), tick(20), tick(1010)], ["cam1", tick(20), tick(30), tick(1020)]]);
      // The first clone makes the new track in a transaction of its own.
      expect(value.project.executeTransaction).toHaveBeenCalledTimes(2);
      expect(result.undoSteps).toBe(2);
      expect(value.sequence.tracks.video[0]).toHaveLength(2);
      expect(value.sequence.tracks.video[1]).toHaveLength(1);
      expect(value.clone.mock.calls.map((call) => [call[2], call[3]])).toEqual([[2, 0], [1, 0], [2, 0]]);
    });

    it("trims clips that run across the cuts and places them exactly", async () => {
      const value = stack(true);
      const args = cut(2);
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
      const result = await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "cut-2" });
      expect(result).toMatchObject({ copied: true, verified: true, clipsTrimmed: 3 });
      expect(program(value, 2)).toEqual([["cam1", tick(0), tick(10), tick(1000)], ["cam2", tick(10), tick(20), tick(1010)], ["cam1", tick(20), tick(30), tick(1020)]]);
    });

    it("stops after the first clone when the program track was not created", async () => {
      const value = stack(false, { createsTrack: false });
      const args = cut(2);
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
      const result = await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "cut-nt" });
      expect(result).toMatchObject({ copied: false, committed: true, verified: false, outcome: "committed_unverified", undoSteps: 1 });
      expect(result.readbackError).toContain("did not create video track 2");
      // Only the first clone was made; the other two never ran.
      expect(value.clone).toHaveBeenCalledTimes(1);
      expect(value.project.executeTransaction).toHaveBeenCalledTimes(1);
    });

    it("parks long clips in bounded rounds that reuse one slot", async () => {
      // Two 1 hour cameras and 40 ten second cuts: parking every full-length clone end to end would take 40 hours.
      counter = 0;
      const cam = (id: string) => item("video", id, 0, 3600, 0, { name: id });
      const value = stack(false, { video: [[cam("cam1")], [cam("cam2")]] });
      const segments = Array.from({ length: 40 }, (_, n) => ({ sourceStartTicks: tick(n * 10), sourceEndTicks: tick(n * 10 + 10), videoTrack: n % 2 }));
      const args = cut(2, segments);
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
      const result = await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "cut-long" });
      expect(result).toMatchObject({ copied: true, verified: true, clipsTrimmed: 40 });
      expect(value.sequence.tracks.video[2]).toHaveLength(40);
      // Nothing ever sat further out than the cut, one gap and the 12 hour budget.
      expect(value.latestEnd()).toBeLessThanOrEqual(BigInt(tick(400 + 10 + 3600 * 12 + 3600)));
      // Rounds are capped at 4 parked clones (9 at once failed live), so 10 rounds: the program track, 10 trim and 10 place steps, 9 later parking steps and the rest of round 0.
      expect(result.undoSteps).toBe(31);
    });

    it("refuses a trimmed clip too long to park", async () => {
      const value = stack(false, { video: [[item("video", "cam1", 0, 13 * 3600, 0)], [item("video", "cam2", 0, 100, 0)]] });
      await expect(value.registry.dispatch("sequence.copyClips.inspect", cut(2, [{ sourceStartTicks: tick(5), sourceEndTicks: tick(10), videoTrack: 0 }])))
        .rejects.toMatchObject({ code: "UXP_TARGET_TOO_LARGE", noHostWrite: true });
    });

    it("cuts onto an existing empty track in one transaction", async () => {
      const value = stack();
      value.sequence.tracks.video.push([]);
      const args = cut(2);
      const plan = await value.registry.dispatch("sequence.copyClips.inspect", args);
      const result = await value.registry.dispatch("sequence.copyClips", { ...args, expectedSnapshot: plan, confirmCopy: true, operationId: "cut-3" });
      expect(result).toMatchObject({ verified: true, undoSteps: 1 });
      expect(value.project.executeTransaction).toHaveBeenCalledTimes(1);
    });

    it("refuses a busy program track, a missing track and a gap before any write", async () => {
      const busy = stack();
      await expect(busy.registry.dispatch("sequence.copyClips.inspect", cut(1, [{ sourceStartTicks: tick(0), sourceEndTicks: tick(10), videoTrack: 0 }])))
        .rejects.toMatchObject({ code: "UXP_TARGET_OCCUPIED", noHostWrite: true });
      await expect(stack().registry.dispatch("sequence.copyClips.inspect", cut(5))).rejects.toMatchObject({ code: "UXP_TARGET_UNSUPPORTED", noHostWrite: true });
      await expect(stack().registry.dispatch("sequence.copyClips.inspect", cut(2, [{ sourceStartTicks: tick(40), sourceEndTicks: tick(50), videoTrack: 0 }])))
        .rejects.toMatchObject({ code: "UXP_TARGET_NOT_FOUND", noHostWrite: true, message: expect.stringContaining("segments[0] has no clip") });
      expect(busy.project.executeTransaction).not.toHaveBeenCalled();
    });

    it("refuses overlapping segments, mixed arguments and the program track as a camera", async () => {
      const value = stack();
      const overlap = cut(2, [
        { sourceStartTicks: tick(0), sourceEndTicks: tick(10), videoTrack: 0 },
        { sourceStartTicks: tick(5), sourceEndTicks: tick(20), videoTrack: 1 },
      ]);
      await expect(value.registry.dispatch("sequence.copyClips.inspect", overlap)).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT", noHostWrite: true });
      await expect(value.registry.dispatch("sequence.copyClips.inspect", { ...cut(2), sourceStartTicks: tick(0) })).rejects.toMatchObject({ noHostWrite: true, message: expect.stringContaining("cannot be combined") });
      await expect(value.registry.dispatch("sequence.copyClips.inspect", cut(0))).rejects.toMatchObject({ noHostWrite: true, message: expect.stringContaining("program track itself") });
      await expect(value.registry.dispatch("sequence.copyClips.inspect", { ...cut(2), destinationSequenceId: "other" })).rejects.toMatchObject({ noHostWrite: true });
    });

    it("tags argument refusals on a plain copy as no-write too", async () => {
      const value = host();
      await expect(value.registry.dispatch("sequence.copyClips", { ...request(), operationId: "x" })).rejects.toMatchObject({ code: "UXP_CONFIRMATION_REQUIRED", noHostWrite: true });
    });
  });
});
