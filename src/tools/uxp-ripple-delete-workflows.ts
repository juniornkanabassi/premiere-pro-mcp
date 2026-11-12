import type { UxpWebSocketBridge } from "../bridge/uxp-websocket-bridge.js";
import { withApplySnapshot } from "./uxp-apply-snapshot.js";

type ItemSnapshot = {
  project_item_id: string;
  start_seconds: number; end_seconds: number; in_seconds: number; out_seconds: number;
  duration_seconds: number; speed: number; reversed: boolean;
};

type RippleDeleteArgs = {
  action: "inspect" | "apply";
  media_type: "video" | "audio";
  track_index: number;
  clip_index: number;
  expected_snapshot?: {
    project_guid: string; sequence_id: string; media_type: "video" | "audio";
    track_index: number; clip_index: number; track_item_count: number;
    target: ItemSnapshot; following: ItemSnapshot;
  };
  confirm_ripple_delete?: boolean;
  operation_id?: string;
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

function strictItemSnapshot(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!(key in itemSnapshotProperties)) throw new Error(`${name} has an unknown field: ${key}`);
  for (const key of itemSnapshotRequired) if (!(key in record)) throw new Error(`${name}.${key} is required`);
  return {
    projectItemId: record.project_item_id,
    startSeconds: record.start_seconds, endSeconds: record.end_seconds, inSeconds: record.in_seconds,
    outSeconds: record.out_seconds, durationSeconds: record.duration_seconds, speed: record.speed, reversed: record.reversed,
  };
}

function expectedRippleSnapshot(value: RippleDeleteArgs["expected_snapshot"]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected_snapshot is required for action: apply");
  const record = value as Record<string, unknown>;
  const allowed = ["project_guid", "sequence_id", "media_type", "track_index", "clip_index", "track_item_count", "target", "following"];
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`expected_snapshot has an unknown field: ${key}`);
  for (const key of allowed) if (!(key in record)) throw new Error(`expected_snapshot.${key} is required`);
  return {
    projectGuid: record.project_guid, sequenceId: record.sequence_id, mediaType: record.media_type,
    trackIndex: record.track_index, clipIndex: record.clip_index, trackItemCount: record.track_item_count,
    target: strictItemSnapshot(record.target, "expected_snapshot.target"),
    following: strictItemSnapshot(record.following, "expected_snapshot.following"),
  };
}

/** A bounded documented-UXP ripple delete with contiguous-successor readback. */
const expectedSnapshotSchema = {
  type: "object", additionalProperties: false,
  description: "The expected_snapshot object returned by inspect, passed unchanged.",
  required: ["project_guid", "sequence_id", "media_type", "track_index", "clip_index", "track_item_count", "target", "following"],
  properties: {
    project_guid: { type: "string", minLength: 1, maxLength: 128 }, sequence_id: { type: "string", minLength: 1, maxLength: 128 },
    media_type: { type: "string", enum: ["video", "audio"] }, track_index: { type: "integer", minimum: 0, maximum: 511 },
    clip_index: { type: "integer", minimum: 0, maximum: 510 }, track_item_count: { type: "integer", minimum: 2, maximum: 512 },
    target: { type: "object", additionalProperties: false, required: itemSnapshotRequired, properties: itemSnapshotProperties },
    following: { type: "object", additionalProperties: false, required: itemSnapshotRequired, properties: itemSnapshotProperties },
  },
};

const operationIdSchema = { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$", description: "Required replay-safe operation identifier." } as const;
const trackIndexList = { type: "array", maxItems: 64, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 511 } } as const;
const seconds = { type: "number", minimum: 0, maximum: 86400 } as const;

type RemoveItemsArgs = {
  items: Array<{ media_type: "video" | "audio"; track_index: number; clip_index: number; expected_project_item_id?: string; expected_start_ticks?: string }>;
  ripple?: boolean; confirm_remove?: boolean; operation_id?: string;
};
type RazorArgs = {
  media_type?: "video" | "audio"; track_index?: number; clip_index?: number; all_tracks?: boolean;
  time_seconds: number; confirm_razor?: boolean; operation_id?: string;
};
type ExtractArgs = {
  start_seconds: number; end_seconds: number; video_tracks?: number[]; audio_tracks?: number[];
  confirm_extract?: boolean; operation_id?: string;
};

