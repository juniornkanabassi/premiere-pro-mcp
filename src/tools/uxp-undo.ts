import type { UxpRequestOptions, UxpWebSocketBridge } from "../bridge/uxp-websocket-bridge.js";

// Premiere 27.0 UXP has no undo or redo command (probe: no menu or undo API), so
// this keeps a small MCP-side stack. Every edit that could change the project is
// recorded: the ones it can reverse as verified receipts, everything else as a
// blocker, so undo never skips past an edit it cannot reverse and reverses an older
// one underneath it. An inverse runs only after checking the same project and
// sequence are still active and the clip still matches the receipt.

const MAX_ENTRIES = 20;
const MAX_SCAN = 512; // clips read when a moved clip has to be found again
const TIME_TOLERANCE = 0.002; // seconds, below one frame at any broadcast rate
const SOURCE_TOLERANCE = 0.05; // razor halves: source continuity, within a frame at 24 fps or faster

const CHECKPOINT_HINT = "Clone the sequence first (manage_sequences_uxp action clone) before overwrite, ripple delete or extract; undoing then means activating the clone.";

// Specific reasons. Any other mutating command gets the generic one.
const NOT_INVERTIBLE: Readonly<Record<string, string>> = {
  "timeline.overwrite": "Overwrite destroys the content it covered.",
  "timeline.removeSelection": "A removed clip cannot be cloned back with its effects.",
  "trackItem.rippleDelete": "A ripple-deleted clip cannot be cloned back with its effects.",
  "timeline.range.extract": "An extracted range cannot be cloned back with its effects.",
  "trackItems.remove": "A removed clip cannot be cloned back with its effects.",
  "timeline.insert": "Insert shifts later clips; no inverse is implemented in this build.",
  "timeline.cloneSelection": "No inverse is implemented for clone in this build.",
  "trackItem.clone": "No inverse is implemented for clone in this build.",
  "sequence.copyClips": "No inverse is implemented for copy clips in this build.",
  "trackItem.splitEdit": "No inverse is implemented for J/L cuts in this build.",
  "markers.remove": "The receipt does not hold enough to re-create the marker.",
  "markers.removeMany": "The receipt does not hold enough to re-create the markers.",
};

// Errors the bridge raises before anything reaches Premiere.
const LOCAL_REFUSALS = new Set(["UXP_NOT_CONNECTED", "UXP_COMMAND_UNSUPPORTED", "UXP_RECOVERY_REQUIRED", "UXP_SCHEMA_INCOMPATIBLE", "UXP_REPLAY_UNAVAILABLE", "UXP_COMMAND_TOO_LARGE"]);

type Json = Record<string, any>;
type Step = { command: string; args: Json };
type Identity = { sequenceId: string | null; projectKey: string | null };
interface Entry { id: number; command: string; label: string; args: Json; result: Json; reason: string | null; identity: Identity; recordedAt: string }
interface UndoState { entries: Entry[]; nextId: number; dropped: number; projectKey: string | null | undefined }
interface RequestFn { (command: string, args?: Record<string, unknown>, options?: UxpRequestOptions): Promise<unknown> }
interface Plan { steps: Step[]; verify: () => Promise<string | null> }

const states = new WeakMap<object, UndoState>();
const observers = new WeakMap<object, UxpWebSocketBridge>();
const locks = new WeakMap<object, Promise<unknown>>();

function stateFor(raw: object): UndoState {
  let state = states.get(raw);
  if (!state) states.set(raw, state = { entries: [], nextId: 1, dropped: 0, projectKey: undefined });
  return state;
}

const near = (a: unknown, b: unknown, tolerance = TIME_TOLERANCE) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const refuse = (error: string) => ({ success: false as const, error, noHostWrite: true as const });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const refusedBeforeWrite = (error: any) => error?.noHostWrite === true || error?.noHostDispatch === true || LOCAL_REFUSALS.has(error?.code);

function describeEntry(entry: Entry) {
  return { id: entry.id, command: entry.command, label: entry.label, invertible: entry.reason === null, ...(entry.reason ? { reason: entry.reason, hint: CHECKPOINT_HINT } : {}), recordedAt: entry.recordedAt };
}

