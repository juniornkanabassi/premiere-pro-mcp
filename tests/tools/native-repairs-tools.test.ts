// Lane E (native route repairs): server-side tool mappings for point keyframes, snapshot keys and immediate exports.
import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { getUxpTools } from "../../src/tools/uxp.js";
import type { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";

function tools() {
  const request = vi.fn().mockResolvedValue({ outcome: "verified" });
  return { request, tools: getUxpTools({ request, getState: vi.fn() } as unknown as UxpWebSocketBridge) as Record<string, any> };
}
const target = { media_type: "video", track_index: 0, clip_index: 1, component_index: 2, param_index: 3 };
const valid = async (tool: { parameters: unknown }, args: Record<string, unknown>) => fromJsonSchema(tool.parameters as JsonSchemaType)["~standard"].validate(args);

describe("automate_effect_parameters_uxp add_keyframe with a point", () => {
  it("passes point to the panel for add_keyframe only and says keyframe times are clip media time", async () => {
    const { request, tools: all } = tools();
    const tool = all.automate_effect_parameters_uxp;
    expect(tool.description).toContain("media time");
    const args = { action: "add_keyframe", ...target, time_seconds: 1, point: { x: 0.1, y: 0.5 }, operation_id: "slide-1" };
    expect(await valid(tool, args)).not.toHaveProperty("issues");
    await tool.handler(args);
    expect(request).toHaveBeenLastCalledWith("parameters.keyframeAdd", expect.objectContaining({ point: { x: 0.1, y: 0.5 }, timeSeconds: 1, operationId: "slide-1" }));
    await tool.handler({ action: "add_keyframe", ...target, time_seconds: 2, value: 50, operation_id: "scale" });
    expect(request).toHaveBeenLastCalledWith("parameters.keyframeAdd", expect.objectContaining({ value: 50 }));
    expect(request.mock.calls.at(-1)![1]).not.toHaveProperty("point");
    await tool.handler({ action: "set_value", ...target, value: 1, point: { x: 0, y: 0 }, operation_id: "v" });
    expect(request.mock.calls.at(-1)![1]).not.toHaveProperty("point");
  });
});

describe("set_point_value takes the inspect snapshot in either key style", () => {
  const camel = { projectId: "project-1", sequenceId: "sequence-1", mediaType: "video", trackIndex: 0, clipIndex: 1, componentIndex: 2, componentId: "ADBE Motion", paramIndex: 3, paramName: "Position", timeVarying: false, point: { x: 960, y: 540 } };
  const panelShape = { ...camel };
  it("accepts the raw camelCase inspect result (the 196 run's 'unknown arguments projectId')", async () => {
    const { request, tools: all } = tools();
    const args = { action: "set_point_value", ...target, point: { x: 1, y: 2 }, confirm_set_point: true, expected_point_snapshot: camel, operation_id: "p1" };
    expect(await valid(all.automate_effect_parameters_uxp, args)).not.toHaveProperty("issues");
    await expect(all.automate_effect_parameters_uxp.handler(args)).resolves.toMatchObject({ success: true });
    expect(request).toHaveBeenLastCalledWith("parameters.point.set", expect.objectContaining({ expectedSnapshot: panelShape }));
  });
  it("refuses a snapshot with a missing or unknown field before calling the panel", async () => {
    const { request, tools: all } = tools();
    const { paramName: _drop, ...missing } = camel;
    await expect(all.automate_effect_parameters_uxp.handler({ action: "set_point_value", ...target, point: { x: 1, y: 2 }, confirm_set_point: true, expected_point_snapshot: missing, operation_id: "p2" })).resolves.toMatchObject({ success: false, error: expect.stringContaining("param_name is required") });
    expect(await valid(all.automate_effect_parameters_uxp, { action: "set_point_value", ...target, expected_point_snapshot: { ...camel, extra: 1 } })).toHaveProperty("issues");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("encode_media_uxp", () => {
  it("waits long enough for an immediate sequence export, and preflight sends only what preflight takes", async () => {
    const { request, tools: all } = tools();
    await all.encode_media_uxp.handler({ action: "sequence", sequence_id: "s", output_file: "/w/out.mp4", preset_file: "/w/p.epr", export_type: "immediately", confirm_external_write: true, operation_id: "e1" });
    expect(request).toHaveBeenLastCalledWith("encoder.sequence", expect.anything(), { minimumTimeoutMs: 30 * 60_000 + 5_000 });
    await all.encode_media_uxp.handler({ action: "sequence", sequence_id: "s", output_file: "/w/out.mp4", preset_file: "/w/p.epr", export_type: "queue_to_ame", confirm_external_write: true, operation_id: "e2" });
    expect(request.mock.calls.at(-1)).toHaveLength(2);
    await all.encode_media_uxp.handler({ action: "preflight", sequence_id: "s", preset_file: "/w/p.epr", output_file: "/w/out.mp4", export_type: "immediately" });
    expect(request).toHaveBeenLastCalledWith("encoder.preflight", { sequenceId: "s", presetFile: "/w/p.epr" });
  });
});
