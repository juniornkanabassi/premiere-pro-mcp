import type { UxpRequestOptions, UxpWebSocketBridge } from "../bridge/uxp-websocket-bridge.js";

// Premiere 27.0 UXP has no undo or redo command (probe: no menu or undo API), so
// this keeps a small MCP-side stack. It records only verified receipts of edits it
// knows how to reverse, replays the reverse through the same panel commands, and
// checks the live state first. Anything else is refused, never guessed.

const MAX_ENTRIES = 20;
const TIME_TOLERANCE = 0.002; // seconds, below one frame at any broadcast rate
const SOURCE_TOLERANCE = 0.05; // razor halves: source continuity, within a frame at 24 fps or faster

const CHECKPOINT_HINT = "Clone the sequence first (manage_sequences_uxp action clone) before overwrite, ripple delete or extract; undoing then means activating the clone.";

// Edits that change the project and cannot be reversed here. They are pushed so
// undo never skips past one and reverses an older edit underneath it.
const NOT_INVERTIBLE: Readonly<Record<string, string>> = {
  "timeline.overwrite": "Overwrite destroys the content it covered.",
  "timeline.removeSelection": "A removed clip cannot be cloned back with its effects.",
  "trackItem.rippleDelete": "A ripple-deleted clip cannot be cloned back with its effects.",
  "timeline.range.extract": "An extracted range cannot be cloned back with its effects.",
  "trackItems.remove": "A removed clip cannot be cloned back with its effects.",
  "timeline.insert": "Insert shifts later clips; no inverse is implemented in this build.",
  "timeline.cloneSelection": "No inverse is implemented for clone in this build.",
  "trackItem.splitEdit": "No inverse is implemented for J/L cuts in this build.",
  "markers.remove": "The receipt does not hold enough to re-create the marker.",
  "markers.removeMany": "The receipt does not hold enough to re-create the markers.",
};

type Json = Record<string, any>;
type Step = { command: string; args: Json };
interface Entry { id: number; command: string; label: string; args: Json; result: Json; reason: string | null; recordedAt: string }
interface UndoState { entries: Entry[]; nextId: number; dropped: number }
interface RequestFn { (command: string, args?: Record<string, unknown>, options?: UxpRequestOptions): Promise<unknown> }

const states = new WeakMap<object, UndoState>();
const observers = new WeakMap<object, UxpWebSocketBridge>();

function stateFor(raw: object): UndoState {
  let state = states.get(raw);
  if (!state) states.set(raw, state = { entries: [], nextId: 1, dropped: 0 });
  return state;
}

const near = (a: unknown, b: unknown, tolerance = TIME_TOLERANCE) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const refuse = (error: string) => ({ success: false as const, error, noHostWrite: true as const });

function describeEntry(entry: Entry) {
  return { id: entry.id, command: entry.command, label: entry.label, invertible: entry.reason === null, ...(entry.reason ? { reason: entry.reason, hint: CHECKPOINT_HINT } : {}), recordedAt: entry.recordedAt };
}

/** Records the receipt of a finished panel call. Failures and refusals never reach here. */
export function recordUxpEdit(raw: object, command: string, args: Json, result: unknown): void {
  if (!isObject(result)) return;
  let reason: string | null | undefined;
  let label = command;
  if (command === "trackItem.update") {
    const { before, after } = result;
    if (result.verified !== true || result.updated !== true || !isObject(before) || !isObject(after) || !stepsFor(before, after).changed) return;
    label = `Update ${after.mediaType} ${after.trackIndex}:${after.clipIndex}`;
  } else if (command === "trackItem.razor") {
    if (result.verified !== true) return;
    reason = args.allTracks === true ? "A cut across all tracks is not tracked clip by clip." : null;
    label = "Razor";
  } else if (command === "markers.add") {
    if (result.verified !== true || !isObject(result.marker) || typeof result.marker.guid !== "string") return;
    label = `Add marker ${String(result.marker.name ?? "")}`.trim();
  } else if (command in NOT_INVERTIBLE) {
    // A returned result means the host was written to, whether or not it verified.
    reason = NOT_INVERTIBLE[command];
  } else return;
  const state = stateFor(raw);
  state.entries.push({ id: state.nextId++, command, label, args, result, reason: reason ?? null, recordedAt: new Date().toISOString() });
  if (state.entries.length > MAX_ENTRIES) { state.entries.shift(); state.dropped += 1; }
}