/** Which sequence and project are active now. A part Premiere will not name is null, and undo refuses on null. */
async function readIdentity(request: RequestFn): Promise<Identity> {
  let sequenceId: string | null = null, projectKey: string | null = null;
  try {
    const id = (await request("sequences.inspect", {}) as Json)?.activeSequenceId;
    if (typeof id === "string" && id && id !== "[object Object]") sequenceId = id;
  } catch { /* stays null */ }
  try {
    const project = (await request("state.get", {}) as Json)?.project;
    const parts = [project?.id, project?.path].filter((part) => typeof part === "string" && part);
    if (parts.length) projectKey = parts.join("|");
  } catch { /* stays null */ }
  return { sequenceId, projectKey };
}

function isReadOnly(bridge: UxpWebSocketBridge, command: string): boolean {
  if (/^(?:capabilities\.get|state\.get|operations\.recovery\.|operation\.cancel)/.test(command)) return true;
  const known = (bridge.getState?.() as any)?.capabilities?.commands?.[command];
  // shortcut: a name check stands in when the panel's capability list is unavailable; a miss only records an extra blocker.
  return known ? known.readOnly === true : /\.(?:inspect|get)$/.test(command);
}

function pushEntry(state: UndoState, entry: Omit<Entry, "id" | "recordedAt">) {
  // A blocker carries no identity (reading it costs two extra panel calls after every edit); only a receipt names its project.
  if (entry.identity.projectKey) {
    if (state.projectKey !== undefined && state.projectKey !== entry.identity.projectKey && state.entries.length) { state.dropped += state.entries.length; state.entries = []; }
    state.projectKey = entry.identity.projectKey;
  }
  state.entries.push({ ...entry, id: state.nextId++, recordedAt: new Date().toISOString() });
  if (state.entries.length > MAX_ENTRIES) { state.entries.shift(); state.dropped += 1; }
}

/** What to put back after a clip update, as one `trackItem.update`. `lost` means a changed field cannot be restored. */
function restoration(before: Json, after: Json) {
  const fields: Json = {};
  let lost = false;
  const startDelta = Number(before.startSeconds) - Number(after.startSeconds);
  const endDelta = Number(before.endSeconds) - Number(after.endSeconds);
  const inDelta = Number(before.inSeconds) - Number(after.inSeconds);
  const outDelta = Number(before.outSeconds) - Number(after.outSeconds);
  const inOutSame = near(inDelta, 0) && near(outDelta, 0);
  if (!near(startDelta, 0) || !near(endDelta, 0)) {
    if (near(startDelta, endDelta) && inOutSame) fields.moveBySeconds = startDelta;
    else {
      if (!near(startDelta, 0)) fields.startSeconds = before.startSeconds;
      if (!near(endDelta, 0)) fields.endSeconds = before.endSeconds;
    }
  }
  // Premiere applies a start or end change like a trim and moves the source point with it, so a source point that followed its edge is not sent again (it would extend twice).
  if (!near(inDelta, 0) && !(fields.startSeconds !== undefined && near(inDelta, startDelta))) fields.inSeconds = before.inSeconds;
  if (!near(outDelta, 0) && !(fields.endSeconds !== undefined && near(outDelta, endDelta))) fields.outSeconds = before.outSeconds;
  if (!same(before.disabled, after.disabled)) typeof before.disabled === "boolean" ? fields.disabled = before.disabled : lost = true;
  if (!same(before.name, after.name)) typeof before.name === "string" && before.name ? fields.name = before.name : lost = true;
  return { fields, changed: Object.keys(fields).length > 0 || lost, lost };
}

