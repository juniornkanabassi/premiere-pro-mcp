import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companionReceipt, DETAIL_LIMIT, getCompanionTools } from "../src/tools/companion.js";
import { companionAuthority } from "../src/companion-policy.js";
import { mutationReceipt } from "../src/workflows/mutation-receipt.js";
import { buildPremiereInstructions } from "../src/workflows/agent-instructions.js";

// Reply shapes copied from Companion 1.11.0 bin/binboy.mjs (presets, roots, refresh, export, panel job envelope).
const schema = (properties: Record<string, unknown> = {}) => ({ type: "object", properties, required: [], additionalProperties: false });
const tool = (name: string, argv: string[], properties: Record<string, unknown> = {}, readOnly?: boolean) =>
  ({ name, description: name, argv, positional: [], inputSchema: schema(properties), ...(readOnly ? { readOnly } : {}) });
const receipt = (t: ReturnType<typeof tool>, output: unknown, args: Record<string, unknown> = {}) => companionReceipt(t as never, args, output, t.readOnly !== true);
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

  it("gives a queued refresh its refresh id and no job lookup", () => {
    const r = receipt(tool("refresh", ["refresh"], { wait: { type: "boolean" } }), { refreshId: "r-1", state: "queued" });
    expect(r.recovery).toMatchObject({ id: "r-1", kind: "refreshId" });
    expect(r.jobId).toBeNull();
    expect(String(r.verified)).not.toContain("companion_job");
    expect(String(r.verified)).toContain("wait");
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
    const status = receipt(tool("autosync", ["autosync"], { mode: { type: "string" } }), { autoSync: true, watchers: [] }, { mode: "status" });
    expect(status.outcome).toBe("committed_unverified");
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
    expect(JSON.stringify(r.detail)).toContain("media offline");
  });
});

describe("Companion read-only authority comes from the manifest", () => {
  it("honours readOnly and treats a missing flag as a writer, whatever the name", () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-ro-")); scratch.push(dir);
    const cli = join(dir, "fake.cjs");
    const tools = [tool("status", ["bin", "move"]), tool("first_cut", ["first-cut"], {}, true), tool("timeline", ["timeline"], {}, true)];
    writeFileSync(cli, `console.log(JSON.stringify(${JSON.stringify({ name: "premiere-companion", tools })}))`);
    vi.stubEnv("PREMIERE_COMPANION_CLI", cli);
    const registered = getCompanionTools(cli) as Record<string, { annotations: { readOnlyHint: boolean } }>;
    expect(registered.companion_status.annotations.readOnlyHint).toBe(false);
    expect(companionAuthority("companion_status")).toHaveLength(4);
    expect(registered.companion_first_cut.annotations.readOnlyHint).toBe(true);
    expect(companionAuthority("companion_first_cut")).toEqual(["inspect"]);
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
