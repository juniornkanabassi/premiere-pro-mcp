// Lane E (native route repairs): ledger retirement, pre-write refusals, point keyframes and the small RESULTS.md bugs.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const Ledger = require("../../uxp-plugin/operation-ledger.cjs");
const Commands = require("../../uxp-plugin/commands.cjs");
const Protocol = require("../../uxp-plugin/protocol.cjs");
const digest = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const identity = { projectGuid: "project-1", sequenceGuid: "sequence-1" };
function stored() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) };
}
function host(storage: ReturnType<typeof stored>, handler?: (args: Record<string, unknown>) => Promise<unknown>) {
  const sequence = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0, getVideoTrack: vi.fn(), getAudioTrack: vi.fn() };
  const project = { guid: "project-1", getActiveSequence: async () => sequence };
  const mutation = vi.fn(handler || (async (args: { value?: number }) => ({ value: args.value, outcome: "verified" })));
  const registry = Commands.createCommandRegistry({ ppro: { Project: { getActiveProject: async () => project } }, Protocol, storage, sessionId: "session-1", Workflows: { createWorkflowDefinitions: () => ({ "test.mutate": { handler: mutation } }) } });
  return { registry, mutation };
}
const storedRecords = (storage: ReturnType<typeof stored>) => JSON.parse(storage.values.get(Ledger.STORAGE_KEY)!).records as { id: string; outcome: string }[];

describe("operation ledger retires finished records instead of filling up", () => {
  it("passes 4,096 edits with a restart in the middle, and refuses a retired ID even after restart", async () => {
    const storage = stored();
    let panel = host(storage);
    const total = Ledger.MAX_OPERATIONS + 600;
    for (let index = 0; index < total; index++) {
      if (index === 3000) panel = host(storage); // simulated panel reload
      await expect(panel.registry.dispatch("test.mutate", { operationId: "edit-" + index, value: index })).resolves.toMatchObject({ outcome: "verified" });
    }
    expect(storedRecords(storage).length).toBeLessThanOrEqual(Ledger.MAX_OPERATIONS);
    await expect(panel.registry.dispatch("test.mutate", { operationId: "edit-0", value: 0 })).rejects.toMatchObject({ code: "UXP_OPERATION_EXPIRED" });
    const restarted = host(storage);
    await expect(restarted.registry.dispatch("test.mutate", { operationId: "edit-1", value: 1 })).rejects.toMatchObject({ code: "UXP_OPERATION_EXPIRED" });
    await expect(restarted.registry.dispatch("test.mutate", { operationId: "edit-1", value: 999 })).rejects.toMatchObject({ code: "UXP_OPERATION_EXPIRED" });
    expect(restarted.mutation).not.toHaveBeenCalled();
    // Recent IDs are still held with their outcome.
    await expect(restarted.registry.dispatch("test.mutate", { operationId: "edit-" + (total - 1), value: total - 1 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONSUMED" });
    await expect(restarted.registry.dispatch("test.mutate", { operationId: "fresh", value: 1 })).resolves.toMatchObject({ outcome: "verified" });
  }, 60000);
  it("keeps panel-generated anonymous keys out of the store once finished", async () => {
    const storage = stored(), panel = host(storage);
    for (let index = 0; index < 50; index++) await panel.registry.dispatch("test.mutate", { value: index });
    expect(storedRecords(storage)).toHaveLength(0);
  });
  it("never retires an unresolved record and still refuses when only unresolved records remain", () => {
    const value = Ledger.createOperationLedger({ sessionId: "session-1", digest });
    const other = { projectGuid: "project-2", sequenceGuid: "s" };
    value.reserve("uncertain", digest("u"), identity); value.unknown("uncertain");
    for (let index = 0; index < Ledger.MAX_OPERATIONS + 10; index++) { value.reserve("id-" + index, digest(String(index)), other); value.finish("id-" + index, "verified"); }
    expect(value.get("uncertain", digest("u"))).toMatchObject({ outcome: "unknown" });
    expect(value.inspect(identity).operations.map((item: { id: string }) => item.id)).toEqual(["uncertain"]);
    const stuck = Ledger.createOperationLedger({ sessionId: "session-1", digest });
    for (let index = 0; index < Ledger.MAX_OPERATIONS; index++) stuck.reserve("p-" + index, digest(String(index)), other);
    expect(() => stuck.reserve("one-more", digest("x"), other)).toThrow(/unresolved operations/);
    expect(stuck.get("p-0", digest("0"))).toMatchObject({ outcome: "pending" });
  });
  it("migrates a full version 1 store without making its IDs reusable", () => {
    const storage = stored();
    const records = Array.from({ length: Ledger.MAX_OPERATIONS }, (_, index) => ({ id: "old-" + index, binding: digest("b" + index), scope: digest("s"), outcome: "verified" }));
    storage.setItem(Ledger.STORAGE_KEY, JSON.stringify({ version: 1, sessionId: "panel-old", records }));
    const value = Ledger.createOperationLedger({ storage, digest });
    expect(value.sessionId).toBe("panel-old");
    value.reserve("new-1", digest("n"), identity);
    const raw = JSON.parse(storage.values.get(Ledger.STORAGE_KEY)!);
    expect(raw).toMatchObject({ version: 2, sessionId: "panel-old" });
    expect(raw.retiredCount).toBeGreaterThan(0);
    expect(() => value.get("old-0", digest("b0"))).toThrow(/retired/);
    expect(() => Ledger.createOperationLedger({ storage, digest }).reserve("old-0", digest("b0"), identity)).toThrow(/retired/);
    expect(value.get("old-" + (Ledger.MAX_OPERATIONS - 1), digest("b" + (Ledger.MAX_OPERATIONS - 1)))).toMatchObject({ outcome: "verified" });
  });
  it("retires by size when long IDs reach the storage limit first", () => {
    const storage = stored(), value = Ledger.createOperationLedger({ storage, sessionId: "session-1", digest });
    for (let index = 0; index < 3000; index++) { const id = "x".repeat(480) + "-" + index; value.reserve(id, digest(id), identity); value.finish(id, "verified"); }
    expect(storage.values.get(Ledger.STORAGE_KEY)!.length).toBeLessThanOrEqual(1024 * 1024);
    expect(() => value.get("x".repeat(480) + "-0", digest("x"))).toThrow(/retired/);
  });
  it("refuses a tampered retired filter as corrupt", () => {
    const storage = stored(), value = Ledger.createOperationLedger({ storage, sessionId: "session-1", digest });
    value.reserve("a", digest("a"), identity);
    const raw = JSON.parse(storage.values.get(Ledger.STORAGE_KEY)!);
    storage.setItem(Ledger.STORAGE_KEY, JSON.stringify({ ...raw, retired: "00" }));
    expect(Ledger.createOperationLedger({ storage, digest }).inspect(identity)).toMatchObject({ ledgerCorrupt: true });
  });
});