async function record(bridge: UxpWebSocketBridge, request: RequestFn, command: string, args: Json, outcome: { result?: unknown; error?: unknown; failed: boolean }): Promise<void> {
  if (isReadOnly(bridge, command)) return;
  if (outcome.failed && refusedBeforeWrite(outcome.error)) return;
  const result = outcome.result;
  let reason: string | null = null;
  let label = command;
  if (outcome.failed) reason = `${command} failed with an uncertain outcome, so Premiere may have changed.`;
  else if (!isObject(result) || result.verified !== true) reason = `${command} did not report a verified result, so the timeline may not be what an undo would assume.`;
  else if (command === "trackItem.update") {
    const { before, after } = result;
    if (!isObject(before) || !isObject(after)) reason = "The update receipt has no before and after clip.";
    else {
      const plan = restoration(before, after);
      if (!plan.changed) return; // verified no-op
      label = `Update ${after.mediaType} ${after.trackIndex}:${before.clipIndex}`;
      if (plan.lost) reason = "A changed clip name or enabled state cannot be restored from the receipt.";
    }
  } else if (command === "trackItem.razor") {
    label = "Razor";
    const half = Array.isArray(result.halves) && result.halves.length === 1 ? result.halves[0] : null;
    if (args.allTracks === true) reason = "A cut across all tracks is not tracked clip by clip.";
    else if (!half || typeof half.projectItemId !== "string" || !Number.isFinite(half.rightEndSeconds) || !Number.isFinite(half.leftStartSeconds)
      || typeof result.cutTicks !== "string" || !Number.isFinite(result.cutSeconds)
      || !args.mediaType || !Number.isInteger(args.trackIndex) || !Number.isInteger(args.clipIndex)) reason = "The razor receipt does not name its clip, cut and source item.";
  } else if (command === "markers.add") {
    label = `Add marker ${String(result.marker?.name ?? "")}`.trim();
    if (typeof result.marker?.guid !== "string") reason = "The marker receipt has no GUID.";
  } else reason = NOT_INVERTIBLE[command] ?? `No inverse is implemented for ${command}.`;

  const identity = reason === null ? await readIdentity(request) : { sequenceId: null, projectKey: null };
  pushEntry(stateFor(bridge), { command, label, args, result: isObject(result) ? result : {}, reason, identity });
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
        let result: unknown;
        try { result = await request(command, args, options); }
        catch (error) {
          try { await record(bridge, request, command, args, { error, failed: true }); } catch { /* recording must never mask the error */ }
          throw error;
        }
        try { await record(bridge, request, command, args, { result, failed: false }); } catch { /* recording must never fail an edit */ }
        return result;
      };
    },
  });
  observers.set(bridge, proxy);
  return proxy;
}

class Refusal extends Error {}
const stop = (text: string): never => { throw new Refusal(text); };

// NTSC rates arrive as 29.97 and similar; use the exact n * 1000 / 1001.
function exactFrameRate(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const ntsc = [24, 25, 30, 48, 50, 60].map((nominal) => nominal * 1000 / 1001).find((candidate) => Math.abs(candidate - rate) < 0.01 && Math.abs(rate - Math.round(rate)) > 0.001);
  return ntsc ?? rate;
}

const at = (snapshot: Json) => ({ mediaType: snapshot.mediaType, trackIndex: snapshot.trackIndex });
const matches = (found: Json, wanted: Json) => near(found.startSeconds, wanted.startSeconds) && near(found.endSeconds, wanted.endSeconds)
  && near(found.inSeconds, wanted.inSeconds) && near(found.outSeconds, wanted.outSeconds) && same(found.disabled, wanted.disabled) && same(found.name, wanted.name);

async function inspectAt(request: RequestFn, track: Json, clipIndex: number): Promise<Json | null> {
  try { const snapshot = await request("trackItem.inspect", { ...at(track), clipIndex }); return isObject(snapshot) ? snapshot : null; } catch { return null; }
}

/** Finds a clip by its state. A move can change its index, so scan the track when it is not where it was. */
async function locate(request: RequestFn, wanted: Json, hintIndex: number): Promise<{ clipIndex: number; snapshot: Json } | null> {
  const first = await inspectAt(request, wanted, hintIndex);
  if (first && matches(first, wanted)) return { clipIndex: hintIndex, snapshot: first };
  const found: Array<{ clipIndex: number; snapshot: Json }> = [];
  for (let clipIndex = 0; clipIndex < MAX_SCAN; clipIndex += 1) {
    const snapshot = await inspectAt(request, wanted, clipIndex);
    if (!snapshot) break;
    if (matches(snapshot, wanted)) found.push({ clipIndex, snapshot });
  }
  return found.length === 1 ? found[0] : null;
}

