(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpTrackItems = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HostActions = typeof require === "function" ? require("./host-actions.cjs") : globalThis.PremiereMcpHostActions;

  // Premiere 27.0 returns Track.getTrackItems() in creation order once a clone, razor or paste has
  // appended a piece (live: a new right half listed last). Every clipIndex in this panel therefore
  // means "position in start-time order", and every read of a track goes through here.
  const TICKS_PER_SECOND = 254016000000;

  async function startTicks(item) {
    if (!item || typeof item.getStartTime !== "function") return null;
    try {
      const time = await item.getStartTime();
      const ticks = time && time.ticks != null ? String(time.ticks) : "";
      if (/^-?\d{1,30}$/.test(ticks)) return BigInt(ticks);
      const seconds = time && Number(time.seconds);
      return Number.isFinite(seconds) ? BigInt(Math.round(seconds * TICKS_PER_SECOND)) : null;
    } catch (_) { return null; }
  }

  // Items in start-time order (stable: equal starts keep the host's order). If any start cannot be read
  // the host's own order is kept, because a partial sort would be worse than none.
  async function sortByStart(items) {
    // Every track item the panel edits comes through here, so this is where its action factories learn to retry.
    const list = Array.from(items || []).map(HostActions.withActionRetry);
    if (list.length < 2) return list;
    const keyed = [];
    for (const item of list) keyed.push({ item, start: await startTicks(item), at: keyed.length });
    if (keyed.some(function (entry) { return entry.start === null; })) return list;
    keyed.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : a.at - b.at; });
    return keyed.map(function (entry) { return entry.item; });
  }

  return { sortByStart };
});
