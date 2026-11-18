import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { SHORTS_PLANNERS, shortsToolList } from "../src/companion-policy.js";
import { DETAIL_LIMIT } from "../src/tools/companion.js";

vi.setConfig({ testTimeout: 60_000 });

// The 60 Companion 1.11.0 manifest commands, with its readOnly flags, plus one this adapter has never seen.
const NAMES = ["status", "bins", "open", "close", "save", "import", "refresh", "autosync", "sequence_create", "sequence_list", "marker_add", "marker_list", "place", "remove", "job", "roots_list", "file_loose", "job_resolve", "presets_export", "presets_effects", "presets_show", "sequence_settings", "sequence_duplicate", "sequence_new", "sequence_inout", "timeline", "edit", "effect_available", "effect_list", "effect_apply", "effect_set", "effect_add", "effect_remove", "colour_status", "colour_set", "export", "export_frame", "export_status", "export_review", "audio_channels", "audio_clean", "roughcut", "short_setup", "first_cut", "bin_create", "bin_move", "bin_rename", "bin_label", "bin_layout", "stringout", "transcript_export", "transcript_import", "transcript_run", "audio_level", "sequence_vertical", "build", "finish", "multicam", "autocam", "captions_import"];
const READ_ONLY = new Set(["status", "bins", "sequence_list", "marker_list", "job", "roots_list", "presets_export", "presets_effects", "presets_show", "timeline", "effect_available", "effect_list", "colour_status", "export_status", "first_cut"]);
const s = { type: "string", minLength: 1 };
const tools = [
  ...NAMES.map(name => ({ name, description: `Fake ${name}.`, argv: name.split("_"), positional: [], ...(READ_ONLY.has(name) ? { readOnly: true } : {}), inputSchema: { type: "object", properties: { project: s, sequence: s, track: s, index: { type: "integer" } }, required: [], additionalProperties: false } })),
  { name: "first_cut_plan", description: "Plan a first cut from a transcript.", argv: ["first-cut", "plan"], positional: ["clip"], inputSchema: { type: "object", additionalProperties: false, required: ["clip"], properties: {
    clip: { ...s, description: "Clip name." }, mode: { type: "string", enum: ["tight", "loose"], description: "Default tight." }, padFrames: { type: "integer" } } } },
];
// Replies by command; records every call so the test can prove planners never reach it.
const FAKE = `
const fs = require("node:fs"); const a = process.argv.slice(2);
if (a[0] === "mcp-manifest") { console.log(JSON.stringify({ name: "premiere-companion", tools: ${JSON.stringify(tools)} })); process.exit(0); }
fs.appendFileSync(process.env.FAKE_LOG, a.join(" ") + "\\n");
if (a[0] === "place") console.log(JSON.stringify({ jobId: "j1", state: "done", result: { placed: 1, sequence: "199 - 01 Rough Cut", items: [1, 2, 3] } }));
// presets export answers with the bare grouped list, no envelope (Companion bin/binboy.mjs cliPresets).
else if (a[0] === "presets") console.log(JSON.stringify(Object.fromEntries(Array.from({ length: 90 }, (_, f) => ["Folder " + f, Array.from({ length: 20 }, (_, i) => "Preset " + f + "." + i)]))));
else { console.log(JSON.stringify({ jobId: null, state: "guard-refused", error: { code: "no-grant", message: "no open grant" } })); process.exit(3); }
`;

