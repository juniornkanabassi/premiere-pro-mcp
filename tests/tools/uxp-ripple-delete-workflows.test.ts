import { describe, expect, it, vi } from "vitest";
import { getUxpRippleDeleteWorkflowTools } from "../../src/tools/uxp-ripple-delete-workflows.js";
import type { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";

const target = { project_item_id: "target-1", start_seconds: 0, end_seconds: 10, in_seconds: 20, out_seconds: 30, duration_seconds: 10, speed: 1, reversed: false };
const following = { project_item_id: "following-1", start_seconds: 10, end_seconds: 20, in_seconds: 40, out_seconds: 50, duration_seconds: 10, speed: 1, reversed: false };

describe("public guarded contiguous track-item ripple-delete MCP tool", () => {
  it("uses closed target and successor snapshot schemas and translates snake_case apply arguments", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "verified" });
    const tool = getUxpRippleDeleteWorkflowTools({ request } as unknown as UxpWebSocketBridge).ripple_delete_track_item_uxp;
    expect(tool.parameters).toMatchObject({
      additionalProperties: false, required: ["action", "media_type", "track_index", "clip_index"],
      properties: { action: { enum: ["inspect", "apply"] }, expected_snapshot: { additionalProperties: false } },
    });
    await tool.handler({
      action: "apply", media_type: "video", track_index: 0, clip_index: 0, confirm_ripple_delete: true, operation_id: "ripple-tool-1",
      expected_snapshot: { project_guid: "project-1", sequence_id: "sequence-1", media_type: "video", track_index: 0, clip_index: 0, track_item_count: 2, target, following },
    });
    expect(request).toHaveBeenCalledWith("trackItem.rippleDelete", {
      mediaType: "video", trackIndex: 0, clipIndex: 0, confirmRippleDelete: true, operationId: "ripple-tool-1",
      expectedSnapshot: {
        projectGuid: "project-1", sequenceId: "sequence-1", mediaType: "video", trackIndex: 0, clipIndex: 0, trackItemCount: 2,
        target: { projectItemId: "target-1", startSeconds: 0, endSeconds: 10, inSeconds: 20, outSeconds: 30, durationSeconds: 10, speed: 1, reversed: false },
        following: { projectItemId: "following-1", startSeconds: 10, endSeconds: 20, inSeconds: 40, outSeconds: 50, durationSeconds: 10, speed: 1, reversed: false },
      },
    });
  });

  it("does not silently drop unknown fields from a reviewed successor snapshot", async () => {
    const request = vi.fn();
    const tool = getUxpRippleDeleteWorkflowTools({ request } as unknown as UxpWebSocketBridge).ripple_delete_track_item_uxp;
    await expect(tool.handler({
      action: "apply", media_type: "video", track_index: 0, clip_index: 0,
      expected_snapshot: { project_guid: "project-1", sequence_id: "sequence-1", media_type: "video", track_index: 0, clip_index: 0, track_item_count: 2, target, following: { ...following, unexpected: true } },
    })).rejects.toThrow("expected_snapshot.following has an unknown field: unexpected");
    expect(request).not.toHaveBeenCalled();
  });

  it("exposes remove, razor and extract tools that translate snake_case arguments", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "verified" });
    const tools = getUxpRippleDeleteWorkflowTools({ request } as unknown as UxpWebSocketBridge);
    expect(tools.remove_track_items_uxp.parameters.required).toEqual(["items", "confirm_remove", "operation_id"]);
    expect(tools.razor_track_item_uxp.parameters.required).toEqual(["time_seconds", "confirm_razor", "operation_id"]);
    expect(tools.extract_timeline_range_uxp.parameters.required).toEqual(["start_seconds", "end_seconds", "confirm_extract", "operation_id"]);

    await tools.remove_track_items_uxp.handler({
      items: [{ media_type: "video", track_index: 0, clip_index: 2, expected_project_item_id: "p1", expected_start_ticks: "123" }], ripple: true, confirm_remove: true, operation_id: "rm-1",
    });
    expect(request).toHaveBeenLastCalledWith("trackItems.remove", {
      items: [{ mediaType: "video", trackIndex: 0, clipIndex: 2, expectedProjectItemId: "p1", expectedStartTicks: "123" }], ripple: true, confirmRemove: true, operationId: "rm-1",
    });
    await tools.razor_track_item_uxp.handler({ media_type: "audio", track_index: 1, clip_index: 0, time_seconds: 4.5, confirm_razor: true, operation_id: "rz-1" });
    expect(request).toHaveBeenLastCalledWith("trackItem.razor", { mediaType: "audio", trackIndex: 1, clipIndex: 0, timeSeconds: 4.5, confirmRazor: true, operationId: "rz-1" });
    await tools.razor_track_item_uxp.handler({ all_tracks: true, time_seconds: 4, confirm_razor: true, operation_id: "rz-2" });
    expect(request).toHaveBeenLastCalledWith("trackItem.razor", { allTracks: true, timeSeconds: 4, confirmRazor: true, operationId: "rz-2" });
    await tools.extract_timeline_range_uxp.handler({ start_seconds: 20, end_seconds: 22, video_tracks: [0, 1], confirm_extract: true, operation_id: "ex-1" });
    expect(request).toHaveBeenLastCalledWith("timeline.range.extract", { startSeconds: 20, endSeconds: 22, videoTracks: [0, 1], confirmExtract: true, operationId: "ex-1" });
  });

  it("rejects an unknown field on a removal coordinate instead of dropping it", async () => {
    const request = vi.fn();
    const tools = getUxpRippleDeleteWorkflowTools({ request } as unknown as UxpWebSocketBridge);
    await expect(tools.remove_track_items_uxp.handler({
      items: [{ media_type: "video", track_index: 0, clip_index: 0, surprise: 1 } as never], confirm_remove: true, operation_id: "rm-2",
    })).rejects.toThrow("items[] has an unknown field: surprise");
    expect(request).not.toHaveBeenCalled();
  });

  it("marks the project-item guard required and passes the start in seconds through", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "verified" });
    const tool = getUxpRippleDeleteWorkflowTools({ request } as unknown as UxpWebSocketBridge).remove_track_items_uxp;
    expect(tool.parameters.properties.items.items.required).toContain("expected_project_item_id");
    // The panel, not this wrapper, refuses a missing start guard (tested in tests/uxp), so the call is forwarded unchanged.
    await tool.handler({ items: [{ media_type: "video", track_index: 0, clip_index: 0, expected_project_item_id: "p1", expected_start_seconds: 12.5 }], confirm_remove: true, operation_id: "rm-4" });
    expect(request).toHaveBeenCalledWith("trackItems.remove", { items: [{ mediaType: "video", trackIndex: 0, clipIndex: 0, expectedProjectItemId: "p1", expectedStartSeconds: 12.5 }], confirmRemove: true, operationId: "rm-4" });
  });
});
