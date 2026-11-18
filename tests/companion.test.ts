import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companionArguments, getCompanionTools } from "../src/tools/companion.js";
import { guardToolHandler, isToolPermitted, resolveCapabilities } from "../src/security/capabilities.js";
import { setCompanionReadOnly } from "../src/companion-policy.js";
import { currentInvocation, withInvocationContext } from "../src/workflows/invocation-context.js";
import { mutationReceipt } from "../src/workflows/mutation-receipt.js";

const scratch: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tool = { name: "bin_move", description: "Move bins", argv: ["bin", "move"], positional: ["items"], inputSchema: {
  type: "object", properties: { items: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, to: { type: "string", minLength: 1 }, apply: { type: "boolean" } }, required: ["items", "to"], additionalProperties: false,
} };

describe("Companion integration", () => {
  it("preserves paths and shell metacharacters as separate argv values", () => {
    expect(companionArguments(tool, { items: ["a b", "$(echo nope)"], to: "x/y", apply: true })).toEqual(["bin", "move", "a b", "$(echo nope)", "--to", "x/y", "--apply", "--json"]);
  });
  it("rejects unknown arguments, flag injection and missing required arguments", () => {
    expect(() => companionArguments(tool, { items: ["--help"], to: "x" })).toThrow();
    expect(() => companionArguments(tool, { items: ["x"], to: "x", shell: "x" })).toThrow();
    expect(() => companionArguments(tool, { items: ["x"] })).toThrow();
  });
  it("preserves negative numeric values without accepting CLI flags", () => {
    expect(companionArguments(tool, { items: ["a"], to: "-6.5" })).toContain("-6.5");
    expect(() => companionArguments(tool, { items: ["a"], to: "-6--help" })).toThrow();
  });
  it("allows exactly one writer, including direct handler calls", async () => {
    vi.stubEnv("PREMIERE_COMPANION_CLI", "/fixture/companion.mjs");
    setCompanionReadOnly(["status"]); // as a manifest marking status readOnly: true would
    const handler = vi.fn(async () => ({ success: true }));
    const authority = resolveCapabilities("inspect,edit,export,filesystem");
    expect(isToolPermitted("companion_status", authority)).toBe(true);
    expect(isToolPermitted("companion_bin_move", authority)).toBe(true);
    expect(isToolPermitted("save_project", authority)).toBe(false);
    await expect(guardToolHandler("save_project", handler, authority)({})).rejects.toThrow("WRITER_DISABLED");
    expect(handler).not.toHaveBeenCalled();
    vi.stubEnv("PREMIERE_MCP_WRITER", "native");
    expect(isToolPermitted("companion_status", authority)).toBe(true);
    expect(isToolPermitted("companion_bin_move", authority)).toBe(false);
    await expect(guardToolHandler("companion_bin_move", handler, authority)({})).rejects.toThrow("WRITER_DISABLED");
    expect(handler).not.toHaveBeenCalled();
  });
  it("does not weaken inspection authority or permit unsafe script", async () => {
    vi.stubEnv("PREMIERE_COMPANION_CLI", "/fixture/companion.mjs");
    expect(isToolPermitted("companion_bin_move", resolveCapabilities("inspect"))).toBe(false);
    expect(isToolPermitted("execute_extendscript", resolveCapabilities())).toBe(false);
    vi.stubEnv("PREMIERE_MCP_WRITER", "typo");
    expect(() => isToolPermitted("companion_status", resolveCapabilities())).toThrow("PREMIERE_MCP_WRITER");
  });
  it("uses the manifest and preserves CLI failure without replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-check-")); scratch.push(dir);
    const cli = join(dir, "fake.mjs");
    writeFileSync(cli, `if(process.argv[2]==='mcp-manifest') console.log(JSON.stringify(${JSON.stringify({ name: "premiere-companion", tools: [tool] })})); else {console.log(JSON.stringify({code:'fenced',args:process.argv.slice(2)}));process.exit(5);}`);
    const tools = getCompanionTools(cli);
    expect(Object.keys(tools)).toEqual(["companion_bin_move"]);
    const result = await tools.companion_bin_move.handler({ items: ["a b"], to: "root" });
    expect(result).toMatchObject({ success: false, data: { exitCode: 5, outcome: "unknown", retry: false } });
    expect(result.error).toContain("fenced");
  });
  it("remains opt-in and rejects invalid configured paths", () => {
    vi.stubEnv("PREMIERE_COMPANION_CLI", "");
    expect(getCompanionTools()).toEqual({});
    expect(() => getCompanionTools("relative.mjs")).toThrow("absolute");
  });
  it("reports a completed Companion mutation as dispatched, never safe to replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-check-")); scratch.push(dir);
    const cli = join(dir, "fake.mjs");
    writeFileSync(cli, `if(process.argv[2]==='mcp-manifest') console.log(JSON.stringify(${JSON.stringify({ name: "premiere-companion", tools: [tool] })})); else console.log(JSON.stringify({state:'done',result:{moved:1}}));`);
    await withInvocationContext({}, async () => {
      const result = await getCompanionTools(cli).companion_bin_move.handler({ items: ["a"], to: "b", apply: true });
      expect(mutationReceipt(result.success, result.data, currentInvocation(), "companion_bin_move")).toMatchObject({ dispatch: "dispatched", outcome: "committed_unverified" });
    });
  });
  it("captures large CLI JSON even when the CLI exits immediately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "companion-check-")); scratch.push(dir);
    const cli = join(dir, "fake.mjs");
    writeFileSync(cli, `if(process.argv[2]==='mcp-manifest') console.log(JSON.stringify(${JSON.stringify({ name: "premiere-companion", tools: [tool] })})); else {console.log(JSON.stringify({state:'done',result:{text:'x'.repeat(300000)}}));process.exit(0);}`);
    const result = await getCompanionTools(cli).companion_bin_move.handler({ items: ["a"], to: "b" });
    expect(result).toMatchObject({ success: true, data: { state: "done", truncated: { characters: 300011 } } });
  });
});