/** Returns a bridge that reports every finished request to the undo stack. Replays use the raw bridge and are not recorded. */
export function observeUxpEdits(bridge: UxpWebSocketBridge): UxpWebSocketBridge {
  const existing = observers.get(bridge);
  if (existing) return existing;
  const proxy = new Proxy(bridge, {
    get(target, property, receiver) {
      if (property !== "request") return Reflect.get(target, property, receiver);
      const request: RequestFn = target.request.bind(target);
      return async (command: string, args: Record<string, unknown> = {}, options?: UxpRequestOptions) => {
        const result = await request(command, args, options);
        try { recordUxpEdit(bridge, command, args, result); } catch { /* recording must never fail an edit */ }
        return result;
      };
    },
  });
  observers.set(bridge, proxy);
  return proxy;
}

/** The fields to put back, as one `trackItem.update`. A pure move becomes a single relative move. */
function stepsFor(before: Json, after: Json) {
  const fields: Json = {};
  const startDelta = Number(before.startSeconds) - Number(after.startSeconds);
  const endDelta = Number(before.endSeconds) - Number(after.endSeconds);
  const inOutSame = near(before.inSeconds, after.inSeconds) && near(before.outSeconds, after.outSeconds);
  if (!near(startDelta, 0) || !near(endDelta, 0)) {
    if (near(startDelta, endDelta) && inOutSame) fields.moveBySeconds = startDelta;
    else {
      if (!near(startDelta, 0)) fields.startSeconds = before.startSeconds;
      if (!near(endDelta, 0)) fields.endSeconds = before.endSeconds;
    }
  }
  if (!near(before.inSeconds, after.inSeconds)) fields.inSeconds = before.inSeconds;
  if (!near(before.outSeconds, after.outSeconds)) fields.outSeconds = before.outSeconds;
  if (!same(before.disabled, after.disabled) && typeof before.disabled === "boolean") fields.disabled = before.disabled;
  if (!same(before.name, after.name) && typeof before.name === "string" && before.name) fields.name = before.name;
  return { fields, changed: Object.keys(fields).length > 0 };
}

const at = (snapshot: Json) => ({ mediaType: snapshot.mediaType, trackIndex: snapshot.trackIndex, clipIndex: snapshot.clipIndex });

class Refusal extends Error {}
const stop = (message: string): never => { throw new Refusal(message); };

async function planInverse(entry: Entry, request: RequestFn): Promise<Step[]> {
  const inspect = async (target: Json) => {
    const snapshot = await request("trackItem.inspect", target);
    return isObject(snapshot) ? snapshot : stop("Premiere returned no track item to compare against.");
  };

  if (entry.command === "trackItem.update") {
    const { before, after } = entry.result;
    const current = await inspect(at(after));
    const unchanged = near(current.startSeconds, after.startSeconds) && near(current.endSeconds, after.endSeconds)
      && near(current.inSeconds, after.inSeconds) && near(current.outSeconds, after.outSeconds)
      && same(current.disabled, after.disabled) && same(current.name, after.name);
    if (!unchanged) stop("The clip no longer matches the state this edit left it in; it was changed since. Inspect it and fix it by hand.");
    return [{ command: "trackItem.update", args: { ...at(after), expectedStartSeconds: after.startSeconds, expectedEndSeconds: after.endSeconds, ...stepsFor(before, after).fields } }];
  }

  if (entry.command === "trackItem.razor") {
    const { mediaType, trackIndex, clipIndex, timeSeconds } = entry.args;
    if (!mediaType || !Number.isInteger(trackIndex) || !Number.isInteger(clipIndex) || !Number.isFinite(timeSeconds)) stop("The razor receipt does not name its clip and time.");
    const left = await inspect({ mediaType, trackIndex, clipIndex });
    const right = await inspect({ mediaType, trackIndex, clipIndex: clipIndex + 1 });
    const joined = near(left.endSeconds, timeSeconds, SOURCE_TOLERANCE) && near(right.startSeconds, left.endSeconds, SOURCE_TOLERANCE) && near(right.inSeconds, left.outSeconds, SOURCE_TOLERANCE);
    if (!joined) stop("The two halves are no longer where the razor left them; it was changed since.");
    // Remove the right half first, then stretch the left half back over its range.
    return [
      { command: "trackItems.remove", args: { items: [{ mediaType, trackIndex, clipIndex: clipIndex + 1 }], ripple: false } },
      { command: "trackItem.update", args: { mediaType, trackIndex, clipIndex, expectedStartSeconds: left.startSeconds, expectedEndSeconds: left.endSeconds, endSeconds: right.endSeconds } },
    ];
  }

  if (entry.command === "markers.add") {
    const { marker } = entry.result;
    const owner: Json = {};
    for (const key of ["ownerType", "sequenceId", "projectItemId"]) if (entry.args[key] !== undefined) owner[key] = entry.args[key];
    // markers.remove checks the marker's GUID and name itself, so a changed marker is refused there.
    return [{ command: "markers.remove", args: { ...owner, markerGuid: marker.guid, expectedName: marker.name } }];
  }

  return stop(`No inverse is implemented for ${entry.command}.`);
}

