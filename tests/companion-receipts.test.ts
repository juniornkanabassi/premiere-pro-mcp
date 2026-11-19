import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companionReceipt, DETAIL_LIMIT, getCompanionTools } from "../src/tools/companion.js";
import { companionAuthority, isCompanionRead } from "../src/companion-policy.js";
import { mutationReceipt } from "../src/workflows/mutation-receipt.js";
import { buildPremiereInstructions } from "../src/workflows/agent-instructions.js";

// Reply shapes copied from Companion 1.11.0 bin/binboy.mjs (presets, roots, refresh, export, panel job envelope).
const schema = (properties: Record<string, unknown> = {}) => ({ type: "object", properties, required: [], additionalProperties: false });
const tool = (name: string, argv: string[], properties: Record<string, unknown> = {}, readOnly?: boolean) =>
  ({ name, description: name, argv, positional: [], inputSchema: schema(properties), ...(readOnly ? { readOnly } : {}) });
const receipt = (t: ReturnType<typeof tool>, output: unknown, args: Record<string, unknown> = {}) => companionReceipt(t as never, args, output, !isCompanionRead(t));
const server = (r: Record<string, unknown>) => mutationReceipt(true, r, { dispatched: true }, "x");

const scratch: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Companion receipts against real CLI shapes", () => {
  it("keeps bare preset, roots and first-cut results", () => {
    const groups = { "Social Media": ["Social Media [H.265]", "Social Media [Apple ProRes 422 HQ]"] };
    expect(receipt(tool("presets_export", ["presets", "export"], {}, true), groups).detail).toEqual(groups);
    const list = [{ name: "Grade", folder: "Looks", kinds: ["Lumetri"] }];
    expect(receipt(tool("presets_effects", ["presets", "effects"], {}, true), list).detail).toEqual(list);
    const config = { port: 8610, allowedRoots: ["/x"] };
    expect(receipt(tool("roots_list", ["roots", "list"], {}, true), config).detail).toEqual(config);
  });

  it("never tells the agent to run a second refresh to follow a queued one", () => {
    // Companion's refresh always POSTs a new pass, so "companion_refresh with wait" would queue another, not follow r-1.
    const r = receipt(tool("refresh", ["refresh"], { project: { type: "string" }, wait: { type: "boolean" }, allowMass: { type: "boolean" } }), { refreshId: "r-1", state: "queued" });
    expect(r.recovery).toMatchObject({ id: "r-1", kind: "refreshId", lookup: null });
    expect(r.jobId).toBeNull();
    const advice = String(r.verified) + JSON.stringify(r.recovery);
    expect(advice).not.toMatch(/run companion_refresh|wait: true|companion_job/);
    expect(advice).toContain("companion_status");
    expect(advice).toMatch(/do not/i);
  });

  it("keeps export path and status metadata and points at export status", () => {
    const out = { jobId: "e1", exportId: "e1", state: "running", scope: { kind: "project" }, sequence: "199", finalPath: "/p/04 Exports/01 Video/199.mp4", stagingPath: "/p/.stage/199.mp4", preset: "/presets/x.epr" };
    const r = receipt(tool("export", ["export"], { out: { type: "string" } }), out);
    expect(r.detail).toMatchObject({ finalPath: out.finalPath, stagingPath: out.stagingPath, sequence: "199" });
    expect(r.recovery).toMatchObject({ id: "e1", kind: "exportId", lookup: "companion_export_status" });
    expect(String(r.verified)).toContain("companion_export_status");
  });

  it("never marks a finished write as verified, and a preview as not applied", () => {
    const place = receipt(tool("place", ["place"]), { jobId: "j1", state: "done", result: { placed: 1 } });
    expect(place.outcome).toBe("committed_unverified");
    expect(server(place).outcome).toBe("committed_unverified");
    expect(String(place.verified)).not.toMatch(/read the change back/);
    const layout = tool("bin_layout", ["bin", "layout"], { apply: { type: "boolean" } });
    const preview = receipt(layout, { jobId: "j2", state: "done", result: { moves: [] } }, { template: "flv" });
    expect(preview).toMatchObject({ outcome: "not_applied", changed: "nothing (preview)" });
    expect(server(preview).outcome).toBe("not_applied");
    expect(receipt(layout, { jobId: "j3", state: "done", result: {} }, { apply: true }).outcome).toBe("committed_unverified");
    expect(receipt(tool("close", ["close"]), { jobId: "j4", state: "done", result: {} }).outcome).toBe("committed_unverified");
  });

  it("keeps capped transcript JSON valid and never shows a cut-off string", () => {
    const words = Array.from({ length: 3000 }, (_, i) => ({ text: "word" + i, start: i / 2, duration: 0.4 }));
    const json = JSON.stringify({ segments: [{ start: 0, duration: 1500, words }] });
    const r = receipt(tool("transcript_export", ["transcript", "export"], { clip: { type: "string" }, out: { type: "string" } }), { jobId: "t1", state: "done", result: { json } }, { clip: "A.mp4" });
    expect(r.truncated).toBeTruthy();
    const kept = (r.detail as { json: string }).json;
    expect(kept).not.toContain("word0");
    expect(kept).toContain(`${json.length} characters`);
    expect(String((r.truncated as { note: string }).note)).toContain("out");
    expect(JSON.stringify(r).length).toBeLessThan(DETAIL_LIMIT + 4000);
  });

  it("keeps failed rows and the failed state when a job detail is capped", () => {
    const items = Array.from({ length: 120 }, (_, i) => ({ index: i, ok: i !== 55, ...(i === 55 ? { error: "media offline" } : {}), note: "x".repeat(300) }));
    const r = receipt(tool("stringout", ["stringout"]), { jobId: "s1", state: "failed", error: { code: "partial", message: "1 failed" }, result: { items } });
    expect(r.state).toBe("failed");
    expect(r.error).toMatchObject({ code: "partial" });
    expect(r.truncated).toMatchObject({ failed: { count: 1, rows: [{ path: ["items", 55], value: { error: "media offline" } }] } });
  });
});

