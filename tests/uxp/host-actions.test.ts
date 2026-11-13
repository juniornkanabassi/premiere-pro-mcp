import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const HostActions = require("../../uxp-plugin/host-actions.cjs");
const TrackItems = require("../../uxp-plugin/track-items.cjs");

const STALE = "The script object is no longer valid.";

/** A host-shaped object: its action factory is a read-only prototype method, as on Premiere 27.0. */
function hostItem(factory: (...args: unknown[]) => unknown) {
  const proto = { getStartTime: async () => ({ ticks: "0" }) };
  Object.defineProperty(proto, "createMoveAction", { value: factory, writable: false, configurable: false });
  return Object.create(proto) as { createMoveAction: (...args: unknown[]) => unknown };
}

describe("action factories retry Premiere's spurious 'script object is no longer valid'", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes the same call again until the host accepts it, without touching the prototype", () => {
    let refusals = 2;
    const factory = vi.fn(function (this: unknown, by: unknown) { if (refusals-- > 0) throw new Error(STALE); return { by, self: this }; });
    const item = HostActions.withActionRetry(hostItem(factory));
    const result = item.createMoveAction("tick") as { by: unknown; self: unknown };
    expect(result).toEqual({ by: "tick", self: item });
    expect(factory).toHaveBeenCalledTimes(3);
    expect(Object.getPrototypeOf(item).createMoveAction).toBe(factory);
  });

  it("throws any other error at once, and gives up on a refusal that outlasts the budget", () => {
    const other = vi.fn(() => { throw new Error("Invalid parameter"); });
    expect(() => HostActions.withActionRetry(hostItem(other)).createMoveAction()).toThrow("Invalid parameter");
    expect(other).toHaveBeenCalledTimes(1);

    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 100));
    const stuck = vi.fn(() => { throw new Error(STALE); });
    expect(() => HostActions.withActionRetry(hostItem(stuck)).createMoveAction()).toThrow(STALE);
    expect(stuck.mock.calls.length).toBeGreaterThan(1);
    expect(stuck.mock.calls.length).toBeLessThan(20);
  });

  it("leaves a method the object has itself alone, and reaches every item read through a track", async () => {
    const own = { createMoveAction: vi.fn() };
    expect(HostActions.withActionRetry(own).createMoveAction).toBe(own.createMoveAction);
    let refusals = 1;
    const [item] = await TrackItems.sortByStart([hostItem(() => { if (refusals-- > 0) throw new Error(STALE); return "moved"; })]);
    expect(item.createMoveAction()).toBe("moved");
  });

  it("wraps the editors that SequenceEditor.getEditor hands out", () => {
    let refusals = 1;
    const editorProto = {};
    Object.defineProperty(editorProto, "createCloneTrackItemAction", { value: () => { if (refusals-- > 0) throw new Error(STALE); return "cloned"; } });
    const ppro = { SequenceEditor: { getEditor: () => Object.create(editorProto) } };
    expect(HostActions.installEditorRetry(ppro)).toBe(true);
    expect(HostActions.installEditorRetry(ppro)).toBe(false);
    expect(ppro.SequenceEditor.getEditor().createCloneTrackItemAction()).toBe("cloned");
  });
});
