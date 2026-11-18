import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { companionAuthority, companionWriter } from "../companion-policy.js";
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
  name: string; description: string; argv: string[]; positional: string[];
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
function describeProperties(schema: CompanionTool["inputSchema"]): CompanionTool["inputSchema"] {
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) =>
    [key, (value as { description?: string }).description || !PROPERTY_HINTS[key] ? value : { ...value, description: PROPERTY_HINTS[key] }])) };
}

export const DETAIL_LIMIT = 24_000;
type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
// One line per field: scalars as they are, lists as a count. Enough for "what changed" without the payload.
function brief(value: unknown): unknown {
  const object = record(value);
  if (!object) return Array.isArray(value) ? `${value.length} item(s)` : typeof value === "string" ? value.slice(0, 160) : value ?? null;
  return Object.fromEntries(Object.entries(object).slice(0, 12).map(([key, field]) =>
    [key, Array.isArray(field) ? `${field.length} item(s)` : record(field) ? "{...}" : typeof field === "string" ? field.slice(0, 160) : field]));
}
function shrink(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 400 ? value.slice(0, 400) + "..." : value;
  if (Array.isArray(value)) return depth > 5 ? `${value.length} item(s)` : [...value.slice(0, 50).map(item => shrink(item, depth + 1)), ...(value.length > 50 ? [`... ${value.length - 50} more`] : [])];
  const object = record(value);
  return !object ? value : depth > 5 ? "{...}" : Object.fromEntries(Object.entries(object).map(([key, field]) => [key, shrink(field, depth + 1)]));
}

/** The small, consistent receipt every Companion-backed result carries, with the payload capped. */
export function companionReceipt(tool: CompanionTool, args: Json, output: unknown, writes: boolean, ok = true): Json {
  const out = record(output) ?? {};
  const result = out.result;
  const state = typeof out.state === "string" ? out.state : undefined;
  const error = record(out.error);
  const size = JSON.stringify(result ?? null).length;
  let detail = size > DETAIL_LIMIT ? shrink(result) : result;
  if (JSON.stringify(detail ?? null).length > DETAIL_LIMIT) detail = brief(result);
  const finished = ok && (state === "done" || (state === undefined && !error));
  const pending = ok && (state === "queued" || state === "running");
  return {
    command: tool.argv.join(" "),
    writer: writes ? "premiere-companion" : null,
    target: {
      project: args.project ?? record(result)?.project ?? "the single project Companion has granted",
      ...(args.sequence ?? args.seq ?? record(result)?.sequence ? { sequence: args.sequence ?? args.seq ?? record(result)?.sequence } : {}),
    },
    state: state ?? null,
    jobId: out.jobId ?? null,
    changed: !writes ? "nothing (read-only)" : finished ? brief(result) ?? "done" : pending ? "accepted, not finished yet" : "nothing confirmed",
    verified: !writes ? "read directly through Companion"
      : finished ? "Companion read the change back from Premiere before reporting done; picture and sound were not rendered or checked"
      : pending ? "not yet: poll companion_job (or companion_export_status for an export id) until it is done"
      : state === "unknown" ? "outcome unknown: do not retry; read companion_job and the timeline before any dependent edit"
      : "nothing was confirmed",
    // Read by the server's mutation receipt (outcome, verificationScope, accepted); no top-level "result" key, so it reads these fields.
    ...(writes && finished ? { outcome: "verified", verificationScope: "Premiere Companion read-back before done" } : {}),
    ...(writes && pending ? { outcome: "committed_unverified", accepted: true } : {}),
    ...(writes && (state === "guard-refused" || state === "no-panel") ? { outcome: "not_applied" } : {}),
    ...(error ? { error } : {}),
    detail: detail ?? null,
    ...(detail !== result ? { truncated: { characters: size, limit: DETAIL_LIMIT, note: "Output capped. Call again with narrower arguments (one sequence, one preset by name with companion_presets_show, one job with companion_job)." } } : {}),
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
  const tools = Object.fromEntries((manifest.tools as CompanionTool[]).map(tool => {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || seen.has(tool.name) || !Array.isArray(tool.argv) || !tool.argv.every(x => typeof x === "string") || !Array.isArray(tool.positional) || !tool.inputSchema?.properties) throw new Error("Invalid or duplicate Companion tool");
    seen.add(tool.name);
    const name = "companion_" + tool.name;
    const writes = companionAuthority(name)!.length > 1;
    return [name, {
      description: `Premiere Companion: ${tool.description} ${writes ? "Writes through Companion's grant, locks and job queue. Never retry an unknown outcome." : "Read-only."}`,
      parameters: describeProperties(tool.inputSchema),
      annotations: { readOnlyHint: !writes },
      operationalCapability: {
        backend: "orchestrator", backends: ["orchestrator"], status: "supported",
        verificationBoundary: "bridge_response", hostVerificationRequired: true,
        notes: ["Uses the existing Companion CLI and its own grant, queue and readback checks; no upstream CEP dispatch."],
      },
      handler: async (args: unknown) => {
        const argv = companionArguments(tool, args);
        const input = args as Json;
        try {
          if (writes) markHostDispatch();
          const { stdout } = await execute(cli, argv);
          return { success: true, data: companionReceipt(tool, input, JSON.parse(stdout), writes) };
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
