import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { shortsToolList } from "../src/companion-policy.js";
import { DETAIL_LIMIT } from "../src/tools/companion.js";

vi.setConfig({ testTimeout: 60_000 });

// Entries copied verbatim from `premiere-companion mcp-manifest` (Companion 1.11.0).
const opt = { type: "string", minLength: 1, description: "Absolute .prproj path; defaults to the single granted project." };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const MANIFEST = [
  { name: "status", argv: ["status"], description: "Read daemon, CLI and Premiere status.", inputSchema: obj({}), positional: [], readOnly: true },
  { name: "bins", argv: ["bins"], description: "Read project bins and media paths.", inputSchema: obj({ project: opt }), positional: [], readOnly: true },
  { name: "import", argv: ["import"], description: "Import media inside 03 Media into mapped bins.", inputSchema: obj({ files: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }, bin: { type: "string", minLength: 1 }, project: opt, requestId: { type: "string", minLength: 1 } }, ["files"]), positional: ["files"] },
  { name: "autosync", argv: ["autosync"], description: "Read or set automatic refresh.", inputSchema: obj({ mode: { type: "string", enum: ["on", "off", "status"] } }, ["mode"]), positional: ["mode"] },
  { name: "job", argv: ["job"], description: "Read a job outcome.", inputSchema: obj({ id: { type: "string", minLength: 1 } }, ["id"]), positional: ["id"], readOnly: true },
  { name: "presets_export", argv: ["presets", "export"], description: "List export preset names grouped by folder.", inputSchema: obj({ detail: { type: "boolean" } }), positional: [], readOnly: true },
  { name: "timeline", argv: ["timeline"], description: "Read every track item of a sequence.", inputSchema: obj({ sequence: { type: "string", minLength: 1 }, project: opt }, ["sequence"]), positional: ["sequence"], readOnly: true },
];

// Reply shapes from Companion 1.11.0 bin/binboy.mjs: snapshotResponse for panel jobs and GET /api/job/<id>, cliStatus adds daemon fields,
// autosync status is the bare GET /api/autosync body, an import with an ambiguous bin fails (exit 2) with per-file rows.
const long = (i: number) => `/Volumes/Media/03 Media/01 A-Roll/${"p".repeat(300)}/clip-${i}.mp4`;
const waiting = Array.from({ length: 200 }, (_, i) => ({ name: `clip-${i}-${"w".repeat(150)}.mp4`, reason: "held" }));
const statusPanel = { jobId: "st1", state: "done", result: { project: "/p/199.prproj", sequences: 3 }, error: null };
const STATUS = { version: "1.11.0", cliVersion: "1.11.0", panel: { connected: true }, projects: { "/p/199.prproj": { last: { state: "held", waiting } } }, ...statusPanel, premiere: statusPanel.result };
const AUTOSYNC = { autoSync: true, projects: { "/p/199.prproj": { last: { state: "held", waiting } } } };
const row = (i: number) => ({ track: "V1", index: i, name: `Clip ${i}`, mediaPath: long(i), startSeconds: i, endSeconds: i + 1, components: ["Motion", "Opacity"] });
const TIMELINE = { jobId: "t1", state: "done", result: { video: [Array.from({ length: 60 }, (_, i) => row(i))], audio: [] }, error: null };
const BINS = { jobId: "b1", state: "done", result: { tree: Array.from({ length: 80 }, (_, i) => ({ name: `Bin ${i}`, children: [{ name: `clip-${i}.mp4`, mediaPath: long(i) }] })) }, error: null };
const importRows = Array.from({ length: 120 }, (_, i) => i % 40 === 39
  ? { file: long(i), status: "ambiguous-bin", at: ["01 A-Roll", `Day ${i}`] }
  : { file: long(i), binPath: ["03 Media", "01 A-Roll"], status: "imported", itemName: `clip-${i}.mp4` });
const IMPORT = { jobId: "i1", state: "failed", result: { items: importRows }, error: { code: "ambiguous-bin", message: "3 files: two or more bins match" }, scope: { project: "/p/199.prproj" } };
const PRESETS = Object.fromEntries(Array.from({ length: 90 }, (_, f) => ["Folder " + f, Array.from({ length: 20 }, (_, i) => "Preset " + f + "." + i)]));

const FAKE = `const a = process.argv.slice(2), say = (v, code = 0) => { console.log(JSON.stringify(v)); process.exit(code); };
const jobs = ${JSON.stringify({ st1: statusPanel, t1: TIMELINE, b1: BINS, i1: IMPORT })};
if (a[0] === "mcp-manifest") say({ name: "premiere-companion", tools: ${JSON.stringify(MANIFEST)} });
if (a[0] === "status") say(${JSON.stringify(STATUS)});
if (a[0] === "autosync") say(${JSON.stringify(AUTOSYNC)});
if (a[0] === "timeline") say(jobs.t1);
if (a[0] === "bins") say(jobs.b1);
if (a[0] === "import") say(jobs.i1, 2);
if (a[0] === "presets") say(${JSON.stringify(PRESETS)});
if (a[0] === "job" && jobs[a[1]]) say(jobs[a[1]], jobs[a[1]].state === "failed" ? 2 : 0);
say({ error: "not-found" }, 2);`;

