import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { companionWriter, isCompanionRead, setCompanionReadOnly } from "../companion-policy.js";
import { markHostDispatch } from "../workflows/invocation-context.js";
import { getTranscriptWordEditTools } from "./transcript-word-edits.js";

// The CLI exits immediately after printing; a file descriptor prevents pipe truncation.
async function execute(cli: string, argv: string[]): Promise<{ stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), "premiere-companion-"));
  try {
    const stdoutPath = join(dir, "stdout");
    const stderrPath = join(dir, "stderr");
    const stdoutFile = await open(stdoutPath, "w", 0o600);
    const stderrFile = await open(stderrPath, "w", 0o600);
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...argv], { stdio: ["ignore", stdoutFile.fd, stderrFile.fd], timeout: 3900000 });
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally { await stdoutFile.close(); await stderrFile.close(); }
    if ((await stat(stdoutPath)).size > 16 * 1024 * 1024 || (await stat(stderrPath)).size > 16 * 1024 * 1024) throw new Error("Companion output exceeds 16 MiB; inspect a narrower scope");
    const stdout = await readFile(stdoutPath, "utf8");
    if (code !== 0) throw Object.assign(new Error("Companion command failed"), { code, killed: code === null, stdout, stderr: await readFile(stderrPath, "utf8") });
    return { stdout };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
interface Schema { type: string; enum?: unknown[]; minLength?: number; minItems?: number; items?: Schema }
interface CompanionTool {
  name: string; description: string; argv: string[]; positional: string[]; readOnly?: boolean;
  inputSchema: { type: string; properties: Record<string, Schema>; required?: string[]; additionalProperties: boolean };
}

export function companionArguments(tool: CompanionTool, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Arguments must be an object");
  const args = input as Record<string, unknown>;
  const validate = (value: unknown, schema: Schema): void => {
    if (schema.type === "array") {
      if (!Array.isArray(value) || !schema.items || value.length < (schema.minItems ?? 0)) throw new Error("Invalid array");
      value.forEach(item => validate(item, schema.items!));
    } else if (schema.type === "integer" ? !Number.isInteger(value) : typeof value !== schema.type) throw new Error("Invalid argument type");
    if (typeof value === "string" && ((value.startsWith("-") && !/^-\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) || value.includes("\0") || value.length < (schema.minLength ?? 0))) throw new Error("Unsafe or empty argument");
    if (schema.enum && !schema.enum.includes(value)) throw new Error("Invalid argument enum");
  };
  for (const key of tool.inputSchema.required ?? []) if (!Object.hasOwn(args, key)) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error(`Unknown ${key}`);
    validate(value, tool.inputSchema.properties[key]);
  }
  const argv = [...tool.argv];
  for (const key of tool.positional) if (Object.hasOwn(args, key)) argv.push(...(Array.isArray(args[key]) ? args[key] as string[] : [String(args[key])]));
  for (const [key, value] of Object.entries(args)) {
    if (tool.positional.includes(key) || value === false) continue;
    const flag = "--" + key.replace(/[A-Z]/g, c => "-" + c.toLowerCase());
    if (value === true) argv.push(flag);
    else for (const item of Array.isArray(value) ? value : [value]) argv.push(flag, String(item));
  }
  return [...argv, "--json"];
}

// Manifest properties that arrive without a description get their unit and index base here; a manifest description always wins.
const PROPERTY_HINTS: Record<string, string> = {
  sequence: "Sequence name, as companion_sequence_list shows it.",
  seq: "Sequence name, as companion_sequence_list shows it.",
  track: "Track name: V1, V2... for video, A1, A2... for audio (numbered from 1).",
  index: "Track item index on that track, counted from 0 in start-time order (as companion_timeline lists them).",
  at: "Time in seconds (like 12.5) or timecode HH:MM:SS:FF.",
  in: "Time in seconds (like 12.5) or timecode HH:MM:SS:FF.",
  out: "Time in seconds (like 12.5) or timecode HH:MM:SS:FF.",
  start: "Time in seconds (like 12.5) or timecode HH:MM:SS:FF.",
  id: "Job or export id from an earlier Companion result (jobId).",
};
// out is a trim time beside in (edit, place, sequence_inout) and a destination file everywhere else (export, export_frame, transcript_export, first_cut).
const OUT_FILE = "Output file path.";
function describeProperties(schema: CompanionTool["inputSchema"]): CompanionTool["inputSchema"] {
  const hint = (key: string) => key === "out" && !Object.hasOwn(schema.properties, "in") ? OUT_FILE : PROPERTY_HINTS[key];
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) =>
    [key, (value as { description?: string }).description || !hint(key) ? value : { ...value, description: hint(key) }])) };
}

