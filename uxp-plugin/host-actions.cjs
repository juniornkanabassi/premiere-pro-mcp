(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpHostActions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Premiere 27.0 sometimes rejects a create...Action call with "The script object is no longer valid." although
  // every argument is live (live trace, 13 Nov 2026): the identical call usually succeeds a few ms later, once the
  // host has caught up after a commit. Creating an action writes nothing (only executeTransaction does), so the
  // call is simply made again. Inside lockedAccess the panel can only wait (the callback cannot yield). Never force
  // a garbage collection to clear it: that cleared the refusals but crashed Premiere 4 times (napi_wrap heap
  // corruption, napi_reference_unref). A refusal that outlasts the short wait goes back to the step, which leaves
  // the lock and calls settle() before it tries again on fresh objects.
  const STALE_OBJECT = /no longer valid/i;
  const ACTION_FACTORY = /^create\w*Action$/;
  const SPIN_BUDGET_MS = 250;

  function spin(ms) { const until = Date.now() + ms; while (Date.now() < until) { /* the host catches up on its own thread */ } }

  function retrying(original) {
    const wrapped = function () {
      const deadline = Date.now() + SPIN_BUDGET_MS;
      for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
        try { return original.apply(this, arguments); } catch (error) {
          if (!STALE_OBJECT.test(error && error.message ? error.message : "") || Date.now() >= deadline) throw error;
          spin(wait);
        }
      }
    };
    wrapped.retriesStaleObject = true;
    return wrapped;
  }

  // Between attempts of a step, outside lockedAccess: yield so the host catches up. Attempt n waits 100 * n ms.
  function settle(attempt) { return new Promise(function (resolve) { setTimeout(resolve, 100 * attempt); }); }

  // Gives `object` its own retrying copy of every create...Action method it inherits (Premiere's are all on the
  // prototype, read-only). A method the object already has itself is left alone. Returns `object`.
  function withActionRetry(object) {
    if (!object || (typeof object !== "object" && typeof object !== "function")) return object;
    const seen = new Set();
    for (let level = Object.getPrototypeOf(object); level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
      for (const name of Object.getOwnPropertyNames(level)) {
        if (seen.has(name) || !ACTION_FACTORY.test(name) || Object.prototype.hasOwnProperty.call(object, name)) continue;
        seen.add(name);
        const descriptor = Object.getOwnPropertyDescriptor(level, name);
        if (!descriptor || typeof descriptor.value !== "function") continue;
        try {
          Object.defineProperty(object, name, { value: retrying(descriptor.value), writable: true, configurable: true, enumerable: false });
        } catch (_) { /* a sealed object keeps the host's own method */ }
      }
    }
    return object;
  }

  // SequenceEditor.getEditor hands out the editor behind clone, insert, overwrite and remove actions.
  function installEditorRetry(ppro) {
    const editors = ppro && ppro.SequenceEditor;
    if (!editors || typeof editors.getEditor !== "function" || editors.getEditor.retriesStaleObject) return false;
    const getEditor = editors.getEditor;
    const wrapped = function () { return withActionRetry(getEditor.apply(this, arguments)); };
    wrapped.retriesStaleObject = true;
    try { editors.getEditor = wrapped; } catch (_) { return false; }
    return editors.getEditor === wrapped;
  }

  return { withActionRetry, installEditorRetry, settle };
});
