import { execFileSync, spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { companionAuthority, companionWriter } from "../companion-policy.js";
import { markHostDispatch } from "../workflows/invocation-context.js";

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

export function getCompanionTools(cli = process.env.PREMIERE_COMPANION_CLI) {
  if (!cli) return {};
  if (!isAbsolute(cli)) throw new Error("PREMIERE_COMPANION_CLI must be an absolute .mjs path");
  companionWriter();
  const manifest = JSON.parse(execFileSync(process.execPath, [cli, "mcp-manifest"], { encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 }));
  if (manifest.name !== "premiere-companion" || !Array.isArray(manifest.tools)) throw new Error("Invalid Premiere Companion manifest");
  const seen = new Set<string>();
  return Object.fromEntries((manifest.tools as CompanionTool[]).map(tool => {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || seen.has(tool.name) || !Array.isArray(tool.argv) || !tool.argv.every(x => typeof x === "string") || !Array.isArray(tool.positional) || !tool.inputSchema?.properties) throw new Error("Invalid or duplicate Companion tool");
    seen.add(tool.name);
    const name = "companion_" + tool.name;
    return [name, {
      description: `Premiere Companion: ${tool.description} Uses its existing locks, grants and job queue. Never retry an unknown outcome.`,
      parameters: tool.inputSchema,
      annotations: { readOnlyHint: companionAuthority(name)!.length === 1 },
      operationalCapability: {
        backend: "orchestrator", backends: ["orchestrator"], status: "supported",
        verificationBoundary: "bridge_response", hostVerificationRequired: true,
        notes: ["Uses the existing Companion CLI and its own grant, queue and readback checks; no upstream CEP dispatch."],
      },
      handler: async (args: unknown) => {
        const argv = companionArguments(tool, args);
        try {
          if (companionAuthority(name)!.length > 1) markHostDispatch();
          const { stdout } = await execute(cli, argv);
          return { success: true, data: JSON.parse(stdout) };
        } catch (cause) {
          const error = cause as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
          let result: unknown;
          try { result = JSON.parse(error.stdout ?? ""); } catch { /* Preserve non-JSON diagnostics below. */ }
          return { success: false, error: error.stdout?.trim() || error.stderr?.trim() || error.message,
            data: { exitCode: error.code ?? null, outcome: error.killed || error.code === 5 ? "unknown" : "failed", retry: false, result } };
        }
      },
    }];
  }));
}