export const DETAIL_LIMIT = 24_000;
const PIECE = 2_000; // a list or object larger than this is split into its items or fields when paging
const EXCERPT = 3_000; // room kept beside every page for the failed-row excerpt
type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
// A row that reports a failure; capping keeps these before ordinary rows so a cap never hides one.
const failedRow = (item: unknown): boolean => { const row = record(item); return !!row && (row.ok === false || (row.error !== undefined && row.error !== null) || /fail|error|refused|unknown/i.test(String(row.state ?? row.status ?? ""))); };
const count = (list: unknown[]) => { const failed = list.filter(failedRow).length; return `${list.length} item(s)${failed ? `, ${failed} failed` : ""}`; };
// One line per field: scalars as they are, lists as a count. Enough for "what changed" without the payload.
function brief(value: unknown): unknown {
  const object = record(value);
  if (!object) return Array.isArray(value) ? count(value) : typeof value === "string" ? value.slice(0, 160) : value ?? null;
  return Object.fromEntries(Object.entries(object).slice(0, 12).map(([key, field]) =>
    [key, Array.isArray(field) ? count(field) : record(field) ? "{...}" : typeof field === "string" ? field.slice(0, 160) : field]));
}
// Long strings are replaced, never cut: a cut JSON string (a transcript) reads as content but cannot be parsed.
function shrink(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 400 ? `[${value.length} characters omitted]` : value;
  if (Array.isArray(value)) {
    if (depth > 5) return count(value);
    const keep = new Set(value.flatMap((item, i) => failedRow(item) ? [i] : []).slice(0, 50));
    for (let i = 0; keep.size < 50 && i < value.length; i++) keep.add(i);
    const kept = value.filter((_, i) => keep.has(i)).map(item => shrink(item, depth + 1));
    return value.length > 50 ? [...kept, `... ${value.length - 50} more (failed rows kept first)`] : kept;
  }
  const object = record(value);
  return !object ? value : depth > 5 ? "{...}" : Object.fromEntries(Object.entries(object).map(([key, field]) => [key, shrink(field, depth + 1)]));
}

type Piece = { path: (string | number)[]; value: unknown };
// Characters a value takes in the server's pretty-printed text result at that nesting depth (two spaces per level).
const printed = (value: unknown, depth: number) => { const text = JSON.stringify(value, null, 2) ?? "null"; return text.length + 2 * depth * text.split("\n").length; };
// The payload as complete pieces in order, each with its path in the full result: a large container is split, a value never cut.
function pieces(value: unknown, path: Piece["path"] = [], out: Piece[] = []): Piece[] {
  if ((Array.isArray(value) || record(value)) && JSON.stringify(value).length > PIECE)
    Object.entries(value as object).forEach(([key, field]) => pieces(field, [...path, Array.isArray(value) ? Number(key) : key], out));
  else out.push({ path, value });
  return out;
}
function paginate(payload: unknown): Piece[][] {
  const pages: Piece[][] = [[]];
  let size = 0;
  for (const piece of pieces(payload)) {
    const length = printed(piece, 3) + 2; // data.detail.pieces[i]
    if (size + length > DETAIL_LIMIT - EXCERPT && pages.at(-1)!.length) { pages.push([]); size = 0; }
    pages.at(-1)!.push(piece); size += length;
  }
  return pages;
}
// Every failed row anywhere in the payload with its path, so a late failure is never reduced to a count.
function failures(value: unknown, path: Piece["path"] = [], out: Piece[] = []): Piece[] {
  if (path.length && failedRow(value)) out.push({ path, value });
  else if (Array.isArray(value) || record(value)) Object.entries(value as object).forEach(([key, field]) => failures(field, [...path, Array.isArray(value) ? Number(key) : key], out));
  return out;
}
function failedExcerpt(payload: unknown) {
  const all = failures(payload), rows: unknown[] = [];
  for (const row of all) {
    const fits = (candidate: unknown) => printed([...rows, candidate], 3) <= EXCERPT - 200; // data.truncated.failed.rows
    const full = { path: row.path, value: shrink(row.value) };
    if (fits(full)) rows.push(full); else if (fits({ path: row.path })) rows.push({ path: row.path }); else break;
  }
  return all.length ? { count: all.length, rows } : undefined;
}
// These two write their whole result to a new file when given out, so a capped answer points there instead of paging.
const FILE_ROUTE = new Set(["transcript_export", "first_cut"]);