const scratch: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function connect() {
  const dir = mkdtempSync(join(tmpdir(), "companion-paging-")); scratch.push(dir);
  const cli = join(dir, "fake.cjs"); writeFileSync(cli, FAKE);
  vi.stubEnv("PREMIERE_COMPANION_CLI", cli);
  vi.stubEnv("PREMIERE_MCP_CAPABILITIES", "inspect,edit,export,filesystem");
  const server = createServer({ timeoutMs: 50, tempDir: dir }, { toolList: shortsToolList(MANIFEST) });
  const client = new Client({ name: "paging-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const schemas = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t.inputSchema as { properties: Record<string, { type: string }>; required?: string[] }]));
  return { client, schemas, close: () => client.close() };
}
type Data = { state: unknown; error?: unknown; detail: unknown; truncated?: { next: { tool: string; arguments: Record<string, unknown> } | null; failed?: { count: number } } };
const data = (result: unknown) => (result as { structuredContent: { data: Data } }).structuredContent.data;

// Walk next from page 1 to the end, rebuild the payload from the pieces' paths, and check every emitted next against the tool's own schema.
async function walk(c: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) {
  const pages: Data[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } | null = { tool: name, arguments: args };
  while (call && pages.length < 50) {
    const schema = c.schemas[call.tool];
    expect(schema, call.tool).toBeTruthy();
    for (const [key, value] of Object.entries(call.arguments)) expect(typeof value === "number" ? "integer" : typeof value, key).toBe(schema.properties[key]?.type === "array" ? "object" : schema.properties[key]?.type);
    for (const key of schema.required ?? []) expect(call.arguments).toHaveProperty(key);
    const result = await c.client.callTool({ name: call.tool, arguments: call.arguments });
    if (pages.length) expect(result.isError, `page ${pages.length + 1} is a continuation, not a new failure`).toBeFalsy();
    const page = data(result);
    if (page.truncated) expect(JSON.stringify(page).length).toBeLessThan(DETAIL_LIMIT + 4000);
    pages.push(page);
    call = page.truncated?.next ?? null;
  }
  if (!pages[0].truncated) return { pages, payload: pages[0].detail };
  let root: unknown;
  const seen = new Set<string>();
  for (const page of pages) for (const piece of (page.detail as { pieces: { path: (string | number)[]; value: unknown }[] }).pieces) {
    const key = JSON.stringify(piece.path);
    expect(seen.has(key), `piece ${key} twice`).toBe(false); seen.add(key);
    if (!piece.path.length) { root = piece.value; continue; }
    root ??= typeof piece.path[0] === "number" ? [] : {};
    let at = root as Record<string | number, unknown>;
    piece.path.forEach((step, i) => {
      if (i === piece.path.length - 1) at[step] = piece.value;
      else at = (at[step] ??= typeof piece.path[i + 1] === "number" ? [] : {}) as Record<string | number, unknown>;
    });
  }
  return { pages, payload: root };
}

describe("Companion paging is total: every next validates and returns the next slice of the same result", () => {
  it("pages job-backed reads, a failed import and a preset listing without loss or repeats", async () => {
    const c = await connect();
    try {
      for (const [name, args, expected] of [
        ["companion_timeline", { sequence: "199" }, TIMELINE.result],
        ["companion_bins", {}, BINS.result],
        ["companion_presets_export", {}, PRESETS],
      ] as const) {
        const { pages, payload } = await walk(c, name, args);
        expect(pages.length, name).toBeGreaterThan(1);
        expect(payload, name).toEqual(expected);
      }

      const { pages, payload } = await walk(c, "companion_import", { files: ["/p/03 Media/01 A-Roll/a.mp4"] });
      expect(pages.length).toBeGreaterThan(1);
      expect(payload).toEqual({ scope: IMPORT.scope, result: IMPORT.result });
      // The failed state and its error sit outside the pages on every page; the failed-row excerpt is given once, on page 1.
      for (const page of pages) expect(page).toMatchObject({ state: "failed", error: IMPORT.error });
      expect(pages[0].truncated!.failed!.count).toBe(3);
      expect(pages.slice(1).every(page => !page.truncated!.failed)).toBe(true);
    } finally { await c.close(); }
  });

  it("returns status and autosync status whole: no route returns the same payload with a page", async () => {
    const c = await connect();
    try {
      for (const [name, args, field] of [["companion_status", {}, STATUS.projects], ["companion_autosync", { mode: "status" }, AUTOSYNC.projects]] as const) {
        const { pages, payload } = await walk(c, name, args);
        expect(pages, name).toHaveLength(1);
        expect(pages[0].truncated, name).toBeUndefined();
        expect((payload as { projects: unknown }).projects, name).toEqual(field);
      }
    } finally { await c.close(); }
  });

  it("refuses a page past the end or from a different result instead of answering with another slice", async () => {
    const c = await connect();
    try {
      const next = data(await c.client.callTool({ name: "companion_timeline", arguments: { sequence: "199" } })).truncated!.next!;
      expect((await c.client.callTool({ name: "companion_job", arguments: { ...next.arguments, page: 99 } })).isError).toBe(true);
      expect((await c.client.callTool({ name: "companion_job", arguments: { ...next.arguments, id: "b1" } })).isError).toBe(true);
      expect((await c.client.callTool({ name: "companion_job", arguments: { id: "st1", page: 2 } })).isError).toBe(true);
    } finally { await c.close(); }
  });
});
