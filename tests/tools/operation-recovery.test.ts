import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(), inspectHostRecovery: vi.fn(), acknowledgeHostRecovery: vi.fn(), withBridgeWorkflow: vi.fn(async (_options: unknown, work: () => Promise<unknown>) => work()),
}));
vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: mocks.sendCommand, getTempDir: (options: { tempDir?: string }) => options?.tempDir || "/private/bridge", withBridgeWorkflow: mocks.withBridgeWorkflow }));
vi.mock("../../src/bridge/host-lease.js", () => ({ inspectHostRecovery: mocks.inspectHostRecovery, acknowledgeHostRecovery: mocks.acknowledgeHostRecovery }));
import { getOperationRecoveryTools } from "../../src/tools/operation-recovery.js";
import type { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectHostRecovery.mockReturnValue({ version: 1, recoveryRequired: true, recoveryRevision: "cep-revision" });
  mocks.sendCommand.mockResolvedValue({ success: true, data: { sequenceId: "sequence-1", clips: [{ nodeId: "clip-1", startTicks: "10", endTicks: "20" }] } });
});
describe("reviewed operation reconciliation tools", () => {
  it("allows CEP-only diagnostics with read-only dispatch while mutations are blocked", async () => {
    const tools = getOperationRecoveryTools(undefined, { tempDir: "/private/bridge" });
    const result = await tools.inspect_operation_recovery.handler({ backend: "cep" });
    expect(result).toMatchObject({ success: true, data: { recoveryRequired: true, hostStateRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(mocks.sendCommand).toHaveBeenCalledWith(expect.stringContaining("snapshot.clips.push"), expect.objectContaining({ mutating: false, mutationOnTimeout: false }));
    expect(mocks.sendCommand.mock.calls[0][0]).not.toContain("setInPoint");
    await expect(tools.inspect_operation_recovery.handler({ backend: "uxp" })).resolves.toMatchObject({ success: false, error: "UXP bridge is not configured" });
  });
  it("omits the CEP snapshot only when requested and preserves revision identity", async () => {
    const tools = getOperationRecoveryTools(undefined);
    const full = await tools.inspect_operation_recovery.handler({ backend: "cep" });
    const compact = await tools.inspect_operation_recovery.handler({ backend: "cep", include_snapshot: false });
    expect(full).toHaveProperty("data.snapshot.clips");
    expect(compact).not.toHaveProperty("data.snapshot");
    expect(compact).toMatchObject({ success: true, data: { recoveryRequired: true, recoveryRevision: "cep-revision", hostStateRevision: (full as { data: { hostStateRevision: string } }).data.hostStateRevision, snapshotBoundary: "bounded_active_sequence_clip_identity_and_ranges" } });
    await expect(tools.inspect_operation_recovery.handler({ backend: "cep", include_snapshot: true })).resolves.toEqual(full);
  });
  it("clears CEP recovery with the inspected review token and refuses a stale one", async () => {
    const tools = getOperationRecoveryTools(undefined);
    const inspection = await tools.inspect_operation_recovery.handler({ backend: "cep" }) as { data: { reviewToken: string } };
    const args = { backend: "cep" as const, review_token: inspection.data.reviewToken, reviewed: true };
    await expect(tools.acknowledge_operation_recovery.handler({ ...args, reviewed: false })).resolves.toMatchObject({ success: false });
    await expect(tools.acknowledge_operation_recovery.handler({ ...args, review_token: "review-v1:stale" })).resolves.toMatchObject({ success: false, error: expect.stringContaining("STALE_REVIEW_TOKEN") });
    expect(mocks.acknowledgeHostRecovery).not.toHaveBeenCalled();
    await expect(tools.acknowledge_operation_recovery.handler(args)).resolves.toMatchObject({ success: true, data: { replayAuthorized: false, cleared: ["shared"] } });
    expect(mocks.withBridgeWorkflow).toHaveBeenCalled();
    expect(mocks.acknowledgeHostRecovery).toHaveBeenCalledWith("/private/bridge", "cep-revision", true);
    mocks.sendCommand.mockResolvedValueOnce({ success: true, data: { sequenceId: "sequence-2" } });
    await expect(tools.acknowledge_operation_recovery.handler(args)).resolves.toMatchObject({ success: false, error: expect.stringContaining("changed since that inspection") });
  });
  it("binds the UXP token to panel IDs and every raised fence, and clears them all in one step", async () => {
    const panel = { recoveryRequired: true, recoveryRevision: "panel-revision", identityRevision: "host-state", operations: [{ id: "uncertain-1" }] };
    const bridge = { request: vi.fn(async (command: string) => command === "operations.recovery.inspect" ? panel : { acknowledged: true }), getOperationRecovery: vi.fn(() => ({ recoveryRequired: true, recoveryRevision: "transport-revision" })), acknowledgeOperationRecovery: vi.fn() };
    const tools = getOperationRecoveryTools(bridge as unknown as UxpWebSocketBridge);
    const inspection = await tools.inspect_operation_recovery.handler({ backend: "uxp" }) as { data: { reviewToken: string } };
    expect(inspection).toMatchObject({ success: true, data: { hostStateRevision: "host-state", recoveryRequired: true, reviewToken: expect.stringMatching(/^review-v1:[a-f0-9]{64}$/) } });
    // A new uncertain operation after the inspection makes the token stale.
    panel.operations.push({ id: "uncertain-2" });
    await expect(tools.acknowledge_operation_recovery.handler({ backend: "uxp", review_token: inspection.data.reviewToken, reviewed: true })).resolves.toMatchObject({ success: false, error: expect.stringContaining("STALE_REVIEW_TOKEN") });
    expect(bridge.acknowledgeOperationRecovery).not.toHaveBeenCalled();
    const fresh = await tools.inspect_operation_recovery.handler({ backend: "uxp" }) as { data: { reviewToken: string } };
    await expect(tools.acknowledge_operation_recovery.handler({ backend: "uxp", review_token: fresh.data.reviewToken, reviewed: true })).resolves.toMatchObject({ success: true, data: { replayAuthorized: false, cleared: ["panel", "transport", "shared"] } });
    expect(bridge.request).toHaveBeenCalledWith("operations.recovery.acknowledge", { expectedRecoveryRevision: "panel-revision", expectedIdentityRevision: "host-state", operationIds: ["uncertain-1", "uncertain-2"], reviewed: true });
    expect(bridge.acknowledgeOperationRecovery).toHaveBeenCalledWith("transport-revision", true);
    expect(mocks.acknowledgeHostRecovery).toHaveBeenCalledWith("/private/bridge", "cep-revision", true);
  });
  it("refuses a token a client builds itself from the inspected fields (inspection A3)", async () => {
    const panel = { recoveryRequired: true, recoveryRevision: "panel-revision", identityRevision: "host-state", operations: [{ id: "uncertain-1" }] };
    const bridge = { request: vi.fn(async (command: string) => command === "operations.recovery.inspect" ? panel : { acknowledged: true }), getOperationRecovery: vi.fn(() => ({ recoveryRequired: false, recoveryRevision: "transport-clean" })), acknowledgeOperationRecovery: vi.fn() };
    const tools = getOperationRecoveryTools(bridge as unknown as UxpWebSocketBridge);
    const inspection = await tools.inspect_operation_recovery.handler({ backend: "uxp" }) as { data: { hostStateRevision: string; shared: { recoveryRevision: string } } };
    const bound = { backend: "uxp", hostStateRevision: inspection.data.hostStateRevision, panel: { recoveryRequired: true, recoveryRevision: panel.recoveryRevision, operationIds: ["uncertain-1"] }, transport: null, shared: inspection.data.shared.recoveryRevision };
    const forged = "review-v1:" + createHash("sha256").update(JSON.stringify(bound)).digest("hex");
    await expect(tools.acknowledge_operation_recovery.handler({ backend: "uxp", review_token: forged, reviewed: true })).resolves.toMatchObject({ success: false, error: expect.stringContaining("STALE_REVIEW_TOKEN") });
    expect(bridge.request).not.toHaveBeenCalledWith("operations.recovery.acknowledge", expect.anything());
    expect(mocks.acknowledgeHostRecovery).not.toHaveBeenCalled();
  });
  it("clears a shared-only fence with the same one token (the 196 run's 1,089 failed acknowledgements)", async () => {
    const panel = { recoveryRequired: false, recoveryRevision: "panel-clean", identityRevision: "host-state", operations: [] };
    const bridge = { request: vi.fn(async () => panel), getOperationRecovery: vi.fn(() => ({ recoveryRequired: false, recoveryRevision: "transport-clean" })), acknowledgeOperationRecovery: vi.fn() };
    const tools = getOperationRecoveryTools(bridge as unknown as UxpWebSocketBridge);
    const inspection = await tools.inspect_operation_recovery.handler({ backend: "uxp" }) as { data: { reviewToken: string } };
    await expect(tools.acknowledge_operation_recovery.handler({ backend: "uxp", review_token: inspection.data.reviewToken, reviewed: true })).resolves.toMatchObject({ success: true, data: { cleared: ["shared"], replayAuthorized: false } });
    expect(bridge.request).not.toHaveBeenCalledWith("operations.recovery.acknowledge", expect.anything());
    expect(bridge.acknowledgeOperationRecovery).not.toHaveBeenCalled();
  });
  it("refuses failed host inspections, invalid backends and acknowledgement without a configured UXP bridge", async () => {
    const tools = getOperationRecoveryTools(undefined);
    mocks.sendCommand.mockResolvedValueOnce({ success: false, error: "host unavailable" });
    await expect(tools.inspect_operation_recovery.handler({ backend: "cep" })).resolves.toMatchObject({ success: false, error: "host unavailable" });
    await expect(tools.inspect_operation_recovery.handler({ backend: "other" as "cep" })).resolves.toMatchObject({ success: false, error: "backend must be cep or uxp" });
    await expect(tools.acknowledge_operation_recovery.handler({ backend: "uxp", review_token: "x", reviewed: true })).resolves.toMatchObject({ success: false, error: "UXP bridge is not configured" });
  });
  it("never clears transport or shared state after a failed panel acknowledgement", async () => {
    const panel = { recoveryRequired: true, recoveryRevision: "panel-revision", identityRevision: "host-state", operations: [{ id: "uncertain-1" }] };
    const bridge = { request: vi.fn(async (command: string) => {
      if (command === "operations.recovery.inspect") return panel;
      throw new Error("panel acknowledgement refused");
    }), getOperationRecovery: vi.fn(() => ({ recoveryRequired: true, recoveryRevision: "transport-revision" })), acknowledgeOperationRecovery: vi.fn() };
    const tools = getOperationRecoveryTools(bridge as unknown as UxpWebSocketBridge);
    const inspection = await tools.inspect_operation_recovery.handler({ backend: "uxp" }) as { data: { reviewToken: string } };
    await expect(tools.acknowledge_operation_recovery.handler({ backend: "uxp", review_token: inspection.data.reviewToken, reviewed: true })).resolves.toMatchObject({ success: false, error: "panel acknowledgement refused" });
    expect(bridge.acknowledgeOperationRecovery).not.toHaveBeenCalled();
    expect(mocks.acknowledgeHostRecovery).not.toHaveBeenCalled();
    await expect(tools.acknowledge_operation_recovery.handler({ backend: "other" as "cep", review_token: "x", reviewed: true })).resolves.toMatchObject({ success: false, error: "backend must be cep or uxp" });
  });
  it("acknowledges UXP-only receipts without inventing or clearing a shared recovery revision", async () => {
    mocks.inspectHostRecovery.mockReturnValue({ version: 1, recoveryRequired: false, recoveryRevision: null });
    const panel = { recoveryRequired: true, recoveryRevision: "panel-revision", identityRevision: "host-state", operations: [] };
    const bridge = { request: vi.fn(async (command: string) => command === "operations.recovery.inspect" ? panel : { acknowledged: true }), getOperationRecovery: vi.fn(() => ({ recoveryRequired: true, recoveryRevision: "transport-revision" })), acknowledgeOperationRecovery: vi.fn() };
    const tools = getOperationRecoveryTools(bridge as unknown as UxpWebSocketBridge);
    const inspection = await tools.inspect_operation_recovery.handler({ backend: "uxp" }) as { data: { reviewToken: string } };
    await expect(tools.acknowledge_operation_recovery.handler({ backend: "uxp", review_token: inspection.data.reviewToken, reviewed: true })).resolves.toMatchObject({ success: true, data: { cleared: ["panel", "transport"] } });
    expect(mocks.acknowledgeHostRecovery).not.toHaveBeenCalled();
  });
});