async function planInverse(entry: Entry, request: RequestFn): Promise<Plan> {
  const operationId = (step: number) => `undo-${entry.id}-${Date.now()}-${step}`;

  if (entry.command === "trackItem.update") {
    const { before, after } = entry.result;
    const current = await locate(request, after, before.clipIndex);
    if (!current) stop("The clip is no longer where and how this edit left it; it was changed since. Inspect it and fix it by hand.");
    const found = current!;
    const fields = restoration(before, after).fields;
    return {
      steps: [{ command: "trackItem.update", args: { ...at(after), clipIndex: found.clipIndex, expectedStartSeconds: found.snapshot.startSeconds, expectedEndSeconds: found.snapshot.endSeconds, ...fields, operationId: operationId(1) } }],
      verify: async () => (await locate(request, before, found.clipIndex)) ? null : "The clip does not read back as it was before the edit.",
    };
  }

  if (entry.command === "trackItem.razor") {
    const { mediaType, trackIndex, clipIndex } = entry.args;
    const { cutSeconds } = entry.result, half = entry.result.halves[0];
    const track = { mediaType, trackIndex };
    // The left half is stretched with an end time Premiere snaps to its frame grid, so an end between frames would overwrite up to half a frame of the next clip.
    const fps = exactFrameRate(Number(((await request("sequenceSettings.get", {}).catch(() => null)) as Json)?.settings?.videoFrameRate));
    if (!fps) stop("Premiere would not report the sequence frame rate, so the original clip end cannot be checked against the frame grid.");
    if (Math.abs(half.rightEndSeconds * fps! - Math.round(half.rightEndSeconds * fps!)) > 0.01) stop("The original clip end is not on a whole frame, so it cannot be restored exactly. Nothing was changed.");
    const left = await inspectAt(request, track, clipIndex), right = await inspectAt(request, track, clipIndex + 1);
    if (!left || !right) stop("Premiere returned no clip to compare against.");
    const joined = near(left!.startSeconds, half.leftStartSeconds, SOURCE_TOLERANCE) && near(left!.endSeconds, cutSeconds, SOURCE_TOLERANCE)
      && near(right!.startSeconds, cutSeconds, SOURCE_TOLERANCE) && near(right!.endSeconds, half.rightEndSeconds, SOURCE_TOLERANCE) && near(right!.inSeconds, left!.outSeconds, SOURCE_TOLERANCE);
    if (!joined) stop("The two halves are no longer where the razor left them; it was changed since.");
    // Remove the right half (guarded by its source item and start tick), then stretch the left half back over its range.
    return {
      steps: [
        { command: "trackItems.remove", args: { items: [{ mediaType, trackIndex, clipIndex: clipIndex + 1, expectedProjectItemId: half.projectItemId, expectedStartSeconds: cutSeconds }], ripple: false, confirmRemove: true, operationId: operationId(1) } },
        { command: "trackItem.update", args: { mediaType, trackIndex, clipIndex, expectedStartSeconds: left!.startSeconds, expectedEndSeconds: left!.endSeconds, endSeconds: half.rightEndSeconds, operationId: operationId(2) } },
      ],
      verify: async () => {
        const whole = await inspectAt(request, track, clipIndex), next = await inspectAt(request, track, clipIndex + 1);
        if (!whole || !near(whole.startSeconds, left!.startSeconds, SOURCE_TOLERANCE) || !near(whole.endSeconds, half.rightEndSeconds, SOURCE_TOLERANCE) || !near(whole.outSeconds, right!.outSeconds, SOURCE_TOLERANCE)) return "The clip does not read back as one whole clip.";
        return next && near(next.startSeconds, cutSeconds, SOURCE_TOLERANCE) ? "A clip still starts at the razor cut." : null;
      },
    };
  }

  if (entry.command === "markers.add") {
    const { marker } = entry.result;
    const owner: Json = {};
    for (const key of ["ownerType", "sequenceId", "projectItemId"]) if (entry.args[key] !== undefined) owner[key] = entry.args[key];
    // markers.remove checks the marker's GUID and name itself, so a changed marker is refused there, and it reads the removal back.
    return { steps: [{ command: "markers.remove", args: { ...owner, markerGuid: marker.guid, expectedName: marker.name, operationId: operationId(1) } }], verify: async () => null };
  }

  return stop(`No inverse is implemented for ${entry.command}.`);
}