/** The small, consistent receipt every Companion-backed result carries, with the payload capped. */
export function companionReceipt(tool: CompanionTool, args: Json, output: unknown, toolWrites: boolean, ok = true, page = 1): Json {
  // Invocation modes of writer commands that change nothing: autosync status only reads, first_cut without out only plans.
  const writes = toolWrites && !(tool.name === "autosync" && args.mode === "status");
  // Companion answers with an envelope (state, jobId / exportId / refreshId, result, plus fields such as an export's paths)
  // or, for presets, roots, colour and first-cut, with the bare value itself.
  const out = record(output);
  const envelope = out && ["state", "jobId", "exportId", "refreshId"].some(key => Object.hasOwn(out, key)) ? out : undefined;
  const { state: rawState, jobId, exportId, refreshId, error: rawError, result, ...meta } = envelope ?? {};
  const payload = !envelope ? output : Object.keys(meta).length ? { ...meta, ...(result !== undefined ? { result } : {}) } : result;
  const state = typeof rawState === "string" ? rawState : undefined;
  const error = record(rawError) ?? (typeof rawError === "string" ? { message: rawError } : undefined);
  const size = JSON.stringify(payload ?? null).length;
  // Nothing an agent must act on is dropped unless the receipt names a working route to exactly that content.
  let detail = payload;
  let truncated: Json | undefined;
  const lookup = exportId != null ? { tool: "companion_export_status", arguments: { id: exportId } }
    : jobId != null ? { tool: "companion_job", arguments: { id: jobId } }
    : !writes ? { tool: "companion_" + tool.name, arguments: args } : undefined;
  if (size > DETAIL_LIMIT && FILE_ROUTE.has(tool.name)) {
    detail = shrink(payload);
    if (JSON.stringify(detail ?? null).length > DETAIL_LIMIT) detail = brief(payload);
    truncated = { characters: size, limit: DETAIL_LIMIT, note: typeof args.out === "string"
      ? `Capped here; the whole result is in ${args.out}. Read that file with your own file tool (with Junior's approval).`
      : `Capped: long text is replaced by its length and lists are shortened. For the whole result call companion_${tool.name} again with the same arguments plus out (a new file path), then read that file with your own file tool (with Junior's approval).` };
  } else if (size > DETAIL_LIMIT && lookup) {
    const pages = paginate(payload), at = Math.min(page, pages.length), failed = failedExcerpt(payload);
    detail = { page: at, pages: pages.length, pieces: pages[at - 1] };
    truncated = { characters: size, limit: DETAIL_LIMIT, page: at, pages: pages.length,
      next: at < pages.length ? { tool: lookup.tool, arguments: { ...lookup.arguments, page: at + 1 } } : null,
      note: "Split into pages of complete pieces, each with its path in the full result; nothing is cut or left out. Call next for the following page.",
      ...(failed ? { failed } : {}) };
  }
  // shortcut: a large write result with no id and no file route is returned whole (no route could fetch a dropped part); page it if one appears.
  const finished = ok && (state === "done" || (state === undefined && !error));
  const pending = ok && (state === "queued" || state === "running");
  // A dry run: the tool takes apply and it was not passed, or audio_level was asked only to measure.
  const preview = writes && ((Object.hasOwn(tool.inputSchema.properties, "apply") && args.apply !== true) || args.measureOnly === true || (tool.name === "first_cut" && args.out === undefined));
  const recovery = exportId != null ? { kind: "exportId", id: exportId, lookup: "companion_export_status" }
    : jobId != null ? { kind: "jobId", id: jobId, lookup: "companion_job" }
    : refreshId != null ? { kind: "refreshId", id: refreshId, lookup: null, note: "No tool looks up a refresh id, and calling companion_refresh again queues another pass, so do not. Wait for this one: companion_status shows it under projects (running, then last); companion_bins shows the files." }
    : null;
  const payloadRecord = record(result) ?? record(payload);
  return {
    command: tool.argv.join(" "),
    writer: writes ? "premiere-companion" : null,
    target: {
      project: args.project ?? payloadRecord?.project ?? "the single project Companion has granted",
      ...(args.sequence ?? args.seq ?? payloadRecord?.sequence ? { sequence: args.sequence ?? args.seq ?? payloadRecord?.sequence } : {}),
    },
    state: state ?? null,
    jobId: jobId ?? exportId ?? null,
    recovery,
    changed: !writes ? "nothing (read-only)" : preview && finished ? "nothing (preview)" : finished ? brief(result ?? payload) ?? "done" : pending ? "accepted, not finished yet" : "nothing confirmed",
    verified: !writes ? "read directly through Companion"
      : preview && finished ? "preview only: nothing was changed in Premiere"
      : finished ? "Companion reported done. This result carries no read-back of Premiere: check with companion_timeline, companion_bins or companion_marker_list before relying on it. Picture and sound were not rendered or checked."
      : pending ? (recovery?.lookup ? `not yet: poll ${recovery.lookup} with id ${String(recovery.id)} until it is done` : `not yet: ${recovery?.note ?? "no id was returned; read back the project before any dependent edit"}`)
      : state === "unknown" ? "outcome unknown: do not retry; read companion_job and the timeline before any dependent edit"
      : "nothing was confirmed",
    // Read by the server's mutation receipt (outcome, accepted); no top-level "result" key, so it reads these fields.
    ...(writes && finished ? { outcome: preview ? "not_applied" : "committed_unverified" } : {}),
    ...(toolWrites && !writes && ok ? { outcome: "not_applied" } : {}),
    ...(writes && pending ? { outcome: "committed_unverified", accepted: true } : {}),
    ...(writes && (state === "guard-refused" || state === "no-panel") ? { outcome: "not_applied" } : {}),
    ...(error ? { error } : {}),
    detail: detail ?? null,
    ...(truncated ? { truncated } : {}),
  };
}

