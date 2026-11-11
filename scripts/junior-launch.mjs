#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { companionWriter } from '../dist/companion-policy.js';
const cli = process.env.PREMIERE_COMPANION_CLI;
if (!cli || !cli.startsWith('/')) throw new Error('Set PREMIERE_COMPANION_CLI to the installed Companion bin/binboy.mjs absolute path');
const args = process.argv.slice(2);
if (args[0] !== '--mcp') {
  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} else {
  if (args.length !== 1) throw new Error('Usage: premiere-ai --mcp, or premiere-ai <Companion command>');
  const writer = companionWriter();
  delete process.env.POSTHOG_API_KEY;
  delete process.env.PREMIERE_MCP_TOOL_PACKS;
  process.env.PREMIERE_MCP_CAPABILITIES = writer === 'companion' ? 'inspect,edit,export,filesystem' : 'inspect';
  if (writer === 'companion') {
    const manifest = JSON.parse(execFileSync(process.execPath, [cli, 'mcp-manifest'], { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 }));
    process.env.PREMIERE_MCP_TOOL_LIST = manifest.tools.map(t => 'companion_' + t.name).join(',');
  } else {
    delete process.env.PREMIERE_MCP_TOOL_LIST;
  }
  await import(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
}