export function getUxpUndoTools(bridge: UxpWebSocketBridge) {
  const request: RequestFn = (command, args, options) => bridge.request(command, args, options); // lazy: tool names are listed with no bridge

  // After the project changes the stack no longer describes anything on screen.
  const dropIfProjectChanged = (state: UndoState, current: Identity) => {
    if (state.projectKey !== undefined && state.projectKey !== current.projectKey && state.entries.length) { state.dropped += state.entries.length; state.entries = []; }
    state.projectKey = current.projectKey;
  };
  const without = (state: UndoState, entry: Entry) => { state.entries = state.entries.filter((candidate) => candidate.id !== entry.id); };
  const block = (state: UndoState, entry: Entry, why: string) => {
    without(state, entry);
    pushEntry(state, { command: entry.command, label: `Undo of ${entry.label}`, args: {}, result: {}, reason: why, identity: entry.identity });
  };

  async function undoLast(forget: boolean) {
    const state = stateFor(bridge);
    const current = await readIdentity(request);
    dropIfProjectChanged(state, current);
    const entry = state.entries[state.entries.length - 1];
    if (!entry) return refuse("Nothing to undo. This session has no recorded edit with a known inverse for the open project.");
    if (entry.reason) {
      if (forget) {
        without(state, entry);
        return { success: true, data: { backend: "uxp", forgotten: describeEntry(entry), remaining: state.entries.length } };
      }
      return refuse(`Cannot undo "${entry.label}" (${entry.command}). ${entry.reason} ${CHECKPOINT_HINT} To reach earlier entries, call again with forget_uninvertible=true.`);
    }
    if (!entry.identity.sequenceId || !entry.identity.projectKey || !current.sequenceId) {
      return refuse(`Cannot undo "${entry.label}". Premiere would not name the project or sequence, so it cannot be checked that this is where the edit was made.`);
    }
    if (entry.identity.sequenceId !== current.sequenceId) return refuse(`Cannot undo "${entry.label}". It was made in another sequence than the one active now; activate that sequence first.`);

    let plan: Plan;
    try { plan = await planInverse(entry, request); }
    catch (error) { return refuse(`Cannot undo "${entry.label}". ${message(error)}`); }

    const done: Json[] = [];
    for (const step of plan.steps) {
      let result: unknown;
      try { result = await request(step.command, step.args); }
      catch (error) {
        if (!done.length && refusedBeforeWrite(error)) return { success: false, error: `Undo of "${entry.label}" failed before changing anything: ${message(error)}`, noHostWrite: true };
        block(state, entry, `An undo of this edit failed part way (${message(error)}), so the timeline is in an uncertain state.`);
        return { success: false, error: `Undo of "${entry.label}" may have partly applied (${done.length} of ${plan.steps.length} steps confirmed): ${message(error)}. Inspect the timeline before doing anything else.`, partial: true, completedSteps: done };
      }
      const verified = isObject(result) && result.verified === true;
      done.push({ command: step.command, outcome: isObject(result) ? result.outcome ?? null : null, verified });
      if (!verified) {
        block(state, entry, "An undo of this edit stopped at a step Premiere could not verify, so the timeline is in an uncertain state.");
        return { success: false, error: `Undo of "${entry.label}" stopped: ${step.command} did not verify. Inspect the timeline before doing anything else.`, partial: true, completedSteps: done };
      }
    }
    const problem = await plan.verify().catch((error) => `The final readback failed: ${message(error)}`);
    if (problem) {
      block(state, entry, `An undo of this edit could not be confirmed (${problem}).`);
      return { success: false, error: `Undo of "${entry.label}" ran but could not be confirmed: ${problem} Inspect the timeline before doing anything else.`, outcome: "committed_unverified", completedSteps: done };
    }
    without(state, entry);
    return { success: true, data: { backend: "uxp", undone: describeEntry(entry), outcome: "verified", verified: true, steps: done, remaining: state.entries.length } };
  }

  return {
    inspect_undo_stack_uxp: {
      description: "List the edits this session can undo, newest first, for the open project. Only verified edits that have a known inverse are undoable; every other edit that could change the project is listed as not undoable and blocks the ones under it.",
      parameters: { type: "object" as const, additionalProperties: false, properties: {} },
      handler: async () => {
        const state = stateFor(bridge);
        dropIfProjectChanged(state, await readIdentity(request));
        return { success: true, data: { backend: "uxp", count: state.entries.length, droppedOldest: state.dropped, entries: [...state.entries].reverse().map(describeEntry) } };
      },
    },

    undo_last_edit_uxp: {
      description: "Undo the most recent recorded edit by replaying its inverse through documented UXP commands, after checking the same project and sequence are active and the clip still matches the receipt, then reading the result back. Premiere 27.0 has no real undo; this is an MCP-side stack of at most 20 edits (clip update, single-clip razor, marker add). It cannot undo anything else (overwrite, ripple delete, extract, unverified edits), nor anything done by hand in Premiere. For those, clone the sequence first.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          forget_uninvertible: { type: "boolean", description: "Drop the newest entry when it cannot be undone, keeping its change, so earlier entries become reachable. Does nothing else." },
        },
      },
      // One undo at a time: two calls must not both pick the same entry.
      handler: (args: { forget_uninvertible?: boolean }) => {
        const run = (locks.get(bridge) ?? Promise.resolve()).then(() => undoLast(args.forget_uninvertible === true));
        locks.set(bridge, run.catch(() => undefined));
        return run;
      },
    },
  };
}
