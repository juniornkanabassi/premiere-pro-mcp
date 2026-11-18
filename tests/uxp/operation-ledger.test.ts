import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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
function ledger(storage?: ReturnType<typeof stored>) { return Ledger.createOperationLedger({ storage, sessionId: "session-1", digest }); }
function host(storage?: ReturnType<typeof stored>) {
  const sequence = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0, getVideoTrack: vi.fn(), getAudioTrack: vi.fn() };
  const project = { guid: "project-1", getActiveSequence: async () => sequence };
  const mutation = vi.fn(async (args: { value?: number }) => ({ value: args.value, outcome: "verified" }));
  const registry = Commands.createCommandRegistry({ ppro: { Project: { getActiveProject: async () => project } }, Protocol, storage, Workflows: { createWorkflowDefinitions: () => ({ "test.mutate": { handler: mutation } }) } });
  return { registry, project, sequence, mutation };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("documented UXP cryptographic session identity", () => {
  it("uses native randomUUID and retains the durable session across reloads", async () => {
    // Deterministic CSPRNG outputs are explicitly injected test fixtures only.
    const randomUUID = vi.fn()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000003");
    vi.stubGlobal("crypto", { randomUUID });
    const weakRandom = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("Weak entropy is forbidden"); });
    const storage = stored(), first = host(storage);
    await first.registry.dispatch("test.mutate", { value: 1 });
    const restored = host(storage);
    await restored.registry.dispatch("test.mutate", { value: 2 });
    const persisted = JSON.parse(storage.values.get(Ledger.STORAGE_KEY)!);
    expect(persisted.sessionId).toBe("panel-00000000-0000-4000-8000-000000000001");
    // Finished anonymous keys are panel-generated and can never be sent again, so they are not kept (lane E).
    expect(persisted.records).toEqual([]);
    expect(randomUUID).toHaveBeenCalledTimes(3);
    expect(weakRandom).not.toHaveBeenCalled();
  });
  it.each([undefined, () => { throw new Error("randomUUID unavailable"); }, () => "invalid-uuid"])("uses getRandomValues CSPRNG when randomUUID is unavailable or invalid (%s)", (randomUUID) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => { for (let index = 0; index < bytes.length; index++) bytes[index] = index; return bytes; });
    vi.stubGlobal("crypto", { randomUUID, getRandomValues });
    const weakRandom = vi.spyOn(Math, "random");
    const value = Ledger.createOperationLedger({ digest });
    expect(value.sessionId).toBe("panel-000102030405060708090a0b0c0d0e0f");
    expect(value.secureIdentityAvailable).toBe(true);
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
    expect(weakRandom).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { randomUUID: () => { throw new Error("entropy unavailable"); }, getRandomValues: () => { throw new Error("entropy unavailable"); } }])("keeps inspection available and refuses all mutations without secure entropy (%s)", async (crypto) => {
    vi.stubGlobal("crypto", crypto);
    const storage = stored(), value = Ledger.createOperationLedger({ storage, digest });
    expect(value.inspect(identity)).toMatchObject({ sessionId: null, recoveryRequired: false });
    expect(value.secureIdentityAvailable).toBe(false);
    expect(() => value.bind("test.mutate", {}, identity)).toThrow(/cryptographic entropy/);
    expect(() => value.reserve("cannot-dispatch", digest("cannot-dispatch"), identity)).toThrow(/no host mutation was dispatched/);
    const panel = host(storage);
    const capabilities = await panel.registry.dispatch("capabilities.get", {});
    expect(capabilities.commands["operations.recovery.inspect"].supported).toBe(true);
    expect(capabilities.commands["test.mutate"]).toMatchObject({ supported: false, reason: expect.stringContaining("cryptographic entropy") });
    await expect(panel.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ sessionId: null });
    for (const args of [{}, { operationId: "caller-supplied-id" }]) await expect(panel.registry.dispatch("test.mutate", args)).rejects.toMatchObject({ code: "UXP_SECURE_IDENTITY_UNAVAILABLE", noHostDispatch: true, dispatchEvidence: "panel_pre_dispatch" });
    expect(panel.mutation).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
  });
  it("preserves persisted replay bindings without allowing an entropy-free registry to write", async () => {
    const storage = stored(), first = host(storage);
    await first.registry.dispatch("test.mutate", { operationId: "reserved", value: 1 });
    const previous = await first.registry.dispatch("operations.recovery.inspect", {});
    vi.stubGlobal("crypto", undefined);
    const restored = host(storage);
    await expect(restored.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ sessionId: previous.sessionId });
    await expect(restored.registry.dispatch("test.mutate", { operationId: "new", value: 2 })).rejects.toMatchObject({ code: "UXP_SECURE_IDENTITY_UNAVAILABLE", noHostDispatch: true });
    expect(restored.mutation).not.toHaveBeenCalled();
    expect(JSON.parse(storage.values.get(Ledger.STORAGE_KEY)!).records).toHaveLength(1);
  });
  it("allows explicitly injected deterministic ledger fixture identities but rejects invalid overrides", () => {
    vi.stubGlobal("crypto", undefined);
    expect(ledger().sessionId).toBe("session-1");
    expect(() => Ledger.createOperationLedger({ digest, sessionId: "invalid/session" })).toThrow(/Invalid injected/);
  });
});
describe("canonical operation binding and durable consumed receipts", () => {
  it("canonicalizes nested objects without depending on property order", () => {
    expect(Ledger.canonical({ b: [{ z: 1, a: "x" }], a: true })).toBe(Ledger.canonical({ a: true, b: [{ a: "x", z: 1 }] }));
    expect(Ledger.canonical({ missing: undefined, present: null })).toBe('{"present":null}');
    expect(() => Ledger.canonical({ value: NaN })).toThrow(/finite JSON/);
    expect(() => Ledger.canonical(Symbol("bad"))).toThrow(/finite JSON/);
    let nested: unknown = null; for (let index = 0; index < 34; index++) nested = [nested];
    expect(() => Ledger.canonical(nested)).toThrow(/depth/);
  });
  it("binds arguments, command, project, sequence and panel session", () => {
    const value = ledger();
    const binding = value.bind("test.mutate", { value: 1 }, identity);
    value.reserve("id-1", binding, identity);
    for (const changed of [value.bind("test.other", { value: 1 }, identity), value.bind("test.mutate", { value: 2 }, identity), value.bind("test.mutate", { value: 1 }, { ...identity, projectGuid: "project-2" }), value.bind("test.mutate", { value: 1 }, { ...identity, sequenceGuid: "sequence-2" })]) expect(() => value.get("id-1", changed)).toThrow(/bound/);
    expect(value.get("id-1", binding)).toMatchObject({ outcome: "pending" });
    expect(ledger().bind("test.mutate", { value: 1 }, identity)).toBe(binding);
    const otherSession = Ledger.createOperationLedger({ sessionId: "session-2", digest });
    expect(otherSession.bind("test.mutate", { value: 1 }, identity)).not.toBe(binding);
  });
  it("persists only digests and operation metadata, with pending outcomes unknown after reload", () => {
    const storage = stored(), first = ledger(storage);
    const binding = first.bind("test.mutate", { name: "private-media.mov", path: "/private/project" }, identity);
    first.reserve("operation-1", binding, identity);
    const raw = storage.values.get(Ledger.STORAGE_KEY)!;
    expect(raw).not.toContain("private-media"); expect(raw).not.toContain("/private"); expect(raw).not.toContain("project-1");
    const restored = ledger(storage);
    expect(restored.get("operation-1", binding)).toMatchObject({ outcome: "unknown" });
    expect(() => restored.assertReady(identity)).toThrow(/unknown outcome/);
    expect(() => restored.assertReady({ ...identity, projectGuid: "unrelated" })).not.toThrow();
  });
  it("requires the exact inspected ledger, host identity and IDs before consuming reviewed recovery", () => {
    const value = ledger(), binding = value.bind("test.mutate", {}, identity);
    value.reserve("uncertain", binding, identity); value.unknown("uncertain");
    const snapshot = value.inspect({ ...identity, hostStateRevision: "host-before" });
    const args = { reviewed: true, expectedRecoveryRevision: snapshot.recoveryRevision, expectedIdentityRevision: snapshot.identityRevision, operationIds: ["uncertain"] };
    for (const changed of [{ ...args, reviewed: false }, { ...args, operationIds: [] }, { ...args, expectedRecoveryRevision: "stale" }]) expect(() => value.acknowledge({ ...identity, hostStateRevision: "host-before" }, changed)).toThrow(/latest inspected/);
    expect(() => value.acknowledge({ ...identity, hostStateRevision: "host-after" }, args)).toThrow(/latest inspected/);
    expect(value.acknowledge({ ...identity, hostStateRevision: "host-before" }, args)).toMatchObject({ replayAuthorized: false });
    expect(value.get("uncertain", binding)).toMatchObject({ outcome: "consumed" });
    expect(() => value.assertReady(identity)).not.toThrow();
  });
  it("refuses corrupt, oversized and unavailable persistent stores", () => {
    const storage = stored(); storage.setItem(Ledger.STORAGE_KEY, "{broken");
    expect(() => ledger(storage).assertReady(identity)).toThrow(/unknown outcome/);
    expect(() => ledger(storage).reserve("x", digest("x"), identity)).toThrow(/cannot be validated/);
    storage.setItem(Ledger.STORAGE_KEY, "x".repeat(1024 * 1024 + 1));
    expect(ledger(storage).inspect(identity)).toMatchObject({ ledgerCorrupt: true });
    const unavailable = Ledger.createOperationLedger({ digest, storage: { getItem: () => null, setItem: () => { throw new Error("quota"); } } });
    expect(() => unavailable.reserve("x", digest("x"), identity)).toThrow(/no new host mutation/);
    expect(unavailable.get("x", digest("x"))).toBeNull();
  });
  it("refreshes durable bindings across separate panel contexts without overwriting consumed IDs", () => {
    const storage = stored(), first = ledger(storage), second = ledger(storage);
    const binding = first.bind("test.mutate", { value: 1 }, identity);
    first.reserve("shared-id", binding, identity); first.finish("shared-id", "verified");
    expect(second.get("shared-id", binding)).toMatchObject({ outcome: "verified" });
    expect(() => second.reserve("shared-id", binding, identity)).toThrow(/already reserved/);
    const next = second.bind("test.mutate", { value: 2 }, identity);
    second.reserve("another", next, identity); second.finish("another", "verified");
    expect(first.get("another", next)).toMatchObject({ outcome: "verified" });
    expect(first.get("shared-id", binding)).toMatchObject({ outcome: "verified" });
    storage.values.clear(); expect(() => first.assertReady(identity)).toThrow(/unknown outcome/);
  });
  it("disables production mutations when persistent panel storage is unavailable", () => {
    const value = Ledger.createOperationLedger({ digest, requireDurability: true });
    expect(value.durable).toBe(false);
    expect(() => value.reserve("unsupported", digest("unsupported"), identity)).toThrow(/Persistent operation storage is unavailable/);
  });
});
describe("registry transport fault behavior", () => {
  it("keeps a write followed by a typed validation error unknown and consumed", async () => {
    const value = host(); let nativeWrites = 0;
    value.mutation.mockImplementationOnce(async () => {
      nativeWrites++;
      throw Object.assign(new Error("typed error after host write"), { code: "UXP_INVALID_ARGUMENT" });
    });
    await expect(value.registry.dispatch("test.mutate", { operationId: "write-then-error" })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    await expect(value.registry.dispatch("test.mutate", { operationId: "write-then-error" })).rejects.toMatchObject({ code: "UXP_OPERATION_CONSUMED" });
    await expect(value.registry.dispatch("test.mutate", { operationId: "dependent" })).rejects.toMatchObject({ code: "UXP_RECOVERY_REQUIRED", noHostDispatch: true, dispatchEvidence: "panel_pre_dispatch" });
    expect(nativeWrites).toBe(1);
  });
  it("rejects changed arguments and concurrent IDs without a second mutation", async () => {
    const value = host(); let release = () => {};
    value.mutation.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { value: 1, outcome: "verified" }; });
    const first = value.registry.dispatch("test.mutate", { operationId: "same", value: 1 });
    await vi.waitFor(() => expect(value.mutation).toHaveBeenCalledOnce());
    await expect(value.registry.dispatch("test.mutate", { operationId: "same", value: 2 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONFLICT" });
    const duplicate = value.registry.dispatch("test.mutate", { value: 1, operationId: "same" }); release();
    await expect(first).resolves.toMatchObject({ value: 1 }); await expect(duplicate).resolves.toMatchObject({ replayed: true });
    expect(value.mutation).toHaveBeenCalledOnce();
    value.sequence.guid = "different";
    await expect(value.registry.dispatch("test.mutate", { operationId: "same", value: 1 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONFLICT" });
  });
  it("survives post-write throws, panel reload, reconciliation and result-cache expiry", async () => {
    const storage = stored(), first = host(storage);
    first.mutation.mockRejectedValueOnce(new Error("host wrote, reply lost"));
    await expect(first.registry.dispatch("test.mutate", { operationId: "uncertain", value: 1 })).rejects.toThrow(/reply lost/);
    const restored = host(storage);
    await expect(restored.registry.dispatch("test.mutate", { operationId: "uncertain", value: 1 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONSUMED" });
    await expect(restored.registry.dispatch("test.mutate", { operationId: "new", value: 2 })).rejects.toMatchObject({ code: "UXP_RECOVERY_REQUIRED" });
    const inspection = await restored.registry.dispatch("operations.recovery.inspect", {});
    await restored.registry.dispatch("operations.recovery.acknowledge", { expectedRecoveryRevision: inspection.recoveryRevision, expectedIdentityRevision: inspection.identityRevision, operationIds: inspection.operations.map((item: { id: string }) => item.id), reviewed: true });
    await restored.registry.dispatch("test.mutate", { operationId: "new", value: 2 });
    for (let index = 0; index < 256; index++) await restored.registry.dispatch("test.mutate", { operationId: "cache-" + index, value: index });
    await expect(restored.registry.dispatch("test.mutate", { operationId: "new", value: 2 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONSUMED" });
    expect(restored.mutation).toHaveBeenCalledTimes(257);
  });
  it("releases the reservation when a handler refuses with noHostWrite, and lets the same ID retry", async () => {
    const value = host();
    value.mutation.mockImplementationOnce(async () => { throw Object.assign(new Error("Unknown argument: x"), { code: "UXP_INVALID_ARGUMENT", noHostWrite: true }); });
    await expect(value.registry.dispatch("test.mutate", { operationId: "refused" })).rejects.toMatchObject({ noHostWrite: true });
    await expect(value.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: false });
    await expect(value.registry.dispatch("test.mutate", { operationId: "refused", value: 3 })).resolves.toMatchObject({ value: 3 });
  });
  it("still fences a handler that wrote and then threw, even with a typed code", async () => {
    const value = host();
    value.mutation.mockImplementationOnce(async () => { throw Object.assign(new Error("failed after executeTransaction"), { code: "UXP_VERIFICATION_FAILED" }); });
    await expect(value.registry.dispatch("test.mutate", { operationId: "wrote" })).rejects.toThrow(/after executeTransaction/);
    await expect(value.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: true });
  });
  it("never fences a nonFencing command (selection-only change), whatever it throws", async () => {
    const mutation = vi.fn(async () => { throw new Error("selection rejected"); });
    const sequence = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0 };
    const project = { guid: "project-1", getActiveSequence: async () => sequence };
    const registry = Commands.createCommandRegistry({ ppro: { Project: { getActiveProject: async () => project } }, Protocol, Workflows: { createWorkflowDefinitions: () => ({ "test.select": { nonFencing: true, handler: mutation } }) } });
    await expect(registry.dispatch("test.select", {})).rejects.toThrow(/selection rejected/);
    await expect(registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: false });
    expect((await registry.capabilities()).commands["test.select"]).toMatchObject({ nonFencing: true });
  });
  it("fails incompatible command and receipt schemas before dispatch", () => {
    for (const field of ["commandSchemaVersion", "receiptVersion"]) expect(() => Protocol.parseCommand({ protocolVersion: 2, type: "command", command: "test.mutate", [field]: 99 })).toThrow(/matching MCP panel/);
    expect(Protocol.parseCommand({ protocolVersion: 2, type: "command", command: "test.mutate", commandSchemaVersion: 1, receiptVersion: 1 }).command).toBe("test.mutate");
  });
});
describe("sequence pin (item 13)", () => {
  function pinHost(activeGuid: string, activates = true) {
    const first = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0 };
    const second = { guid: "sequence-2", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0 };
    let active = activeGuid === "sequence-1" ? first : second;
    const setActiveSequence = vi.fn(async (sequence: typeof first) => { if (activates) active = sequence; return true; });
    const project = { guid: "project-1", getActiveSequence: async () => active, getSequences: async () => [first, second], openSequence: vi.fn(async () => true), setActiveSequence };
    const mutation = vi.fn(async () => ({ outcome: "verified" }));
    const registry = Commands.createCommandRegistry({ ppro: { Project: { getActiveProject: async () => project } }, Protocol, Workflows: { createWorkflowDefinitions: () => ({ "test.mutate": { handler: mutation }, "test.read": { readOnly: true, handler: async () => ({}) } }) } });
    return { registry, setActiveSequence, mutation, first };
  }
  it("re-activates the pinned sequence and verifies it before the handler runs", async () => {
    const value = pinHost("sequence-2");
    await expect(value.registry.dispatch("test.mutate", {}, { pinnedSequenceId: "sequence-1" })).resolves.toMatchObject({ outcome: "verified" });
    expect(value.setActiveSequence).toHaveBeenCalledWith(value.first);
    expect(value.mutation).toHaveBeenCalledOnce();
  });
  it("reports resequenced and the sequence the mutation ran on in the receipt", async () => {
    const moved = pinHost("sequence-2");
    await expect(moved.registry.dispatch("test.mutate", {}, { pinnedSequenceId: "sequence-1" })).resolves.toMatchObject({
      ranOnSequenceId: "sequence-1", sequencePin: { resequenced: true, from: "sequence-2", to: "sequence-1" },
    });
    const same = pinHost("sequence-1");
    const receipt = await same.registry.dispatch("test.mutate", {}, { pinnedSequenceId: "sequence-1" });
    expect(receipt.ranOnSequenceId).toBe("sequence-1");
    expect(receipt.sequencePin).toBeUndefined();
    const unpinned = await pinHost("sequence-2").registry.dispatch("test.mutate", {});
    expect(unpinned.ranOnSequenceId).toBe("sequence-2");
  });
  it("runs the pin check inside the mutation queue, after an earlier command has finished", async () => {
    const value = pinHost("sequence-2");
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    value.mutation.mockImplementationOnce(async () => { order.push("first-start"); await gate; order.push("first-end"); return { outcome: "verified" }; });
    const activate = value.setActiveSequence.getMockImplementation() as (sequence: unknown) => Promise<boolean>;
    value.setActiveSequence.mockImplementation(async (sequence: unknown) => { order.push("reactivate"); return activate(sequence); });
    const first = value.registry.dispatch("test.mutate", { operationId: "first" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = value.registry.dispatch("test.mutate", { operationId: "second" }, { pinnedSequenceId: "sequence-1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "reactivate"]);
  });
  it("does not claim 'nothing changed' when a refusal follows a pin switch", async () => {
    const first = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0 };
    const second = { guid: "sequence-2", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0 };
    let calls = 0;
    // Calls: queue-time identity, pin check, pin readback, identity after the pin. The last one disagrees.
    const getActiveSequence = async () => [second, second, first, second][calls++] ?? second;
    const project = { guid: "project-1", getActiveSequence, getSequences: async () => [first, second], openSequence: async () => true, setActiveSequence: async () => true };
    const mutation = vi.fn(async () => ({ outcome: "verified" }));
    const registry = Commands.createCommandRegistry({ ppro: { Project: { getActiveProject: async () => project } }, Protocol, Workflows: { createWorkflowDefinitions: () => ({ "test.mutate": { handler: mutation } }) } });
    const error = await registry.dispatch("test.mutate", {}, { pinnedSequenceId: "sequence-1" }).catch((caught: any) => caught);
    expect(error).toMatchObject({ code: "UXP_STALE_PROJECT", hostMayHaveChanged: true, message: expect.stringContaining("re-activated from sequence-2 to sequence-1") });
    expect(error.noHostDispatch).toBeUndefined();
    expect(error.noHostWrite).toBeUndefined();
    expect(mutation).not.toHaveBeenCalled();
  });
  it("leaves Premiere alone when the pinned sequence is already active, and for reads", async () => {
    const value = pinHost("sequence-1");
    await value.registry.dispatch("test.mutate", {}, { pinnedSequenceId: "sequence-1" });
    const other = pinHost("sequence-2");
    await other.registry.dispatch("test.read", {}, { pinnedSequenceId: "sequence-1" });
    expect(value.setActiveSequence).not.toHaveBeenCalled();
    expect(other.setActiveSequence).not.toHaveBeenCalled();
  });
  it("refuses with noHostWrite and never runs the handler when the pin will not activate", async () => {
    const value = pinHost("sequence-2", false);
    await expect(value.registry.dispatch("test.mutate", {}, { pinnedSequenceId: "sequence-1" })).rejects.toMatchObject({ code: "UXP_PIN_MISMATCH", hostMayHaveChanged: true, message: expect.stringContaining("may have changed") });
    const error = await value.registry.dispatch("test.mutate", {}, { pinnedSequenceId: "sequence-1" }).catch((caught: any) => caught);
    expect(error.noHostWrite).toBeUndefined();
    expect(error.noHostDispatch).toBeUndefined();
    expect(error.dispatchEvidence).toBeUndefined();
    expect(value.mutation).not.toHaveBeenCalled();
    await expect(value.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: false });
  });
  it("keeps the fence when the pin switched the sequence and the handler then refuses (razor without confirmRazor)", async () => {
    const first = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0 };
    const second = { guid: "sequence-2", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0 };
    let active = second;
    const project = {
      guid: "project-1", getActiveSequence: async () => active, getSequences: async () => [first, second],
      openSequence: async () => true, setActiveSequence: async (sequence: typeof first) => { active = sequence; return true; },
      lockedAccess: () => undefined, executeTransaction: () => true,
    };
    const ppro = {
      Project: { getActiveProject: async () => project },
      SequenceEditor: { getEditor: () => ({}) },
      TrackItemSelection: { createEmptySelection: () => true },
      TickTime: { createWithTicks: () => ({}) },
      Constants: { MediaType: { VIDEO: 1, AUDIO: 2 }, TrackItemType: { CLIP: 1 } },
    };
    const registry = Commands.createCommandRegistry({ ppro, Protocol });
    const error = await registry.dispatch("trackItem.razor", { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 4, operationId: "razor-pinned" }, { pinnedSequenceId: "sequence-1" }).catch((caught: any) => caught);
    expect(error).toMatchObject({ code: "UXP_CONFIRMATION_REQUIRED", hostMayHaveChanged: true, noHostWrite: false });
    expect(error.message).toContain("re-activated from sequence-2 to sequence-1");
    await expect(registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: true });
    // Unpinned (or already on the pinned sequence), the same refusal leaves no fence.
    const plain = Commands.createCommandRegistry({ ppro, Protocol });
    await expect(plain.dispatch("trackItem.razor", { mediaType: "video", trackIndex: 0, clipIndex: 0, timeSeconds: 4, operationId: "razor-plain" }, { pinnedSequenceId: "sequence-1" })).rejects.toMatchObject({ noHostWrite: true });
    await expect(plain.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ recoveryRequired: false });
  });
  it("refuses when the pinned sequence is not in the active project", async () => {
    const value = pinHost("sequence-1");
    await expect(value.registry.dispatch("test.mutate", {}, { pinnedSequenceId: "gone" })).rejects.toMatchObject({ code: "UXP_PINNED_SEQUENCE_MISSING", noHostWrite: true });
  });
});

describe("panel watchdog: a hung mutation handler cannot block recovery", () => {
  function hung(options: { watchdogMs?: number } = {}) {
    const sequence = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0 };
    const project = { guid: "project-1", getActiveSequence: async () => sequence };
    let finishLate: () => void = () => undefined;
    const stuck = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { finishLate = () => resolve({ outcome: "verified" }); }));
    const next = vi.fn(async () => ({ outcome: "verified" }));
    const registry = Commands.createCommandRegistry({
      ppro: { Project: { getActiveProject: async () => project } }, Protocol, mutationWatchdogMs: options.watchdogMs ?? 30, mutationWatchdogGraceMs: 0,
      Workflows: { createWorkflowDefinitions: () => ({ "test.stuck": { handler: stuck }, "test.next": { handler: next } }) },
    });
    return { registry, stuck, next, finishLate: () => finishLate() };
  }

  it("abandons a handler that outlives its deadline, marks it unknown and keeps the fence", async () => {
    const value = hung();
    const error = await value.registry.dispatch("test.stuck", { operationId: "stuck-1" }).catch((caught: any) => caught);
    expect(error).toMatchObject({ code: "UXP_HANDLER_TIMEOUT", hostMayHaveChanged: true });
    expect(error.message).toContain("outcome is unknown");
    const recovery = await value.registry.dispatch("operations.recovery.inspect", {});
    expect(recovery).toMatchObject({ recoveryRequired: true, operations: [{ id: "stuck-1", outcome: "unknown" }] });
    // The queue has moved on, but the fence refuses new mutations until the operation is acknowledged.
    await expect(value.registry.dispatch("test.next", { operationId: "after" })).rejects.toMatchObject({ code: "UXP_RECOVERY_REQUIRED" });
    expect(value.next).not.toHaveBeenCalled();
    // A late finish of the abandoned handler records nothing: the operation stays unknown.
    value.finishLate();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(value.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ operations: [{ id: "stuck-1", outcome: "unknown" }] });
  });

  it("lets inspect and acknowledge run at once once the watchdog has fired, then allows new edits", async () => {
    const value = hung();
    await value.registry.dispatch("test.stuck", { operationId: "stuck-2" }).catch(() => undefined);
    const recovery = await value.registry.dispatch("operations.recovery.inspect", {});
    await expect(value.registry.dispatch("operations.recovery.acknowledge", {
      expectedRecoveryRevision: recovery.recoveryRevision, expectedIdentityRevision: recovery.identityRevision, operationIds: ["stuck-2"], reviewed: true,
    })).resolves.toMatchObject({ acknowledged: true, replayAuthorized: false });
    await expect(value.registry.dispatch("test.next", { operationId: "after-ack" })).resolves.toMatchObject({ outcome: "verified" });
  });

  it("acknowledges a stuck handler without waiting for the queue, even before a second command is sent", async () => {
    // Longer watchdog: the handler is hung but not yet abandoned, so a reviewed acknowledge of it queues; of an
    // unrelated unknown operation (already abandoned) it does not.
    const value = hung({ watchdogMs: 40 });
    const stuckRun = value.registry.dispatch("test.stuck", { operationId: "stuck-3" }).catch((caught: any) => caught);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // inspect never waits on the queue
    await expect(value.registry.dispatch("operations.recovery.inspect", {})).resolves.toMatchObject({ operations: [{ id: "stuck-3", outcome: "pending" }] });
    const early = await value.registry.dispatch("operations.recovery.inspect", {});
    const ack = value.registry.dispatch("operations.recovery.acknowledge", { expectedRecoveryRevision: early.recoveryRevision, expectedIdentityRevision: early.identityRevision, operationIds: ["stuck-3"], reviewed: true });
    // The acknowledge waits for the watchdog, not forever, and then fails as stale because the operation turned unknown meanwhile.
    await expect(ack).rejects.toMatchObject({ code: "UXP_STALE_RECOVERY" });
    expect(await stuckRun).toMatchObject({ code: "UXP_HANDLER_TIMEOUT" });
  });

  it("uses the caller's deadline plus the grace instead of the default", async () => {
    const value = hung({ watchdogMs: 60000 });
    const started = Date.now();
    const error = await value.registry.dispatch("test.stuck", { operationId: "stuck-4" }, { deadlineMs: 40 }).catch((caught: any) => caught);
    expect(error).toMatchObject({ code: "UXP_HANDLER_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("host objects are never kept between steps or commands", () => {
  function registryWith(handlers: Record<string, unknown>) {
    const sequence = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0 };
    const project = { guid: "project-1", getActiveSequence: async () => sequence };
    return Commands.createCommandRegistry({ ppro: { Project: { getActiveProject: async () => project } }, Protocol, Workflows: { createWorkflowDefinitions: () => handlers } });
  }

  it("a read that hits a dead host object is read again on fresh objects", async () => {
    let calls = 0;
    const registry = registryWith({ "test.read": { readOnly: true, handler: async () => { calls++; if (calls < 3) throw new Error("The script object is no longer valid."); return { ok: true, calls }; } } });
    await expect(registry.dispatch("test.read", {})).resolves.toMatchObject({ ok: true, calls: 3 });
    // Only that error is retried, and only a few times.
    let other = 0;
    const failing = registryWith({ "test.read": { readOnly: true, handler: async () => { other++; throw new Error("something else"); } } });
    await expect(failing.dispatch("test.read", {})).rejects.toThrow("something else");
    expect(other).toBe(1);
    let always = 0;
    const dead = registryWith({ "test.read": { readOnly: true, handler: async () => { always++; throw new Error("The script object is no longer valid."); } } });
    await expect(dead.dispatch("test.read", {})).rejects.toThrow("no longer valid");
    expect(always).toBe(3);
  });

  it("a mutating handler is never retried, so a write cannot run twice", async () => {
    let writes = 0;
    const registry = registryWith({ "test.mutate": { handler: async () => { writes++; throw new Error("The script object is no longer valid."); } } });
    await expect(registry.dispatch("test.mutate", { operationId: "no-retry" })).rejects.toThrow("no longer valid");
    expect(writes).toBe(1);
  });

  it("tells the panel which commands can write, so event subscriptions stand down around them", () => {
    const registry = registryWith({ "test.read": { readOnly: true, handler: async () => ({}) }, "test.select": { nonFencing: true, handler: async () => ({}) }, "test.mutate": { handler: async () => ({}) } });
    expect(registry.isMutating("test.mutate")).toBe(true);
    expect(registry.isMutating("test.read")).toBe(false);
    expect(registry.isMutating("test.select")).toBe(false);
    expect(registry.isMutating("no.such")).toBe(false);
  });
});