describe("Companion modes that change nothing", () => {
  it("reports autosync status as a read and first_cut without out as a plan", () => {
    const autosync = tool("autosync", ["autosync"], { mode: { type: "string" } });
    const status = receipt(autosync, { autoSync: true, watchers: [] }, { mode: "status" });
    expect(status).toMatchObject({ writer: null, changed: "nothing (read-only)", outcome: "not_applied" });
    expect(server(status).outcome).toBe("not_applied");
    expect(receipt(autosync, { autoSync: true, watchers: [] }, { mode: "on" }).outcome).toBe("committed_unverified");
    const firstCut = tool("first_cut", ["first-cut"], { transcript: { type: "string" }, clip: { type: "string" }, out: { type: "string" } });
    const plan = receipt(firstCut, { keep: [[0, 2]] }, { transcript: "/t.json", clip: "/a.mp4" });
    expect(plan).toMatchObject({ changed: "nothing (preview)", outcome: "not_applied" });
    expect(server(plan).outcome).toBe("not_applied");
    expect(receipt(firstCut, { keep: [[0, 2]] }, { transcript: "/t.json", clip: "/a.mp4", out: "/cuts.json" }).outcome).toBe("committed_unverified");
  });
});

// Companion 1.11.0's real flags and contracts for the reads (bin/binboy.mjs READ_ONLY and its manifest entries).
const bound = (t: ReturnType<typeof tool>, positional: string[]) => ({ ...t, positional });
const REAL_READS = [tool("status", ["status"], {}, true), bound(tool("timeline", ["timeline"], { sequence: { type: "string" }, project: { type: "string" } }, true), ["sequence"]),
  bound(tool("job", ["job"], { id: { type: "string" } }, true), ["id"]), bound(tool("export_status", ["export", "status"], { id: { type: "string" } }, true), ["id"])];

