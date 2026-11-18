import { createHash, createHmac, randomBytes } from "node:crypto";
import { type BridgeOptions, getTempDir, sendCommand, withBridgeWorkflow } from "../bridge/file-bridge.js";
import { acknowledgeHostRecovery, inspectHostRecovery } from "../bridge/host-lease.js";
import { buildToolScript } from "../bridge/script-builder.js";
import type { UxpWebSocketBridge } from "../bridge/uxp-websocket-bridge.js";
import { OPERATION_LOG_LIMIT, recentOperations, runningOperations } from "../workflows/operation-log.js";

const HOST_STATE_SCRIPT = `
  var project = app.project;
  var sequence = project && project.activeSequence;
  var snapshot = { projectId: project ? String(project.documentID || "") : null, sequenceId: sequence ? String(sequence.sequenceID) : null, clips: [] };
  if (sequence) {
    var kinds = ["video", "audio"];
    for (var kind = 0; kind < kinds.length; kind++) {
      var tracks = kind === 0 ? sequence.videoTracks : sequence.audioTracks;
      if (tracks.numTracks > 256) return __error("Recovery inspection exceeds 256 tracks");
      for (var t = 0; t < tracks.numTracks; t++) {
        for (var c = 0; c < tracks[t].clips.numItems; c++) {
          if (snapshot.clips.length >= 5000) return __error("Recovery inspection exceeds 5000 clips");
          var clip = tracks[t].clips[c];
          snapshot.clips.push({ nodeId: String(clip.nodeId), sourceId: clip.projectItem ? String(clip.projectItem.nodeId) : null, mediaType: kinds[kind], trackIndex: t, startTicks: String(clip.start.ticks), endTicks: String(clip.end.ticks), inTicks: String(clip.inPoint.ticks), outTicks: String(clip.outPoint.ticks) });
        }
      }
    }
  }
  return __result(snapshot);
`;
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
// Keyed with a secret held only by this server process, so only an inspection here can issue a token.
const REVIEW_KEY = randomBytes(32);
function reviewToken(bound: unknown): string { return "review-v1:" + createHmac("sha256", REVIEW_KEY).update(JSON.stringify(bound)).digest("hex"); }
export function getOperationRecoveryTools(uxpBridge: UxpWebSocketBridge | undefined, bridgeOptions?: BridgeOptions) {
  const properties = {
    backend: { type: "string", enum: ["cep", "uxp"], description: "Execution backend whose uncertain operations should be inspected." },
  };
  async function inspect(backend: "cep" | "uxp") {
    if (backend === "uxp") {
      if (!uxpBridge) throw new Error("UXP bridge is not configured");
      const panel = await uxpBridge.request("operations.recovery.inspect") as { recoveryRequired?: boolean; recoveryRevision: string; identityRevision: string; operations: { id: string }[] };
      const transport = uxpBridge.getOperationRecovery();
      const shared = inspectHostRecovery(getTempDir(bridgeOptions));
      const view = { backend, recoveryRequired: Boolean(panel.recoveryRequired || transport.recoveryRequired || shared.recoveryRequired), panel, transport, shared, hostStateRevision: panel.identityRevision };
      // One token binds everything an acknowledgement would clear: host state, the panel's IDs and every raised fence.
      return { ...view, reviewToken: reviewToken({ backend, hostStateRevision: view.hostStateRevision, panel: { recoveryRequired: Boolean(panel.recoveryRequired), recoveryRevision: panel.recoveryRevision, operationIds: panel.operations.map((item) => item.id) }, transport: transport.recoveryRequired ? transport.recoveryRevision : null, shared: shared.recoveryRequired ? shared.recoveryRevision : null }) };
    }
    if (backend !== "cep") throw new Error("backend must be cep or uxp");
    const state = inspectHostRecovery(getTempDir(bridgeOptions));
    const snapshot = await sendCommand(buildToolScript(HOST_STATE_SCRIPT), { ...bridgeOptions, mutating: false, mutationOnTimeout: false });
    if (!snapshot.success) throw new Error(snapshot.error || "Host recovery snapshot unavailable");
    const hostStateRevision = digest(snapshot.data);
    return { backend, ...state, hostStateRevision, snapshotBoundary: "bounded_active_sequence_clip_identity_and_ranges", snapshot: snapshot.data, reviewToken: reviewToken({ backend, hostStateRevision, shared: state.recoveryRequired ? state.recoveryRevision : null }) };
  }
  return {
    get_last_operations: {
      description: "Read-only: list the most recent state-changing tool calls this MCP server process handled, newest first, with status (running, succeeded, failed), receipt outcome and timing. Use it after a client-side timeout before retrying an edit: a call still running, or one that already succeeded, must not be sent again. The running count includes all active calls, even outside the history window; runningOperations lists up to limit active calls and runningOperationsTruncated flags omitted entries. Entries made with idempotency_key carry idempotencyKeyHash, a 12-character SHA-256 prefix (never the raw key). Records only tool names, timing and outcomes; it does not prove Premiere state, and it starts empty when the server restarts.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      parameters: { type: "object", additionalProperties: false, properties: {
        limit: { type: "integer", minimum: 1, maximum: OPERATION_LOG_LIMIT, description: `How many operations to return, newest first (default 10, max ${OPERATION_LOG_LIMIT}).` },
      } },
      handler: async (args: { limit?: number }) => {
        const limit = args.limit ?? 10;
        if (!Number.isInteger(limit) || limit < 1 || limit > OPERATION_LOG_LIMIT) return { success: false, error: `limit must be an integer from 1 through ${OPERATION_LOG_LIMIT}` };
        const operations = recentOperations(limit);
        const active = runningOperations(limit);
        return { success: true, data: { operations, running: active.count, runningOperations: active.operations, runningOperationsTruncated: active.truncated, scope: "this_server_process_memory", boundary: "Tool-call bookkeeping only; read the timeline back before relying on an edit's effect." } };
      },
    },
    inspect_operation_recovery: {
      description: "Inspect unknown execution outcomes and a bounded current host-state revision. Inspection remains available while dependent mutations are blocked. No edit is replayed. Returns reviewToken: after reviewing the state, pass it to acknowledge_operation_recovery to clear every raised fence in one step.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      parameters: { type: "object", additionalProperties: false, properties: { ...properties, include_snapshot: { type: "boolean", description: "Include the bounded CEP clip snapshot (default true). Set false for compact status checks; host-state revision is still computed from the full snapshot. UXP diagnostics are unchanged." } }, required: ["backend"] },
      handler: async (args: { backend: "cep" | "uxp"; include_snapshot?: boolean }) => {
        if (args.include_snapshot !== undefined && typeof args.include_snapshot !== "boolean") return { success: false, error: "include_snapshot must be a boolean" };
        try {
          const data = await inspect(args.backend);
          if (args.include_snapshot === false && "snapshot" in data) {
            const { snapshot: _snapshot, ...status } = data;
            return { success: true, data: status };
          }
          return { success: true, data };
        } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
      },
    },
    acknowledge_operation_recovery: {
      description: "After reviewing current Premiere state, clear the recovery fence in one step: pass the review_token from the latest inspect_operation_recovery. The token binds the host state, the uncertain operation IDs and every raised fence (panel, transport, shared); if anything changed since that inspection it is refused as stale and you inspect again. Acknowledging records that you reconciled the state. It never undoes, retries or authorises replaying an edit: consumed operation IDs stay consumed.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      parameters: { type: "object", additionalProperties: false, properties: {
        ...properties,
        review_token: { type: "string", minLength: 1, maxLength: 256, description: "reviewToken returned by the latest inspect_operation_recovery for this backend, unchanged." },
        reviewed: { type: "boolean", const: true, description: "True only after reviewing current host state and reconciling the uncertain operations." },
      }, required: ["backend", "review_token", "reviewed"] },
      handler: async (args: { backend: "cep" | "uxp"; review_token: string; reviewed: boolean }) => {
        const work = async () => {
          if (args.reviewed !== true) throw new Error("reviewed must be true after reconciliation");
          const view = await inspect(args.backend);
          if (view.reviewToken !== args.review_token) throw new Error("STALE_REVIEW_TOKEN: Premiere or the recovery state changed since that inspection (or the token is from another inspection); call inspect_operation_recovery again, review the current state and pass its new reviewToken");
          const cleared: string[] = [];
          if (view.backend === "uxp" && "panel" in view) {
            if (!uxpBridge) throw new Error("UXP bridge is not configured");
            if (view.panel.recoveryRequired) {
              await uxpBridge.request("operations.recovery.acknowledge", { expectedRecoveryRevision: view.panel.recoveryRevision, expectedIdentityRevision: view.panel.identityRevision, operationIds: view.panel.operations.map((item) => item.id), reviewed: true });
              cleared.push("panel");
            }
            if (view.transport.recoveryRequired) { uxpBridge.acknowledgeOperationRecovery(view.transport.recoveryRevision, true); cleared.push("transport"); }
            if (view.shared.recoveryRequired) { acknowledgeHostRecovery(getTempDir(bridgeOptions), view.shared.recoveryRevision!, true); cleared.push("shared"); }
          } else if (view.recoveryRequired) { acknowledgeHostRecovery(getTempDir(bridgeOptions), (view as { recoveryRevision: string }).recoveryRevision, true); cleared.push("shared"); }
          return { success: true, data: { acknowledged: true, cleared, nothingToAcknowledge: cleared.length === 0, replayAuthorized: false, boundary: "user_reviewed_current_host_state", outcome: "verified" } };
        };
        try { return await withBridgeWorkflow(bridgeOptions, work); } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
      },
    },
  };
}
