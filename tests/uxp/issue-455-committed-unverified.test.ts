import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const Commands = require("../../uxp-plugin/commands.cjs");
const Protocol = require("../../uxp-plugin/protocol.cjs");

// https://github.com/leancoderkavy/premiere-pro-mcp/issues/455
// When the host commits the transaction but produces a different result, the
// caller must be told the project already changed so it does not retry a
// destructive edit or abandon one that landed.
// The ripple-delete half of this issue is covered in ripple-delete-workflows.test.ts: the delete no
// longer trusts Premiere's own ripple flag, so there is no "committed but did not ripple" host to mock.

type SlipState = { start: number; end: number; inPoint: number; outPoint: number };

function slipHost(apply: (state: SlipState, inSeconds: number, outSeconds: number) => void, options: { canMove?: boolean } = {}) {
  const state: SlipState = { start: 10, end: 20, inPoint: 30, outPoint: 40 };
  const item = {
    getStartTime: vi.fn(async () => ({ seconds: state.start })),
    getEndTime: vi.fn(async () => ({ seconds: state.end })),
    getInPoint: vi.fn(async () => ({ seconds: state.inPoint })),
    getOutPoint: vi.fn(async () => ({ seconds: state.outPoint })),
    getDuration: vi.fn(async () => ({ seconds: state.end - state.start })),
    getSpeed: vi.fn(async () => 1),
    isSpeedReversed: vi.fn(async () => false),
    createSetInPointAction: vi.fn((time: { seconds: number }) => ({ kind: "in", seconds: time.seconds })),
    createSetOutPointAction: vi.fn((time: { seconds: number }) => ({ kind: "out", seconds: time.seconds })),
    ...(options.canMove ? { createMoveAction: vi.fn((time: { seconds: number }) => ({ kind: "move", seconds: time.seconds })) } : {}),
  };
  const pending: { kind: string; seconds: number }[] = [];
  const videoTrack = { getTrackItems: vi.fn(async () => [item]) };
  const sequence = {
    guid: "sequence-1",
    getTimebase: vi.fn(async () => "10160640000"),
    getVideoTrackCount: vi.fn(async () => 1),
    getVideoTrack: vi.fn(async () => videoTrack),
    getAudioTrackCount: vi.fn(async () => 0),
    getAudioTrack: vi.fn(async () => null),
  };
  const project = {
    guid: "project-1",
    getActiveSequence: vi.fn(async () => sequence),
    lockedAccess: vi.fn((callback: () => void) => callback()),
    executeTransaction: vi.fn((callback: (compound: { addAction: (action: { kind: string; seconds: number }) => boolean }) => void) => {
      pending.length = 0;
      callback({ addAction: (action) => { pending.push(action); return true; } });
      const move = pending.find((action) => action.kind === "move");
      if (move) {
        state.start += move.seconds;
        state.end += move.seconds;
        return true;
      }
      const inAction = pending.find((action) => action.kind === "in");
      const outAction = pending.find((action) => action.kind === "out");
      apply(state, inAction!.seconds, outAction!.seconds);
      return true;
    }),
  };
  const ppro = {
    Project: { getActiveProject: vi.fn(async () => project) },
    TickTime: { createWithSeconds: vi.fn((seconds: number) => ({ seconds })) },
    Constants: { TrackItemType: { CLIP: 1 } },
  };
  return { state, project, registry: Commands.createCommandRegistry({ ppro, Protocol }) };
}

const slipSnapshot = {
  projectGuid: "project-1", sequenceId: "sequence-1", mediaType: "video", trackIndex: 0, clipIndex: 0,
  startSeconds: 10, endSeconds: 20, inSeconds: 30, outSeconds: 40, durationSeconds: 10, speed: 1, reversed: false,
};

describe("issue #455 — a committed slip that lands wrong is not reported as a plain failure", () => {
  it("says the project already changed and describes the timeline move", async () => {
    // The host moves the whole item instead of only the source range.
    const host = slipHost((state, inSeconds, outSeconds) => {
      const offset = inSeconds - state.inPoint;
      state.inPoint = inSeconds;
      state.outPoint = outSeconds;
      state.start += offset;
      state.end += offset;
    });

    const failure = await host.registry.dispatch("trackItem.slip", {
      mediaType: "video", trackIndex: 0, clipIndex: 0,
      expectedSnapshot: slipSnapshot, slipBySeconds: 1, confirmSlip: true, operationId: "slip-1",
    });

    expect(failure).toMatchObject({ outcome: "committed_unverified", committed: true, verified: false,
      timelineChanged: true, rollbackPerformed: false, after: { startSeconds: 11, endSeconds: 21 } });
    expect(failure.readbackError).toContain("the project has already changed");
    expect(failure.readbackError).toContain("the timeline position moved (start 10s -> 11s, end 20s -> 21s)");
    expect(failure.readbackError).toContain("Do not retry this call");
    expect(host.state).toEqual({ start: 11, end: 21, inPoint: 31, outPoint: 41 });
  });

  it("moves the item back when the host applies in/out points like trims (Premiere 26.3/26.5)", async () => {
    // Measured on 26.5.2: the start follows the new in point and the end follows the new out point.
    const host = slipHost((state, inSeconds, outSeconds) => {
      state.start += inSeconds - state.inPoint;
      state.end += outSeconds - state.outPoint;
      state.inPoint = inSeconds;
      state.outPoint = outSeconds;
    }, { canMove: true });

    const result = await host.registry.dispatch("trackItem.slip", {
      mediaType: "video", trackIndex: 0, clipIndex: 0,
      expectedSnapshot: slipSnapshot, slipBySeconds: 1, confirmSlip: true, operationId: "slip-3",
    });

    expect(result).toMatchObject({ slipped: true, outcome: "verified", compensatingMoveSeconds: -1, undoSteps: 2,
      after: { startSeconds: 10, endSeconds: 20, inSeconds: 31, outSeconds: 41 } });
    expect(host.state).toEqual({ start: 10, end: 20, inPoint: 31, outPoint: 41 });
    expect(host.project.executeTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not compensate when the move landed somewhere other than the source change", async () => {
    // Only the start moved, so this is not the trim-like pattern and must stay unverified.
    const host = slipHost((state, inSeconds, outSeconds) => {
      state.start += 0.5;
      state.inPoint = inSeconds;
      state.outPoint = outSeconds;
    }, { canMove: true });

    await expect(host.registry.dispatch("trackItem.slip", {
      mediaType: "video", trackIndex: 0, clipIndex: 0,
      expectedSnapshot: slipSnapshot, slipBySeconds: 1, confirmSlip: true, operationId: "slip-4",
    })).resolves.toMatchObject({ outcome: "committed_unverified", committed: true });
    expect(host.project.executeTransaction).toHaveBeenCalledTimes(1);
  });

  it("still reports a correct slip as verified", async () => {
    const host = slipHost((state, inSeconds, outSeconds) => {
      state.inPoint = inSeconds;
      state.outPoint = outSeconds;
    });

    await expect(host.registry.dispatch("trackItem.slip", {
      mediaType: "video", trackIndex: 0, clipIndex: 0,
      expectedSnapshot: slipSnapshot, slipBySeconds: 1, confirmSlip: true, operationId: "slip-2",
    })).resolves.toMatchObject({ slipped: true, outcome: "verified" });
  });
});
