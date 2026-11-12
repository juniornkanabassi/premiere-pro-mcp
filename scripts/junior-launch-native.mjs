#!/usr/bin/env node
// Test-only launcher: the fork's own native editing, with every capability on (including raw ExtendScript).
// Premiere Companion tools are NOT loaded here, so there is still one writer per session. Telemetry stays off.
import { fileURLToPath } from 'node:url';
if (process.argv.slice(2).join(' ') !== '--mcp') throw new Error('Usage: premiere-ai-native --mcp');
delete process.env.POSTHOG_API_KEY;
delete process.env.PREMIERE_COMPANION_CLI;
delete process.env.PREMIERE_MCP_TOOL_LIST;
delete process.env.PREMIERE_MCP_TOOL_PACKS;
process.env.PREMIERE_MCP_CAPABILITIES = 'inspect,edit,export,filesystem,unsafe-script';
await import(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