export function getUxpUndoTools(bridge: UxpWebSocketBridge) {
  const request: RequestFn = (command, args, options) => bridge.request(command, args, options); // lazy: tool names are listed with no bridge
  return {
    inspect_undo_stack_uxp: {
      description: "List the edits this session can undo, newest first. Only verified edits that have a known inverse are undoable; overwrite, ripple delete and extract are listed as not undoable.",
      parameters: { type: "object" as const, additionalProperties: false, properties: {} },
      handler: async () => {
        const state = stateFor(bridge);
        return { success: true, data: { backend: "uxp", count: state.entries.length, droppedOldest: state.dropped, entries: [...state.entries].reverse().map(describeEntry) } };
      },
    },

    undo_last_edit_uxp: {
      description: "Undo the most recent recorded edit by replaying its inverse through documented UXP commands, after checking the clip still matches the receipt. Premiere 27.0 has no real undo; this is an MCP-side stack of at most 20 verified edits (clip update, razor, marker add). It cannot undo overwrite, ripple delete or extract, or anything done by hand in Premiere. For those, clone the sequence first.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          forget_uninvertible: { type: "boolean", description: "Drop the newest entry when it cannot be undone, keeping its change, so earlier entries become reachable. Does nothing else." },
        },
      },
      handler: async (args: { forget_uninvertible?: boolean }) => {
        const state = stateFor(bridge);
        const entry = state.entries[state.entries.length - 1];
        if (!entry) return refuse("Nothing to undo. This session has no recorded edit with a known inverse.");
        if (entry.reason) {
          if (args.forget_uninvertible === true) {
            state.entries.pop();
            return { success: true, data: { backend: "uxp", forgotten: describeEntry(entry), remaining: state.entries.length } };
          }
          return refuse(`Cannot undo "${entry.label}" (${entry.command}). ${entry.reason} ${CHECKPOINT_HINT} To reach earlier entries, call again with forget_uninvertible=true.`);
        }

        let steps: Step[];
        try { steps = await planInverse(entry, request); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return refuse(`Cannot undo "${entry.label}". ${message}`);
        }

        const done: Json[] = [];
        for (const step of steps) {
          try {
            const result = await request(step.command, step.args);
            done.push({ command: step.command, outcome: isObject(result) ? result.outcome ?? null : null, verified: isObject(result) && result.verified === true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!done.length) return { success: false, error: `Undo of "${entry.label}" failed before changing anything: ${message}` };
            state.entries.pop();
            return { success: false, error: `Undo of "${entry.label}" stopped part way after ${done.length} of ${steps.length} steps: ${message}. Inspect the timeline before doing anything else.`, partial: true, completedSteps: done };
          }
        }
        state.entries.pop();
        const verified = done.every((step) => step.verified);
        return { success: true, data: { backend: "uxp", undone: describeEntry(entry), outcome: verified ? "verified" : "committed_unverified", verified, steps: done, remaining: state.entries.length } };
      },
    },
  };
}
