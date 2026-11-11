# Personal Companion integration

This fork starts from upstream f8e666093701a286fadaed0795a4bfd341c1d0ee. It adds every tool from an installed Premiere Companion CLI manifest as `companion_<name>`, preserving the schema, CLI flags and error codes. It does not modify Companion or copy its Premiere-editing implementation.

Set `PREMIERE_COMPANION_CLI` to the absolute `bin/binboy.mjs` path and run `node scripts/junior-launch.mjs --mcp` for stdio MCP, or omit `--mcp` and pass Companion CLI arguments. Node 24 is required for this personal setup.

Default `PREMIERE_MCP_WRITER=companion` exposes the complete Companion catalogue and upstream diagnostics. All writes still need Companion’s original project grant and go through its queue. A project opened by hand does not gain a write grant merely because this adapter exists. Start it through Companion when editing is authorised, or use a disposable project first.

`PREMIERE_MCP_WRITER=native` exposes upstream tools and only known read-only Companion commands. A separate configured UXP or CEP connector is required. Native host execution is not proved by adapter tests. Do not enable it until the connector passes a disposable-project check. Raw scripts are excluded by the launcher in both modes. Do not start parallel native and Companion writer processes, or other uncoordinated controllers.

The central guard enforces the writer choice even when a tool is called without discovery. This is not OS sandboxing and cannot stop another process or the human editor. CLI exit 5 or timeout remains unknown and must not be automatically retried.

## Verification

`npm run build` and `npx vitest run tests/companion.test.ts tests/security-capabilities.test.ts tests/mcp-modernization.test.ts`. The new tests use only fake CLI processes and remove their temporary files. A built stdio probe should compare every `companion_` schema with `binboy mcp-manifest`, call local `companion_roots_list`, and confirm `companion_status` preserves `no-panel`/exit 4 with Premiere closed.

## Rollback

Remove the single MCP registration from each client and the personal launcher, preserving unrelated entries. The project’s local state folder records exact backups and verification. No Adobe or Companion installation is changed by this adapter.
