import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const TrackItems = require("../../uxp-plugin/track-items.cjs");

const at = (name: string, ticks: string | null, extra: Record<string, unknown> = {}) => ({ name, getStartTime: async () => (ticks === null ? { ticks: "x" } : { ticks }), ...extra });

describe("track item order (live 27.0 lists a razor half or clone last, in creation order)", () => {
  it("puts items in start-time order, keeping the host order for equal starts", async () => {
    const items = [at("a", "0"), at("c", "300"), at("b1", "100"), at("b2", "100"), at("late-half", "200")];
    expect((await TrackItems.sortByStart(items)).map((item: { name: string }) => item.name)).toEqual(["a", "b1", "b2", "late-half", "c"]);
  });

  it("compares large tick values exactly", async () => {
    const big = (n: bigint) => String(254016000000n * 3600n + n);
    const items = [at("later", big(2n)), at("earlier", big(1n))];
    expect((await TrackItems.sortByStart(items)).map((item: { name: string }) => item.name)).toEqual(["earlier", "later"]);
  });

  it("reads seconds when a start has no ticks", async () => {
    const items = [{ name: "b", getStartTime: async () => ({ seconds: 5 }) }, { name: "a", getStartTime: async () => ({ seconds: 1 }) }];
    expect((await TrackItems.sortByStart(items)).map((item: { name: string }) => item.name)).toEqual(["a", "b"]);
  });

  it("keeps the host order untouched when any start cannot be read, and handles empty input", async () => {
    const items = [at("b", "200"), at("bad", null), at("a", "100")];
    expect((await TrackItems.sortByStart(items)).map((item: { name: string }) => item.name)).toEqual(["b", "bad", "a"]);
    expect(await TrackItems.sortByStart(undefined)).toEqual([]);
    expect(await TrackItems.sortByStart([])).toEqual([]);
  });
});