describe("Companion read-only authority needs the flag and the known read contract", () => {
  it("keeps the real reads read-only and makes a remapped, extended or unknown flagged command a writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-ro-")); scratch.push(dir);
    const cli = join(dir, "fake.cjs");
    const tools = [
      tool("status", ["bin", "move"], {}, true), // remapped verb, flag kept
      tool("timeline", ["timeline"], { sequence: { type: "string" }, apply: { type: "boolean" } }, true), // extra argument
      tool("first_cut", ["first-cut"], { out: { type: "string" } }, true), // not a 1.11.0 read (its real entry is unflagged)
      tool("bins", ["bins"], { project: { type: "string" } }), // known read without the flag
      ...REAL_READS.slice(2),
    ];
    writeFileSync(cli, `console.log(JSON.stringify(${JSON.stringify({ name: "premiere-companion", tools })}))`);
    vi.stubEnv("PREMIERE_COMPANION_CLI", cli);
    const registered = getCompanionTools(cli) as Record<string, { annotations: { readOnlyHint: boolean } }>;
    for (const name of ["status", "timeline", "first_cut", "bins"]) {
      expect(registered["companion_" + name].annotations.readOnlyHint).toBe(false);
      expect(companionAuthority("companion_" + name)).toHaveLength(4);
    }
    for (const name of ["job", "export_status"]) {
      expect(registered["companion_" + name].annotations.readOnlyHint).toBe(true);
      expect(companionAuthority("companion_" + name)).toEqual(["inspect"]);
    }
    expect(REAL_READS.every(isCompanionRead)).toBe(true);
  });

  it("makes a known read a writer when an argument changes type or positional binding", () => {
    const timeline = REAL_READS[1];
    expect(isCompanionRead({ ...timeline, inputSchema: schema({ sequence: { type: "integer" }, project: { type: "string" } }) })).toBe(false);
    expect(isCompanionRead({ ...timeline, positional: [] })).toBe(false);
    expect(isCompanionRead({ ...timeline, positional: ["project"] })).toBe(false);
    expect(isCompanionRead({ ...timeline, inputSchema: schema({ project: { type: "string" } }), positional: [] })).toBe(true); // a narrower read stays a read
  });
});

describe("Capped Companion output keeps every value reachable", () => {
  // Shapes from Companion 1.11.0: timeline is a panel job whose result is { video: [[row per item]], audio } (panel/main.js timelineItems),
  // and companion_job answers GET /api/job/<id> with the same snapshot (bin/binboy.mjs snapshotResponse).
  const row = (index: number) => ({ track: "V1", index, name: `Clip ${index}`, mediaPath: "/Volumes/Media/" + "p".repeat(479) + `/${String(index).padStart(2, "0")}.mp4`,
    startSeconds: index, endSeconds: index + 1, inSeconds: 0, outSeconds: 1, startTicks: "0", endTicks: "0", inTicks: "0", outTicks: "0", disabled: false, speed: 1, reversed: false, components: ["Motion", "Opacity"] });
  const snapshot = { jobId: "t1", state: "done", result: { video: [Array.from({ length: 60 }, (_, i) => row(i))], audio: [] }, error: null };

  async function follow(cli: string, first: { name: string; args: Record<string, unknown> }) {
    const tools = getCompanionTools(cli) as Record<string, { handler: (a: unknown) => Promise<{ data: Record<string, unknown> }> }>;
    const pieces: { path: unknown[]; value: unknown }[] = [];
    let call: { tool: string; arguments: Record<string, unknown> } | null = { tool: first.name, arguments: first.args };
    let first_receipt: Record<string, unknown> | undefined;
    for (let guard = 0; call && guard < 20; guard++) {
      const { data } = await tools[call.tool].handler(call.arguments);
      first_receipt ??= data;
      expect(JSON.stringify(data).length).toBeLessThan(DETAIL_LIMIT + 4000);
      pieces.push(...(data.detail as { pieces: typeof pieces }).pieces);
      call = (data.truncated as { next: typeof call }).next;
    }
    return { pieces, first: first_receipt! };
  }

  it("pages a 60-item timeline with a 501-character path so item 59 and its whole path come back", async () => {
    expect(row(59).mediaPath).toHaveLength(501);
    const dir = mkdtempSync(join(tmpdir(), "companion-page-")); scratch.push(dir);
    const cli = join(dir, "fake.cjs");
    writeFileSync(cli, `const a = process.argv.slice(2);
if (a[0] === "mcp-manifest") console.log(JSON.stringify(${JSON.stringify({ name: "premiere-companion", tools: REAL_READS })}));
else if ((a[0] === "timeline" && a.includes("199")) || (a[0] === "job" && a.includes("t1"))) console.log(JSON.stringify(${JSON.stringify(snapshot)}));
else { console.log("{}"); process.exit(2); }`);
    const { pieces, first } = await follow(cli, { name: "companion_timeline", args: { sequence: "199" } });
    expect(first.truncated).toMatchObject({ page: 1, next: { tool: "companion_job", arguments: { id: "t1", page: 2 } } });
    const items = pieces.filter(p => p.path[0] === "video").map(p => p.value as ReturnType<typeof row>);
    expect(items).toHaveLength(60);
    expect(items[59]).toEqual(row(59));
    expect(pieces.find(p => (p.value as { index?: number }).index === 59)!.path).toEqual(["video", 0, 59]);
  });

  it("keeps a late failed row and its reason when 66 rows overflow, and pages the rest through companion_job", async () => {
    const rows = Array.from({ length: 66 }, (_, i) => ({ index: i, ok: i !== 64, ...(i === 64 ? { error: { code: "media-offline", message: "A-roll 64 is offline" } } : {}), note: "n".repeat(500) }));
    const output = { jobId: "s1", state: "done", result: { items: rows } };
    const r = receipt(tool("stringout", ["stringout"], { plan: { type: "string" } }), output, { plan: "/p.json" });
    expect(r.truncated).toMatchObject({ failed: { count: 1, rows: [{ path: ["items", 64], value: { error: { message: "A-roll 64 is offline" } } }] }, next: { tool: "companion_job", arguments: { id: "s1", page: 2 } } });
    const dir = mkdtempSync(join(tmpdir(), "companion-page-")); scratch.push(dir);
    const cli = join(dir, "fake.cjs");
    writeFileSync(cli, `if (process.argv[2] === "mcp-manifest") console.log(JSON.stringify(${JSON.stringify({ name: "premiere-companion", tools: REAL_READS })})); else console.log(JSON.stringify(${JSON.stringify(output)}));`);
    const { pieces } = await follow(cli, { name: "companion_job", args: { id: "s1" } });
    expect(pieces.filter(p => p.path[0] === "items").map(p => p.value)).toEqual(rows);
  });

  it("returns a large write result whole when no tool could fetch a dropped part", () => {
    const rows = Array.from({ length: 66 }, (_, i) => ({ index: i, ok: i !== 64, note: "n".repeat(500) }));
    const r = receipt(tool("colour_set", ["colour"], { path: { type: "string" } }), { rows }, { path: "/x.prproj" });
    expect(r.truncated).toBeUndefined();
    expect(r.detail).toEqual({ rows });
  });

  it("names the first_cut file route when its review flags or takes are capped", () => {
    const firstCut = tool("first_cut", ["first-cut"], { transcript: { type: "string" }, clip: { type: "string" }, out: { type: "string" } });
    const plan = { keep: [[0, 2]], takes: Array.from({ length: 80 }, (_, i) => ({ line: i, text: "t".repeat(500) })), flags: [{ line: 3, reason: "x".repeat(450) }] };
    const capped = receipt(firstCut, plan, { transcript: "/t.json", clip: "/a.mp4" });
    expect(String((capped.truncated as { note: string }).note)).toContain("companion_first_cut again with the same arguments plus out");
    const written = receipt(firstCut, plan, { transcript: "/t.json", clip: "/a.mp4", out: "/cuts.json" });
    expect(String((written.truncated as { note: string }).note)).toContain("/cuts.json");
  });
});

