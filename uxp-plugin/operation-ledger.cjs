(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpOperationLedger = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STORAGE_KEY = "premiere-mcp.operation-ledger.v1";
  const MAX_OPERATIONS = 4096;
  const MAX_STORAGE_CHARS = 1024 * 1024;
  // Retired IDs live in a fixed-size Bloom filter: it never fills and has no false negatives, so a retired ID can
  // never be reused. A false positive refuses a fresh ID (about 1 in 150 after 50,000 retired IDs); the caller picks another.
  const RETIRED_FILTER_BYTES = 65536, RETIRED_FILTER_HASHES = 7;
  const TERMINAL = ["consumed", "verified", "committed", "committed_unverified", "failed"];
  function failure(code, message) { const error = new Error(message); error.code = code; return error; }
  function createSecureSessionId(prefix) {
    // These global UXP Crypto APIs are documented since UXP 6.2 (Premiere
    // 25.6 includes UXP 8.1). Never substitute time or Math.random for entropy.
    // https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-js/global-members/crypto/crypto
    const crypto = typeof globalThis !== "undefined" && globalThis.crypto;
    if (crypto && typeof crypto.randomUUID === "function") {
      try {
        const uuid = crypto.randomUUID();
        if (typeof uuid === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uuid)) return prefix + "-" + uuid;
      } catch (_) {}
    }
    if (crypto && typeof crypto.getRandomValues === "function") {
      try {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        let hex = "";
        for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
        return prefix + "-" + hex;
      } catch (_) {}
    }
    throw failure("UXP_SECURE_IDENTITY_UNAVAILABLE", "Documented UXP cryptographic entropy is unavailable; mutations are disabled until the panel runs in a supported host");
  }
  function canonical(value, depth) {
    if ((depth || 0) > 32) throw failure("UXP_INVALID_ARGUMENT", "Invocation exceeds maximum object depth");
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map((item) => canonical(item, (depth || 0) + 1)).join(",") + "]";
    if (value && typeof value === "object") {
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
      if (keys.length > 4096) throw failure("UXP_INVALID_ARGUMENT", "Invocation has too many fields");
      return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key], (depth || 0) + 1)).join(",") + "}";
    }
    throw failure("UXP_INVALID_ARGUMENT", "Invocation must contain finite JSON values");
  }
  function createOperationLedger(options) {
    const storage = options.storage;
    const digest = options.digest;
    const durable = !!(storage && typeof storage.getItem === "function" && typeof storage.setItem === "function");
    // Explicit sessionId is a dependency-injected fixture identity. Production
    // supplies no override; reloads retain their validated durable binding.
    let sessionId = options.sessionId || null;
    if (sessionId && (typeof sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId))) throw failure("UXP_INVALID_ARGUMENT", "Invalid injected operation session identity");
    const records = new Map();
    let retiredFilter = new Uint8Array(RETIRED_FILTER_BYTES), retiredHex = null, retiredCount = 0;
    let corrupt = false, lastRaw = null;
    function filterBits(id) {
      const hex = digest("retired-operation:" + id).slice(7), bits = [];
      for (let index = 0; index < RETIRED_FILTER_HASHES; index++) bits.push(parseInt(hex.slice(index * 5, index * 5 + 5), 16) % (RETIRED_FILTER_BYTES * 8));
      return bits;
    }
    function isRetired(id) { return filterBits(id).every((bit) => (retiredFilter[bit >> 3] & (1 << (bit & 7))) !== 0); }
    // Oldest first (Map insertion order). Unresolved (pending/unknown) records are never retired.
    function retireOldest(keep) {
      let changed = false;
      for (const [id, record] of records) {
        if (records.size <= keep) break;
        if (!TERMINAL.includes(record.outcome)) continue;
        for (const bit of filterBits(id)) retiredFilter[bit >> 3] |= 1 << (bit & 7);
        records.delete(id); retiredCount++; changed = true;
      }
      if (changed) retiredHex = null;
      return changed;
    }
    function refresh(initial) {
      if (!durable) return;
      try {
        const raw = storage.getItem(STORAGE_KEY);
        // Unchanged since this context last read or wrote it: skip parsing up to 1 MB on every step of every edit.
        if (raw && raw === lastRaw) return;
        if (raw) {
          if (raw.length > MAX_STORAGE_CHARS) throw new Error("Oversized ledger");
          const value = JSON.parse(raw);
          // Version 1 stores (no retired filter) are migrated on the next write; a full one retires its oldest finished records.
          if ((value.version !== 1 && value.version !== 2) || typeof value.sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.sessionId) || !Array.isArray(value.records) || value.records.length > MAX_OPERATIONS || Object.keys(value).some((key) => !["version", "sessionId", "records", "retired", "retiredCount"].includes(key))) throw new Error("Invalid ledger");
          if (value.version === 2 && (typeof value.retired !== "string" || value.retired.length !== RETIRED_FILTER_BYTES * 2 || !/^[a-f0-9]*$/.test(value.retired) || !Number.isSafeInteger(value.retiredCount) || value.retiredCount < 0)) throw new Error("Invalid retired filter");
          if (value.version === 1 && ("retired" in value || "retiredCount" in value)) throw new Error("Invalid ledger");
          const filter = new Uint8Array(RETIRED_FILTER_BYTES);
          if (value.version === 2 && value.retired !== retiredHex) for (let index = 0; index < RETIRED_FILTER_BYTES; index++) filter[index] = parseInt(value.retired.substr(index * 2, 2), 16);
          sessionId = value.sessionId;
          const incoming = new Map();
          for (const record of value.records) {
            if (!record || typeof record.id !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(record.id) || incoming.has(record.id) || Object.keys(record).some((key) => !["id", "binding", "scope", "outcome"].includes(key)) || !/^sha256:[a-f0-9]{64}$/.test(record.binding) || !/^sha256:[a-f0-9]{64}$/.test(record.scope) || !["pending", "unknown", "consumed", "verified", "committed", "committed_unverified", "failed"].includes(record.outcome)) throw new Error("Invalid ledger record");
            // A persisted reservation has no trustworthy terminal response after reload.
            const previous = records.get(record.id);
            incoming.set(record.id, { ...record, outcome: record.outcome === "pending" ? !initial && previous && previous.outcome === "pending" && previous.binding === record.binding ? "pending" : "unknown" : record.outcome });
          }
          records.clear();
          for (const [id, record] of incoming) records.set(id, record);
          if (value.version === 2) { if (value.retired !== retiredHex) { retiredFilter = filter; retiredHex = value.retired; } retiredCount = value.retiredCount; }
          lastRaw = raw;
        } else if (records.size > 0) corrupt = true;
      } catch (_) { corrupt = true; }
    }
    refresh(true);
    if (!sessionId) { try { sessionId = createSecureSessionId("panel"); } catch (_) {} }
    function assertSecureIdentity() {
      if (!sessionId) throw failure("UXP_SECURE_IDENTITY_UNAVAILABLE", "Documented UXP cryptographic entropy is unavailable; no host mutation was dispatched");
    }
    function persist() {
      assertSecureIdentity();
      if (!storage || typeof storage.setItem !== "function") return;
      let raw = serialize();
      // Long IDs can reach the size limit before the count limit: retire finished records until the store fits.
      while (raw.length > MAX_STORAGE_CHARS && retireOldest(Math.floor(records.size * 3 / 4))) raw = serialize();
      if (raw.length > MAX_STORAGE_CHARS) throw failure("UXP_OPERATION_LEDGER_FULL", "Operation ledger is full of unresolved operations; inspect and acknowledge operation recovery");
      try { storage.setItem(STORAGE_KEY, raw); lastRaw = raw; } catch (_) { throw failure("UXP_OPERATION_LEDGER_UNAVAILABLE", "Cannot preserve operation reservation; no new host mutation was dispatched"); }
    }
    // Change the records and store them as one step: if the write fails, memory goes back to what is stored,
    // so this panel never reports a fence cleared that a restarted panel would still see.
    function commit(mutate) {
      const saved = Array.from(records, ([id, record]) => [id, record, record.outcome]), filter = retiredFilter.slice(), hex = retiredHex, count = retiredCount;
      try { if (mutate) mutate(); persist(); } catch (error) {
        records.clear();
        for (const [id, record, outcome] of saved) { record.outcome = outcome; records.set(id, record); }
        retiredFilter = filter; retiredHex = hex; retiredCount = count;
        throw error;
      }
    }
    function serialize() {
      if (retiredHex === null) { let hex = ""; for (const byte of retiredFilter) hex += (byte < 16 ? "0" : "") + byte.toString(16); retiredHex = hex; }
      return JSON.stringify({ version: 2, sessionId, records: Array.from(records.values()), retired: retiredHex, retiredCount });
    }
    function scope(identity) { return digest(canonical({ backend: "uxp", sessionId, project: identity.projectGuid || null })); }
    function bind(command, args, identity) { refresh(false); assertSecureIdentity(); return digest(canonical({ version: 1, backend: "uxp", sessionId, command, args, identity })); }
    function inspect(identity) {
      refresh(false);
      const targetScope = scope(identity);
      const operations = Array.from(records.values()).filter((item) => item.scope === targetScope && (item.outcome === "unknown" || item.outcome === "pending"));
      const value = { version: 1, backend: "uxp", sessionId, projectGuid: identity.projectGuid || null, recoveryRequired: corrupt || operations.length > 0, ledgerCorrupt: corrupt, operations };
      return { ...value, recoveryRevision: digest(canonical(value)), identityRevision: digest(canonical(identity)) };
    }
    return {
      get sessionId() { return sessionId; },
      get secureIdentityAvailable() { return !!sessionId; },
      durable,
      bind,
      get(id, binding) {
        refresh(false);
        const record = records.get(id);
        if (record && record.binding !== binding) throw failure("UXP_OPERATION_CONFLICT", "Operation ID is bound to different arguments, project, sequence, or command; inspect current state and use a new reviewed operation ID");
        if (!record && isRetired(id)) throw failure("UXP_OPERATION_EXPIRED", "Operation ID was used before and its finished record has been retired; replay is not authorized. Inspect current state and use a new operation ID");
        return record || null;
      },
      assertReady(identity) { if (inspect(identity).recoveryRequired) throw failure("UXP_RECOVERY_REQUIRED", "An earlier mutation has unknown outcome. Inspect operation recovery and current project state before acknowledging reviewed reconciliation"); },
      reserve(id, binding, identity) {
        refresh(false);
        assertSecureIdentity();
        if (records.has(id)) throw failure("UXP_OPERATION_CONSUMED", "Operation ID was already reserved by another panel context; inspect its outcome before proceeding");
        if (isRetired(id)) throw failure("UXP_OPERATION_EXPIRED", "Operation ID was used before and its finished record has been retired; replay is not authorized. Use a new operation ID");
        if (options.requireDurability === true && !durable) throw failure("UXP_OPERATION_LEDGER_UNAVAILABLE", "Persistent operation storage is unavailable; no host mutation was dispatched");
        if (corrupt) throw failure("UXP_RECOVERY_REQUIRED", "Stored operation ledger cannot be validated; mutations are blocked");
        commit(() => {
          // Retire a batch of the oldest finished records so the store is not rewritten at every edit near the limit.
          if (records.size >= MAX_OPERATIONS) retireOldest(MAX_OPERATIONS / 2);
          if (records.size >= MAX_OPERATIONS) throw failure("UXP_OPERATION_LEDGER_FULL", "Operation ledger holds " + MAX_OPERATIONS + " unresolved operations; inspect and acknowledge operation recovery");
          records.set(id, { id, binding, scope: scope(identity), outcome: "pending" });
        });
      },
      // ephemeral: a panel-generated key that no caller can send again, so a finished one needs no tombstone.
      finish(id, outcome, ephemeral) {
        refresh(false); const record = records.get(id);
        if (!record) return;
        commit(() => {
          record.outcome = ["verified", "committed", "committed_unverified", "failed"].includes(outcome) ? outcome : "unknown";
          if (ephemeral === true && record.outcome !== "unknown") records.delete(id);
        });
      },
      get retiredCount() { return retiredCount; },
      unknown(id) { refresh(false); const record = records.get(id); if (record) commit(() => { record.outcome = "unknown"; }); },
      releasePreflight(id) { refresh(false); commit(() => { records.delete(id); }); },
      inspect,
      acknowledge(identity, args) {
        const view = inspect(identity);
        if (corrupt) throw failure("UXP_RECOVERY_REQUIRED", "Corrupt operation ledger requires manual repair; acknowledgement cannot discard it");
        if (args.reviewed !== true || args.expectedRecoveryRevision !== view.recoveryRevision || args.expectedIdentityRevision !== view.identityRevision || canonical(args.operationIds) !== canonical(view.operations.map((item) => item.id))) throw failure("UXP_STALE_RECOVERY", "Reviewed recovery must match the latest inspected operation IDs, revision, and current host identity");
        commit(() => { for (const record of view.operations) records.get(record.id).outcome = "consumed"; });
        return { acknowledged: true, replayAuthorized: false, reconciledOperationIds: view.operations.map((item) => item.id), recoveryRequired: false, boundary: "user_reviewed_current_host_state", outcome: "verified" };
      }
    };
  }
  return { createOperationLedger, createSecureSessionId, canonical, STORAGE_KEY, MAX_OPERATIONS };
});