const scratch: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function connect() {
  const dir = mkdtempSync(join(tmpdir(), "companion-shorts-")); scratch.push(dir);
  const cli = join(dir, "fake.cjs"); writeFileSync(cli, FAKE);
  const log = join(dir, "calls.log");
  vi.stubEnv("PREMIERE_COMPANION_CLI", cli);
  vi.stubEnv("FAKE_LOG", log);
  vi.stubEnv("PREMIERE_MCP_CAPABILITIES", "inspect,edit,export,filesystem");
  const server = createServer({ timeoutMs: 50, tempDir: dir }, { toolList: shortsToolList(tools) });
  const client = new Client({ name: "shorts-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, log, close: () => client.close() };
}
const data = (result: unknown) => ((result as { structuredContent: { data: Record<string, unknown> } }).structuredContent.data);

describe("Shorts profile", () => {
  it("lists under 70 tools, shows an unknown manifest command with its schema, and drops CEP guards", async () => {
    const { client, close } = await connect();
    try {
      const listed = (await client.listTools()).tools;
      const names = listed.map(tool => tool.name).sort();
      expect(names.length).toBeLessThan(70);
      expect(names).toEqual([...NAMES.map(n => "companion_" + n), "companion_first_cut_plan", ...SHORTS_PLANNERS, "get_capabilities", "ping"].sort());
      const fresh = listed.find(tool => tool.name === "companion_first_cut_plan")!;
      expect(fresh.inputSchema.required).toEqual(["clip"]);
      expect(fresh.inputSchema.properties).toMatchObject({ mode: { enum: ["tight", "loose"], description: "Default tight." }, padFrames: { type: "integer" } });
      expect(fresh.description).toContain("Writes through Companion");
      const place = listed.find(tool => tool.name === "companion_place")!;
      expect(Object.keys(place.inputSchema.properties!)).not.toContain("expected_cep_target");
      expect(Object.keys(place.inputSchema.properties!)).not.toContain("idempotency_key");
      expect(place.inputSchema.properties).toMatchObject({ track: { description: expect.stringContaining("numbered from 1") }, index: { description: expect.stringContaining("from 0") } });
      expect(listed.find(tool => tool.name === "companion_status")!.annotations?.readOnlyHint).toBe(true);

      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("only writer");
      expect(instructions).toContain("companion_first_cut_plan");
      for (const absent of ["verify_premiere_connection", "get_last_operations", "acknowledge_operation_recovery"]) expect(instructions).not.toContain(absent);
    } finally { await close(); }
  });

  it("runs the planners read-only, without the host or Companion", async () => {
    const { client, log, close } = await connect();
    try {
      const listed = (await client.listTools()).tools;
      for (const name of SHORTS_PLANNERS) expect(listed.find(tool => tool.name === name)!.annotations?.readOnlyHint).toBe(true);
      const words = ["so", "today", "we", "look", "at", "barca", "so", "today", "we", "look", "at", "barca", "again"].map((text, i) => ({ text: i === 5 || i === 12 ? text + "." : text, start_seconds: i * 0.5, end_seconds: i * 0.5 + 0.4 }));
      const result = await client.callTool({ name: "detect_repeated_takes", arguments: { word_timeline: { source_project_item_id: "A-roll.mp4", words }, frame_rate: 25 } });
      expect(result.isError).toBeFalsy();
      expect(data(result)).toMatchObject({ applied: false, routes: { companion: ["companion_stringout"] } });
      expect(existsSync(log)).toBe(false);
    } finally { await close(); }
  });

  it("gives every Companion result the same small receipt and caps large output", async () => {
    const { client, close } = await connect();
    try {
      const placed = await client.callTool({ name: "companion_place", arguments: { sequence: "199 - 01 Rough Cut", track: "V2" } });
      expect(data(placed)).toMatchObject({ command: "place", writer: "premiere-companion", target: { sequence: "199 - 01 Rough Cut" }, state: "done", jobId: "j1",
        changed: { placed: 1, items: "3 item(s)" }, recovery: { kind: "jobId", id: "j1", lookup: "companion_job" }, verified: expect.stringContaining("no read-back") });
      expect((placed as { structuredContent: { receipt: { outcome: string } } }).structuredContent.receipt.outcome).toBe("committed_unverified");

      const presets = await client.callTool({ name: "companion_presets_export", arguments: {} });
      const listing = data(presets);
      expect(listing).toMatchObject({ writer: null, changed: "nothing (read-only)", truncated: { limit: DETAIL_LIMIT } });
      expect(listing.detail).toHaveProperty("Folder 0");
      expect((listing.truncated as { characters: number }).characters).toBeGreaterThan(DETAIL_LIMIT);
      expect(JSON.stringify(listing.detail).length).toBeLessThanOrEqual(DETAIL_LIMIT);
      expect(JSON.stringify((presets as { content: { text: string }[] }).content).length).toBeLessThan(DETAIL_LIMIT + 4000);

      const refused = await client.callTool({ name: "companion_save", arguments: {} });
      expect(refused.isError).toBe(true);
      expect(data(refused)).toMatchObject({ command: "save", state: "guard-refused", changed: "nothing confirmed", outcome: "not_applied", retry: false, error: { code: "no-grant" } });
      expect((refused as { structuredContent: { receipt: { outcome: string } } }).structuredContent.receipt.outcome).toBe("not_applied");
    } finally { await close(); }
  });

  it("keeps the launcher on the same list", () => {
    expect(readFileSync(new URL("../scripts/junior-launch.mjs", import.meta.url), "utf8")).toContain("shortsToolList(manifest.tools)");
  });
});