describe("Companion hints and order", () => {
  it("describes out as a file for exports and a time for trims", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-hint-")); scratch.push(dir);
    const cli = join(dir, "fake.cjs");
    const tools = [tool("export_frame", ["export", "frame"], { at: { type: "string" }, out: { type: "string" } }), tool("edit", ["edit"], { in: { type: "string" }, out: { type: "string" } })];
    writeFileSync(cli, `console.log(JSON.stringify(${JSON.stringify({ name: "premiere-companion", tools })}))`);
    const registered = getCompanionTools(cli) as Record<string, { parameters: { properties: Record<string, { description?: string }> } }>;
    expect(registered.companion_export_frame.parameters.properties.out.description).toMatch(/file/i);
    expect(registered.companion_export_frame.parameters.properties.out.description).not.toMatch(/seconds/);
    expect(registered.companion_edit.parameters.properties.out.description).toMatch(/seconds/);
  });

  it("lists the final export after finishing, checking and saving", () => {
    const text = buildPremiereInstructions(new Set(["companion_status", "companion_build", "companion_timeline", "companion_save", "companion_export", "companion_place"]));
    const at = (name: string) => text.indexOf(name);
    expect(at("companion_export")).toBeGreaterThan(at("companion_build"));
    expect(at("companion_export")).toBeGreaterThan(at("companion_timeline"));
    expect(at("companion_export")).toBeGreaterThan(at("companion_save"));
  });

  it("gives the long-transcript file route to the planners", () => {
    const text = buildPremiereInstructions(new Set(["companion_place", "companion_transcript_export", "detect_repeated_takes"]));
    expect(text).toContain("pass out to write the whole transcript JSON to a file");
    expect(text).toContain("build word_timeline from it");
  });
});
