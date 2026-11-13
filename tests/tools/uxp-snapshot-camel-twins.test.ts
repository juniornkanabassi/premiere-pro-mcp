import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../../src/server.js";
import type { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";

// inspect returns the panel's camelCase keys; the tools must take that result back unchanged, as well as the
// snake_case expected_snapshot inspect attaches, through the server's own schema check (live 27.0: ripple
// delete rejected the raw inspect result).
const item = { project_item_id: "item-1", start_seconds: 10, end_seconds: 20, in_seconds: 20, out_seconds: 30, duration_seconds: 10, speed: 1, reversed: false };
const itemNoId = { start_seconds: 10, end_seconds: 20, in_seconds: 20, out_seconds: 30, duration_seconds: 10, speed: 1, reversed: false };
const base = { project_guid: "project-1", sequence_id: "sequence-1", media_type: "video", track_index: 0, clip_index: 1 };
const placement = { media_type: "video", source_track_index: 0, target_track_index: 1, name: "Nest", project_item_id: "item-1", start_ticks: "0", end_ticks: "254016000000", in_ticks: "0", out_ticks: "254016000000", disabled: false };
const reference = { media_type: "video", track_index: 0, clip_index: 1, start_ticks: "0", end_ticks: "254016000000", in_ticks: "0", out_ticks: "254016000000" };

const camel = (key: string) => key.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase());
function toCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamel);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [camel(key), toCamel(child)]));
}

type Family = { tool: string; command: string; args: Record<string, unknown>; snapshot: Record<string, unknown> };
const families: Family[] = [
  { tool: "ripple_delete_track_item_uxp", command: "trackItem.rippleDelete", args: { action: "apply", media_type: "video", track_index: 0, clip_index: 1, confirm_ripple_delete: true, operation_id: "t-ripple" },
    snapshot: { ...base, track_item_count: 3, target: item, following: { ...item, project_item_id: "item-2", start_seconds: 20, end_seconds: 30 } } },
  { tool: "slip_track_item_uxp", command: "trackItem.slip", args: { action: "apply", media_type: "video", track_index: 0, clip_index: 1, slip_by_seconds: 1, confirm_slip: true, operation_id: "t-slip" },
    snapshot: { ...base, ...itemNoId } },
  { tool: "slide_track_item_uxp", command: "trackItem.slide", args: { action: "apply", media_type: "video", track_index: 0, clip_index: 1, slide_by_seconds: 1, confirm_slide: true, operation_id: "t-slide" },
    snapshot: { ...base, previous: itemNoId, target: itemNoId, following: itemNoId } },
  { tool: "duplicate_track_item_uxp", command: "trackItem.clone", args: { action: "apply", media_type: "video", track_index: 0, clip_index: 1, confirm_duplicate: true, operation_id: "t-dup" },
    snapshot: { ...base, track_item_count: 2, source: item } },
  { tool: "unnest_sequence_uxp", command: "sequence.unnest", args: { action: "apply", media_type: "video", track_index: 0, clip_index: 1, confirm_unnest: true, operation_id: "t-unnest" },
    snapshot: { project_guid: "project-1", sequence_id: "sequence-1", nested_sequence_id: "nested-1", nested_sequence_name: "Nest", references: [reference], offset_ticks: "0", clones: [placement] } },
  { tool: "manage_sequence_preview_frame_uxp", command: "sequence.previewFrame.update", args: { action: "update", sequence_id: "sequence-1", preview_width: 640, preview_height: 360, confirm_set_preview_frame: true, operation_id: "t-preview" },
    snapshot: { project_guid: "project-1", sequence_id: "sequence-1", preview_width: 1280, preview_height: 720 } },
  { tool: "manage_timeline_source_label_uxp", command: "timeline.sourceLabel.update", args: { action: "update", media_type: "video", track_index: 0, clip_index: 1, color_index: 3, confirm_set_label: true, operation_id: "t-label" },
    snapshot: { ...base, track_item_count: 2, source_project_item_id: "item-1", source_color_label_index: 1, start_seconds: 10, end_seconds: 20 } },
];

async function connect(request: ReturnType<typeof vi.fn>) {
  const bridge = { request, getState: vi.fn(() => ({ status: "listening", connected: true })) } as unknown as UxpWebSocketBridge;
  const server = createServer({}, { uxpBridge: bridge });
  const client = new Client({ name: "camel-twins-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("inspect results go back to apply unchanged, through the server schema", () => {
  for (const family of families) {
    it(`${family.tool} accepts the camelCase inspect result and the snake_case snapshot`, async () => {
      const request = vi.fn().mockResolvedValue({ outcome: "verified" });
      const client = await connect(request);
      try {
        const panelShape = toCamel(family.snapshot);
        for (const shape of [family.snapshot, panelShape]) {
          request.mockClear();
          const result = await client.callTool({ name: family.tool, arguments: { ...family.args, expected_snapshot: shape } });
          expect(JSON.stringify(result.content)).not.toMatch(/INVALID_ARGUMENT|must have required|unknown field|not allowed/i);
          expect(request).toHaveBeenCalledTimes(1);
          expect(request.mock.calls[0][0]).toBe(family.command);
          expect(request.mock.calls[0][1].expectedSnapshot).toEqual(panelShape);
        }
        // An unknown field is still refused before anything reaches the panel.
        request.mockClear();
        const refused = await client.callTool({ name: family.tool, arguments: { ...family.args, expected_snapshot: { ...(toCamel(family.snapshot) as object), bogus: 1 } } });
        expect(JSON.stringify(refused.content)).toMatch(/bogus|unknown|INVALID_ARGUMENT|not allowed/i);
        expect(request).not.toHaveBeenCalled();
        // So is a snapshot with a field missing.
        const first = Object.keys(family.snapshot)[0]!;
        const { [first]: _dropped, ...incomplete } = family.snapshot;
        const missing = await client.callTool({ name: family.tool, arguments: { ...family.args, expected_snapshot: incomplete } });
        expect(JSON.stringify(missing.content)).toMatch(new RegExp(`${first}.*required|required.*${first}`, "i"));
        expect(request).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    });
  }
});