const COMPANION_ROUTE = {
  routes: { companion: ["companion_stringout"] },
  next_steps: [
    "Review removal_ranges and keep_ranges (source seconds from the clip's first frame).",
    "Write keep_ranges into a Companion cut list and build it into a new sequence with a Companion command; nothing has changed in Premiere yet.",
  ],
};
// The word planners as the Shorts profile shows them: Companion names clips, not project-item IDs, and has no transcript revision.
function companionPlanners() {
  const planners = getTranscriptWordEditTools();
  return Object.fromEntries((["detect_repeated_takes", "plan_pause_tightening", "plan_filler_word_removal"] as const).map(name => {
    const planner = planners[name];
    const timeline = planner.parameters.properties.word_timeline;
    return [name, {
      ...planner,
      description: planner.description.replace(/ Returns (.*?)apply routes\./, " Returns $1a Companion route.") + " Build word_timeline from companion_transcript_export: each word as text, start_seconds and end_seconds from the clip's first frame. Pass the sequence fps as frame_rate.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      parameters: { ...planner.parameters, properties: { ...planner.parameters.properties, word_timeline: {
        ...timeline,
        description: "Word-timed transcript of one clip, in source seconds from its first frame.",
        properties: { ...timeline.properties,
          source_project_item_id: { ...timeline.properties.source_project_item_id, description: "The clip name or media path, as Companion names it." },
          transcript_revision: { ...timeline.properties.transcript_revision, description: "Optional; derived from the words when left out." } },
        required: ["source_project_item_id", "words"],
      } } },
      handler: async (args: Record<string, unknown>) => {
        const timelineArg = record(args?.word_timeline);
        const revision = timelineArg && timelineArg.transcript_revision === undefined
          ? { transcript_revision: "sha256:" + createHash("sha256").update(JSON.stringify(timelineArg.words ?? null)).digest("hex") } : {};
        const outcome = await planner.handler({ ...args, ...(timelineArg ? { word_timeline: { ...timelineArg, ...revision } } : {}) } as never);
        return outcome.success ? { success: true, data: { ...(record(outcome.data) ?? {}), ...COMPANION_ROUTE } } : outcome;
      },
    }];
  }));
}