function removeItemCoordinate(item: RemoveItemsArgs["items"][number]) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("items[] must be objects");
  const allowed = ["media_type", "track_index", "clip_index", "expected_project_item_id", "expected_start_ticks"];
  for (const key of Object.keys(item)) if (!allowed.includes(key)) throw new Error(`items[] has an unknown field: ${key}`);
  return {
    mediaType: item.media_type, trackIndex: item.track_index, clipIndex: item.clip_index,
    ...(item.expected_project_item_id === undefined ? {} : { expectedProjectItemId: item.expected_project_item_id }),
    ...(item.expected_start_ticks === undefined ? {} : { expectedStartTicks: item.expected_start_ticks }),
  };
}

export function getUxpRippleDeleteWorkflowTools(bridge: UxpWebSocketBridge) {
  return {
    remove_track_items_uxp: {
      description: "Remove timeline items by coordinate, optionally closing the gaps. With ripple: true each edited track is closed up by moving later items by the exact removed length (Premiere's own ripple shifts whole frames and its overlap flag is unreliable, so it is not used); items on other tracks, such as a linked partner, are not moved. Reads every edited track back against the planned layout and reports verified, or committed_unverified with the Undo count. Optional expected_project_item_id / expected_start_ticks guard each coordinate against a stale view. Needs confirm_remove and an operation ID.",
      parameters: {
        type: "object" as const, additionalProperties: false,
        properties: {
          items: {
            type: "array", minItems: 1, maxItems: 512,
            items: {
              type: "object", additionalProperties: false, required: ["media_type", "track_index", "clip_index"],
              properties: {
                media_type: { type: "string", enum: ["video", "audio"] },
                track_index: { type: "integer", minimum: 0, maximum: 511 }, clip_index: { type: "integer", minimum: 0, maximum: 511 },
                expected_project_item_id: { type: "string", minLength: 1, maxLength: 512 },
                expected_start_ticks: { type: "string", pattern: "^\\d{1,30}$", description: "Tick string of the clip's reviewed start." },
              },
            },
          },
          ripple: { type: "boolean", description: "Close the gaps on the edited tracks. Default false." },
          confirm_remove: { type: "boolean", description: "Must be true." },
          operation_id: operationIdSchema,
        },
        required: ["items", "confirm_remove", "operation_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      availability: { backend: "uxp", minimumPremiereVersion: "25.6.0", capability: "trackItems.remove", notes: ["Selections are built inside one lockedAccess callback; a failure after a committed step returns committed_unverified."] },
      handler: async (args: RemoveItemsArgs) => {
        if (!Array.isArray(args.items)) throw new Error("items must be an array");
        return invoke(bridge, "trackItems.remove", {
          items: args.items.map(removeItemCoordinate), ...(args.ripple === undefined ? {} : { ripple: args.ripple }),
          confirmRemove: args.confirm_remove, operationId: args.operation_id,
        });
      },
    },
    razor_track_item_uxp: {
      description: "Split timeline items at a time (razor). Give media_type, track_index and clip_index for one item, or all_tracks: true to cut every item that crosses the time. The time snaps to a sequence frame. Built from documented actions (clone parked past the end, trim, move back), so it takes 3 Undo steps. Refuses retimed or reversed items. A linked video and audio pair is cut only where you ask (use all_tracks for both) and the halves are not re-linked, which the receipt says. Needs confirm_razor and an operation ID.",
      parameters: {
        type: "object" as const, additionalProperties: false,
        properties: {
          media_type: { type: "string", enum: ["video", "audio"] },
          track_index: { type: "integer", minimum: 0, maximum: 511 }, clip_index: { type: "integer", minimum: 0, maximum: 511 },
          all_tracks: { type: "boolean", description: "Cut every item crossing time_seconds, on every track. Use instead of the three coordinates." },
          time_seconds: seconds, confirm_razor: { type: "boolean", description: "Must be true." }, operation_id: operationIdSchema,
        },
        required: ["time_seconds", "confirm_razor", "operation_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      availability: { backend: "uxp", minimumPremiereVersion: "25.6.0", capability: "trackItem.razor", notes: ["Three undoable transactions per cut; a failure part way returns committed_unverified with the Undo count."] },
      handler: async (args: RazorArgs) => invoke(bridge, "trackItem.razor", {
        ...(args.media_type === undefined ? {} : { mediaType: args.media_type }),
        ...(args.track_index === undefined ? {} : { trackIndex: args.track_index }),
        ...(args.clip_index === undefined ? {} : { clipIndex: args.clip_index }),
        ...(args.all_tracks === undefined ? {} : { allTracks: args.all_tracks }),
        timeSeconds: args.time_seconds, confirmRazor: args.confirm_razor, operationId: args.operation_id,
      }),
    },
    extract_timeline_range_uxp: {
      description: "Cut a time range out of the timeline and close the gap (an extract). Razors the chosen tracks at the range edges, removes what is inside, then moves every later item left by the exact range length and reads the result back. Defaults to all tracks; video_tracks / audio_tracks limit it, and a track you leave out that has an item over the range makes the call refuse before changing anything, so linked partners cannot drift. Refuses retimed or reversed items at the range edges. Many Undo steps (reported). Needs confirm_extract and an operation ID.",
      parameters: {
        type: "object" as const, additionalProperties: false,
        properties: {
          start_seconds: seconds, end_seconds: seconds,
          video_tracks: { ...trackIndexList, description: "Video track indexes to edit. Omit for all." },
          audio_tracks: { ...trackIndexList, description: "Audio track indexes to edit. Omit for all." },
          confirm_extract: { type: "boolean", description: "Must be true." }, operation_id: operationIdSchema,
        },
        required: ["start_seconds", "end_seconds", "confirm_extract", "operation_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      availability: { backend: "uxp", minimumPremiereVersion: "25.6.0", capability: "timeline.range.extract", notes: ["A bounded number of items may move in one transaction (512)."] },
      handler: async (args: ExtractArgs) => invoke(bridge, "timeline.range.extract", {
        startSeconds: args.start_seconds, endSeconds: args.end_seconds,
        ...(args.video_tracks === undefined ? {} : { videoTracks: args.video_tracks }),
        ...(args.audio_tracks === undefined ? {} : { audioTracks: args.audio_tracks }),
        confirmExtract: args.confirm_extract, operationId: args.operation_id,
      }),
    },
    ripple_delete_track_item_uxp: {
      description: "Inspect or perform one guarded ripple delete on an audio or video timeline item using documented UXP SequenceEditor actions. Apply requires complete target and contiguous-successor snapshots, explicit confirmation, and an operation ID; it serializes with guarded slips, slides, and append duplicates on that track, commits two transactions (remove, then close the gap), and reads back the successor at the removed coordinate. It refuses before any change when it cannot ripple: a final item or a gap. Premiere's own ripple is not used (live 27.0 shifts whole frames and its overlap flag is unreliable): the clip is removed without ripple, then the successors on that track move by the exact removed length and are read back. Items on other tracks over the range are reported in otherTrackItemsOverRange, not moved. It does not prove media handles, linked A/V synchronization, rendered frames, playback, persistence, or Undo behavior.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["inspect", "apply"] },
          media_type: { type: "string", enum: ["video", "audio"] },
          track_index: { type: "integer", minimum: 0, maximum: 511 },
          clip_index: { type: "integer", minimum: 0, maximum: 510, description: "One clip item with an immediately contiguous same-track successor." },
          expected_snapshot: expectedSnapshotSchema,
          confirm_ripple_delete: { type: "boolean", description: "Must be true for action: apply." },
          operation_id: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$", description: "Required replay-safe operation identifier for action: apply." },
        },
        required: ["action", "media_type", "track_index", "clip_index"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      availability: {
        backend: "uxp", minimumPremiereVersion: "25.6.0", capability: "trackItem.rippleDelete.inspect|trackItem.rippleDelete",
        notes: ["Requires an authenticated UXP bridge whose runtime capability handshake advertises trackItem.rippleDelete.inspect and trackItem.rippleDelete.", "A verification failure can follow a committed host transaction; inspect the successor before another edit."],
      },
      handler: async (args: RippleDeleteArgs) => {
        const target = { mediaType: args.media_type, trackIndex: args.track_index, clipIndex: args.clip_index };
        if (args.action === "inspect") return withApplySnapshot(invoke(bridge, "trackItem.rippleDelete.inspect", target), expectedSnapshotSchema);
        if (args.action === "apply") return invoke(bridge, "trackItem.rippleDelete", {
          ...target, expectedSnapshot: expectedRippleSnapshot(args.expected_snapshot),
          confirmRippleDelete: args.confirm_ripple_delete, operationId: args.operation_id,
        });
        return { success: false, error: `Unsupported workflow action: ${String(args.action)}` };
      },
    },
  };
}
