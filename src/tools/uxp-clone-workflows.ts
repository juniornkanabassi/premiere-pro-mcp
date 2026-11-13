import type { UxpWebSocketBridge } from "../bridge/uxp-websocket-bridge.js";
import { acceptingCamelTwins, panelSnapshot, withApplySnapshot } from "./uxp-apply-snapshot.js";

type ItemSnapshot = {
  project_item_id: string;
  start_seconds: number; end_seconds: number; in_seconds: number; out_seconds: number;
  duration_seconds: number; speed: number; reversed: boolean;
};

type CloneArgs = {
  action: "inspect" | "apply";
  media_type: "video" | "audio";
  track_index: number;
  clip_index: number;
  expected_snapshot?: {
    project_guid: string; sequence_id: string; media_type: "video" | "audio";
    track_index: number; clip_index: number; track_item_count: number; source: ItemSnapshot;
  };
  confirm_duplicate?: boolean;
  operation_id?: string;
  destination_seconds?: number;
  destination_track_index?: number;
};

const itemSnapshotProperties = {
  project_item_id: { type: "string", minLength: 1, maxLength: 512 },
  start_seconds: { type: "number", minimum: 0, maximum: 86400 },
  end_seconds: { type: "number", minimum: 0, maximum: 86400 },
  in_seconds: { type: "number", minimum: 0, maximum: 86400 },
  out_seconds: { type: "number", minimum: 0, maximum: 86400 },
  duration_seconds: { type: "number", minimum: 0, maximum: 86400 },
  speed: { type: "number", minimum: 0, maximum: 100 },
  reversed: { type: "boolean" },
} as const;
const itemSnapshotRequired = ["project_item_id", "start_seconds", "end_seconds", "in_seconds", "out_seconds", "duration_seconds", "speed", "reversed"];

function invoke(bridge: UxpWebSocketBridge, command: string, args: Record<string, unknown>) {
  return bridge.request(command, args)
    .then((result) => ({ success: true, data: { backend: "uxp", result } }))
    .catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
}

/** A bounded documented-UXP append-only counterpart to a timeline duplicate. */
const expectedSnapshotSchema = {
  type: "object",
  description: "The expected_snapshot object returned by inspect, passed unchanged.", additionalProperties: false,
  required: ["project_guid", "sequence_id", "media_type", "track_index", "clip_index", "track_item_count", "source"],
  properties: {
    project_guid: { type: "string", minLength: 1, maxLength: 128 }, sequence_id: { type: "string", minLength: 1, maxLength: 128 },
    media_type: { type: "string", enum: ["video", "audio"] }, track_index: { type: "integer", minimum: 0, maximum: 511 },
    clip_index: { type: "integer", minimum: 0, maximum: 511 }, track_item_count: { type: "integer", minimum: 1, maximum: 512 },
    source: { type: "object", additionalProperties: false, required: itemSnapshotRequired, properties: itemSnapshotProperties },
  },
};

export function getUxpCloneWorkflowTools(bridge: UxpWebSocketBridge) {
  return {
    duplicate_track_item_uxp: {
      description: "Inspect or duplicate one guarded audio or video clip using documented UXP SequenceEditor actions. By default it appends a copy after the final clip on the track. With destination_seconds and/or destination_track_index (same media type; an index equal to the video track count makes a new video track; a new audio track is refused as unproven) it copies any clip, not only the last, into that empty range instead: the time snaps to a sequence frame, the range is checked on the destination track and refused if anything overlaps it, and the copy is found afterwards by source item and start. Pass the same destination arguments to inspect and apply. Apply requires the complete source snapshot, explicit confirmation, and an operation ID; it serializes with guarded slips and slides on that track and commits one transaction. It never overwrites an occupied range and does not duplicate a linked A/V partner. It does not prove media handles, linked A/V synchronization, rendered frames, playback, persistence, or Undo behavior.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["inspect", "apply"] },
          media_type: { type: "string", enum: ["video", "audio"] },
          track_index: { type: "integer", minimum: 0, maximum: 511 },
          clip_index: { type: "integer", minimum: 0, maximum: 511, description: "The clip to duplicate. Without a destination it must be the final clip on the track." },
          expected_snapshot: acceptingCamelTwins(expectedSnapshotSchema),
          confirm_duplicate: { type: "boolean", description: "Must be true for action: apply." },
          operation_id: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$", description: "Required replay-safe operation identifier for action: apply." },
          destination_seconds: { type: "number", minimum: 0, maximum: 86400, description: "Timeline start of the copy. Omit to keep the source start (use with destination_track_index)." },
          destination_track_index: { type: "integer", minimum: 0, maximum: 511, description: "Track for the copy, same media type. Omit to stay on the source track." },
        },
        required: ["action", "media_type", "track_index", "clip_index"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      availability: {
        backend: "uxp", minimumPremiereVersion: "25.6.0", capability: "trackItem.clone.inspect|trackItem.clone",
        notes: ["Requires an authenticated UXP bridge whose runtime capability handshake advertises trackItem.clone.inspect and trackItem.clone.", "A verification failure can follow a committed host transaction; inspect the source and appended item before another edit."],
      },
      handler: async (args: CloneArgs) => {
        const target = {
          mediaType: args.media_type, trackIndex: args.track_index, clipIndex: args.clip_index,
          ...(args.destination_seconds === undefined ? {} : { destinationSeconds: args.destination_seconds }),
          ...(args.destination_track_index === undefined ? {} : { destinationTrackIndex: args.destination_track_index }),
        };
        if (args.action === "inspect") return withApplySnapshot(invoke(bridge, "trackItem.clone.inspect", target), expectedSnapshotSchema);
        if (args.action === "apply") return invoke(bridge, "trackItem.clone", {
          ...target, expectedSnapshot: panelSnapshot(args.expected_snapshot, expectedSnapshotSchema, "apply"),
          confirmDuplicate: args.confirm_duplicate, operationId: args.operation_id,
        });
        return { success: false, error: `Unsupported workflow action: ${String(args.action)}` };
      },
    },
  };
}