export function getCompanionTools(cli = process.env.PREMIERE_COMPANION_CLI) {
  if (!cli) return {};
  if (!isAbsolute(cli)) throw new Error("PREMIERE_COMPANION_CLI must be an absolute .mjs path");
  const writer = companionWriter();
  const manifest = JSON.parse(execFileSync(process.execPath, [cli, "mcp-manifest"], { encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 }));
  if (manifest.name !== "premiere-companion" || !Array.isArray(manifest.tools)) throw new Error("Invalid Premiere Companion manifest");
  const seen = new Set<string>();
  setCompanionReadOnly(manifest.tools as CompanionTool[]);
  const tools = Object.fromEntries((manifest.tools as CompanionTool[]).map(tool => {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || seen.has(tool.name) || !Array.isArray(tool.argv) || !tool.argv.every(x => typeof x === "string") || !Array.isArray(tool.positional) || !tool.inputSchema?.properties) throw new Error("Invalid or duplicate Companion tool");
    seen.add(tool.name);
    const name = "companion_" + tool.name;
    const writes = !isCompanionRead(tool);
    const parameters = describeProperties(tool.inputSchema);
    return [name, {
      description: `Premiere Companion: ${tool.description} ${writes ? "Writes through Companion's grant, locks and job queue. Never retry an unknown outcome." : "Read-only."}`,
      parameters: writes ? parameters : { ...parameters, properties: { ...parameters.properties, page: { type: "integer", minimum: 1, description: "Page of a long result, as truncated.next gives it; default 1." } } },
      annotations: { readOnlyHint: !writes },
      operationalCapability: {
        backend: "orchestrator", backends: ["orchestrator"], status: "supported",
        verificationBoundary: "bridge_response", hostVerificationRequired: true,
        notes: ["Uses the existing Companion CLI and its own grant, queue and readback checks; no upstream CEP dispatch."],
      },
      handler: async (args: unknown) => {
        const { page = 1, ...input } = args as Json;
        if (!writes && (!Number.isInteger(page) || (page as number) < 1)) throw new Error("page must be a whole number from 1");
        const argv = companionArguments(tool, writes ? args : input);
        try {
          if (writes) markHostDispatch();
          const { stdout } = await execute(cli, argv);
          return { success: true, data: companionReceipt(tool, input, JSON.parse(stdout), writes, true, page as number) };
        } catch (cause) {
          const error = cause as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
          let result: unknown;
          try { result = JSON.parse(error.stdout ?? ""); } catch { /* Preserve non-JSON diagnostics below. */ }
          const reported = record(record(result)?.error);
          const message = String(reported?.message ?? reported?.code ?? (error.stdout?.trim() || error.stderr?.trim() || error.message)).slice(0, 2000);
          return { success: false, error: message,
            data: { ...companionReceipt(tool, input, result, writes, false), exitCode: error.code ?? null,
              outcome: error.killed || error.code === 5 ? "unknown" : error.code === 3 || error.code === 4 ? "not_applied" : "failed", retry: false } };
        }
      },
    }];
  }));
  return writer === "companion" ? { ...tools, ...companionPlanners() } : tools;
}
