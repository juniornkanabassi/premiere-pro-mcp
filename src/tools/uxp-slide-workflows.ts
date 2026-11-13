import type { UxpWebSocketBridge } from "../bridge/uxp-websocket-bridge.js";
import { acceptingCamelTwins, panelSnapshot, withApplySnapshot } from "./uxp-apply-snapshot.js";

type ItemSnapshot = {
  start_seconds: number; end_seconds: number; in_seconds: number; out_seconds: number;
  duration_seconds: number; speed: number; reversed: boolean;
};

type SlideArgs = {
  action: "inspect" | "apply";
  media_type: "video" | "audio";
  track_index: number;
  clip_index: number;
  expected_snapshot?: {
    project_guid: string; sequence_id: string; media_type: "video" | "audio"; track_index: number; clip_index: number;
    previous: ItemSnapshot; target: ItemSnapshot; following: ItemSnapshot;
  };
  slide_by_seconds?: number;
  confirm_slide?: boolean;
  operation_id?: string;
};

const itemSnapshotProperties = {
  start_seconds: { type: "number", minimum: 0, maximum: 86400 },
  end_seconds: { type: "number", minimum: 0, maximum: 86400 },
  in_seconds: { type: "number", minimum: 0, maximum: 86400 },
  out_seconds: { type: "number", minimum: 0, maximum: 86400 },
  duration_seconds: { type: "number", minimum: 0, maximum: 86400 },
  speed: { type: "number", minimum: 0, maximum: 100 },
  reversed: { type: "boolean" },
} as const;
const itemSnapshotRequired = ["start_seconds", "end_seconds", "in_seconds", "out_seconds", "duration_seconds", "speed", "reversed"];

function invoke(bridge: UxpWebSocketBridge, command: string, args: Record<string, unknown>) {
  return bridge.request(command, args)
    .then((result) => ({ success: true, data: { backend: "uxp", result } }))
    .catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
}

/** A bounded documented-UXP composition for one contiguous three-item slide. */
const expectedSnapshotSchema = {
  type: "object", additionalProperties: false,
  description: "The expected_snapshot object returned by inspect, passed unchanged.",
  required: ["project_guid", "sequence_id", "media_type", "track_index", "clip_index", "previous", "target", "following"],
  properties: {
    project_guid: { type: "string", minLength: 1, maxLength: 128 }, sequence_id: { type: "string", minLength: 1, maxLength: 128 },
    media_type: { type: "string", enum: ["video", "audio"] }, track_index: { type: "integer", minimum: 0, maximum: 511 }, clip_index: { type: "integer", minimum: 0, maximum: 511 },
    previous: { type: "object", additionalProperties: false, required: itemSnapshotRequired, properties: itemSnapshotProperties },
    target: { type: "object", additionalProperties: false, required: itemSnapshotRequired, properties: itemSnapshotProperties },
    following: { type: "object", additionalProperties: false, required: itemSnapshotRequired, properties: itemSnapshotProperties },
  },
};

export function getUxpSlideWorkflowTools(bridge: UxpWebSocketBridge) {
  return {
    slide_track_item_uxp: {
      description: "Inspect or perform one guarded slide on an audio or video timeline item using documented UXP track-item actions. Apply requires the complete three-item snapshot, explicit confirmation, and an operation ID; it serializes slides and source-only slips on the affected track, commits one transaction, and verifies every affected source and timeline boundary. Only contiguous forward 1x clips are supported. It does not prove source handles, linked A/V synchronization, rendered frames, playback, persistence, or Undo behavior.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["inspect", "apply"] },
          media_type: { type: "string", enum: ["video", "audio"] },
          track_index: { type: "integer", minimum: 0, maximum: 511 },
          clip_index: { type: "integer", minimum: 0, maximum: 511, description: "The center item. It must have immediate previous and following clip items on the same track." },
          expected_snapshot: acceptingCamelTwins(expectedSnapshotSchema),
          slide_by_seconds: { type: "number", minimum: -60, maximum: 60, description: "Non-zero offset. Positive moves the center item later and lengthens the previous neighbour." },
          confirm_slide: { type: "boolean", description: "Must be true for action: apply." },
          operation_id: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$", description: "Required replay-safe operation identifier for action: apply." },
        },
        required: ["action", "media_type", "track_index", "clip_index"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      availability: {
        backend: "uxp", minimumPremiereVersion: "25.6.0", capability: "trackItem.slide.inspect|trackItem.slide",
        notes: ["Requires an authenticated UXP bridge whose runtime capability handshake advertises trackItem.slide.inspect and trackItem.slide.", "A verification failure can follow a committed host transaction; inspect all three items before another edit."],
      },
      handler: async (args: SlideArgs) => {
        const target = { mediaType: args.media_type, trackIndex: args.track_index, clipIndex: args.clip_index };
        if (args.action === "inspect") return withApplySnapshot(invoke(bridge, "trackItem.slide.inspect", target), expectedSnapshotSchema);
        if (args.action === "apply") return invoke(bridge, "trackItem.slide", {
          ...target, expectedSnapshot: panelSnapshot(args.expected_snapshot, expectedSnapshotSchema, "apply"), slideBySeconds: args.slide_by_seconds,
          confirmSlide: args.confirm_slide, operationId: args.operation_id,
        });
        return { success: false, error: `Unsupported workflow action: ${String(args.action)}` };
      },
    },
  };
}
