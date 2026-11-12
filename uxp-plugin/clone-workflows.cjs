(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpCloneWorkflows = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // By default this is an append-only clone: a coordinate-bound append lets the
  // bridge prove both the original and exactly one new item without scanning
  // or overwriting unrelated timeline content. With destinationSeconds and/or
  // destinationTrackIndex it copies a clip anywhere into an empty range instead
  // (checked first, never overwrites), and finds the copy by source item and start.
  const TICKS_PER_SECOND = 254016000000;
  function createCloneWorkflowDefinitions(deps) {
    const ppro = deps.ppro;
    const fallbackTails = new Map();
    const locks = deps.locks && typeof deps.locks.withTrackMutationLock === "function"
      ? deps.locks
      : { withTrackMutationLock: localLock };
    const definitions = {
      "trackItem.clone.inspect": {
        readOnly: true,
        targetCapabilityProbe: true,
        minHostVersion: "25.6.0",
        probe: canUseTrackItemClone,
        handler: inspectTrackItemClone
      },
      "trackItem.clone": {
        destructive: true,
        undoable: true,
        idempotent: true,
        targetCapabilityProbe: true,
        minHostVersion: "25.6.0",
        probe: canUseTrackItemClone,
        handler: cloneTrackItem
      }
    };

    function canUseTrackItemClone() {
      return !!(ppro.Project && typeof ppro.Project.getActiveProject === "function" &&
        ppro.SequenceEditor && typeof ppro.SequenceEditor.getEditor === "function" &&
        ppro.TickTime && typeof ppro.TickTime.createWithSeconds === "function");
    }

    async function inspectTrackItemClone(args) {
      assertOnlyKeys(args, ["mediaType", "trackIndex", "clipIndex", "destinationSeconds", "destinationTrackIndex"]);
      const context = await activeTarget(args, false);
      const snapshot = await cloneSnapshot(context);
      const destination = destinationRequest(args);
      if (destination) await planDestination(context, snapshot, destination);
      else assertAppendSupported(snapshot);
      return snapshot;
    }

    async function cloneTrackItem(args) {
      assertOnlyKeys(args, ["mediaType", "trackIndex", "clipIndex", "expectedSnapshot", "confirmDuplicate", "operationId", "destinationSeconds", "destinationTrackIndex"]);
      requireConfirmation(args.confirmDuplicate);
      requireOperationId(args.operationId);
      const target = targetCoordinates(args), destination = destinationRequest(args);
      const expected = requiredSnapshot(args.expectedSnapshot);
      assertExpectedTarget(expected, target);
      const initial = await activeTarget(target, true);
      if (initial.projectGuid !== expected.projectGuid || initial.sequenceId !== expected.sequenceId) {
        throw refuse("UXP_STALE_TRACK_ITEM", "The active project or sequence no longer matches the reviewed duplicate snapshot");
      }
      const key = initial.projectGuid + "\u0000" + initial.sequenceId + "\u0000" + target.mediaType + "\u0000" + target.trackIndex;
      return locks.withTrackMutationLock(key, async function () {
        // Read only after entering the same track tail used by the guarded
        // slip and slide workflows. A distinct operation ID cannot pass an
        // earlier inspected coordinate into action creation.
        const context = await activeTarget(target, true);
        if (context.projectGuid !== expected.projectGuid || context.sequenceId !== expected.sequenceId) {
          throw refuse("UXP_STALE_TRACK_ITEM", "The active project or sequence changed before the duplicate transaction");
        }
        const before = await cloneSnapshot(context);
        if (!sameSnapshot(before, expected)) {
          throw refuse("UXP_STALE_TRACK_ITEM", "The reviewed source item or append boundary changed since inspection");
        }
        // Destination mode plans its range against the live track here, inside the lock; append mode keeps its bounds check.
        const plan = destination ? await planDestination(context, before, destination) : null;
        if (!plan) assertAppendSupported(before);
        let committed = false;
        context.project.lockedAccess(function () {
          // The complete asynchronous snapshot is immediately followed by
          // this synchronous check/action construction boundary. This avoids
          // creating an Action from a stale active project or sequence.
          if (guidString(context.project.guid) !== before.projectGuid || guidString(context.sequence.guid) !== before.sequenceId) {
            throw refuse("UXP_STALE_TRACK_ITEM", "The reviewed project or sequence changed before duplicate action creation");
          }
          const editor = ppro.SequenceEditor.getEditor(context.sequence);
          if (!editor || typeof editor.createCloneTrackItemAction !== "function") {
            throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere does not expose SequenceEditor clone actions");
          }
          const action = plan
            ? editor.createCloneTrackItemAction(
              context.item,
              ppro.TickTime.createWithTicks(plan.offsetTicks),
              before.mediaType === "video" ? plan.verticalOffset : 0,
              before.mediaType === "audio" ? plan.verticalOffset : 0,
              false,
              false
            )
            : editor.createCloneTrackItemAction(
              context.item,
              ppro.TickTime.createWithSeconds(before.source.durationSeconds),
              0,
              0,
              false,
              true
            );
          if (!action) throw commandError("UXP_ACTION_REJECTED", "Premiere did not create the duplicate action");
          committed = context.project.executeTransaction(function (compoundAction) {
            if (compoundAction.addAction(action) === false) {
              throw commandError("UXP_ACTION_REJECTED", "Premiere rejected the duplicate action");
            }
          }, plan ? "Duplicate timeline item to destination" : "Duplicate timeline item after source");
        });
        if (!committed) throw commandError("UXP_TRANSACTION_FAILED", "Premiere did not commit the duplicate transaction");

        try {
        // Re-resolve by the original coordinate plus the one deterministic
        // append coordinate. Do not walk or read unrelated item fields after
        // a committed action.
        const afterContext = await activeTarget(target, true);
        if (afterContext.projectGuid !== before.projectGuid || afterContext.sequenceId !== before.sequenceId) {
          throw commandError("UXP_VERIFICATION_FAILED", "Premiere changed the active project or sequence during the committed duplicate");
        }
        const after = plan ? await destinationReadback(afterContext, before, plan) : await cloneReadback(afterContext, before);
        if (plan ? !sameDestinationResult(before, after, plan) : !sameCloneResult(before, after)) {
          throw commandError("UXP_VERIFICATION_FAILED", plan ? "Premiere did not place the duplicate at the requested destination" : "Premiere did not retain the requested append-only duplicate");
        }
        return {
          duplicated: true,
          before,
          after,
          outcome: "verified",
          verificationBoundary: plan ? "source_and_destination_track_item_readback" : "source_and_appended_track_item_readback",
          undoLabel: plan ? "Duplicate timeline item to destination" : "Duplicate timeline item after source",
          ...(plan ? { note: "Only this item was copied. A linked audio or video partner was not duplicated with it." } : {})
        };
        } catch (error) {
          return { duplicated: false, committed: true, verified: false, partial: true,
            outcome: "committed_unverified", before: before, after: null, timelineChanged: null, rollbackPerformed: false,
            verificationBoundary: "committed_transaction_with_failed_readback",
            readbackError: error && error.message ? error.message : String(error),
            nextStep: "Inspect the affected track before any retry. The committed transaction was not rolled back; use Premiere Undo only after reviewing the change." };
        }
      });
    }

    async function activeTarget(args, requireTransaction) {
      if (!ppro.Project || typeof ppro.Project.getActiveProject !== "function") {
        throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere project APIs are unavailable");
      }
      const project = await ppro.Project.getActiveProject();
      if (!project) throw refuse("UXP_NO_ACTIVE_PROJECT", "No active project");
      if (requireTransaction && (typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function")) {
        throw refuse("UXP_COMMAND_UNAVAILABLE", "This Premiere build does not expose locked undoable transactions");
      }
      if (typeof project.getActiveSequence !== "function") throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere cannot resolve the active sequence");
      const sequence = await project.getActiveSequence();
      if (!sequence) throw refuse("UXP_NO_ACTIVE_SEQUENCE", "No active sequence");
      const target = targetCoordinates(args), resolved = await trackItemsAt(sequence, target);
      const item = resolved.items[target.clipIndex];
      if (!item) throw refuse("UXP_TARGET_NOT_FOUND", "clipIndex is out of range");
      return {
        project,
        sequence,
        projectGuid: requiredGuid(project.guid, "active project GUID"),
        sequenceId: requiredGuid(sequence.guid, "active sequence GUID"),
        ...target,
        item,
        items: resolved.items
      };
    }

    async function trackItemsAt(sequence, target) {
      const title = target.mediaType === "video" ? "Video" : "Audio";
      const countMethod = "get" + title + "TrackCount", trackMethod = "get" + title + "Track";
      if (typeof sequence[countMethod] !== "function" || typeof sequence[trackMethod] !== "function") {
        throw refuse("UXP_COMMAND_UNAVAILABLE", target.mediaType + " track APIs are unavailable");
      }
      const count = Number(await sequence[countMethod]());
      if (!Number.isSafeInteger(count) || count < 0) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid " + target.mediaType + " track count");
      if (target.trackIndex >= count) throw refuse("UXP_TARGET_NOT_FOUND", target.mediaType + " trackIndex is out of range");
      const track = await sequence[trackMethod](target.trackIndex), itemType = ppro.Constants && ppro.Constants.TrackItemType;
      if (!track || !itemType || itemType.CLIP == null || typeof track.getTrackItems !== "function") {
        throw refuse("UXP_COMMAND_UNAVAILABLE", "Clip track-item APIs are unavailable");
      }
      const items = Array.from(await track.getTrackItems(itemType.CLIP, false) || []);
      if (!items.length) throw refuse("UXP_TARGET_NOT_FOUND", "The target track has no clip items");
      if (items.length > 512) throw refuse("UXP_TARGET_TOO_LARGE", "The target track has more than 512 clip items");
      return { items };
    }

    async function cloneSnapshot(context) {
      return {
        projectGuid: context.projectGuid,
        sequenceId: context.sequenceId,
        mediaType: context.mediaType,
        trackIndex: context.trackIndex,
        clipIndex: context.clipIndex,
        trackItemCount: context.items.length,
        source: await itemSnapshot(context.item, "source")
      };
    }

    async function cloneReadback(context, before) {
      const items = context.items;
      const source = items[before.clipIndex], duplicate = items[before.clipIndex + 1];
      if (!source || !duplicate) throw commandError("UXP_VERIFICATION_FAILED", "Premiere did not expose both source and appended duplicate coordinates");
      return {
        projectGuid: context.projectGuid,
        sequenceId: context.sequenceId,
        mediaType: context.mediaType,
        trackIndex: context.trackIndex,
        sourceClipIndex: before.clipIndex,
        duplicateClipIndex: before.clipIndex + 1,
        trackItemCount: items.length,
        source: await itemSnapshot(source, "source readback"),
        duplicate: await itemSnapshot(duplicate, "duplicate readback")
      };
    }

    async function itemSnapshot(item, label) {
      const sourceItem = await requiredMethod(item, "getProjectItem")();
      const snapshot = {
        projectItemId: requiredIdentifier(await requiredMethod(sourceItem, "getId")(), label + " source project-item ID"),
        startSeconds: tickSeconds(await requiredMethod(item, "getStartTime")()),
        endSeconds: tickSeconds(await requiredMethod(item, "getEndTime")()),
        inSeconds: tickSeconds(await requiredMethod(item, "getInPoint")()),
        outSeconds: tickSeconds(await requiredMethod(item, "getOutPoint")()),
        durationSeconds: tickSeconds(await requiredMethod(item, "getDuration")()),
        speed: Number(await requiredMethod(item, "getSpeed")()),
        reversed: Boolean(await requiredMethod(item, "isSpeedReversed")())
      };
      for (const key of ["startSeconds", "endSeconds", "inSeconds", "outSeconds", "durationSeconds"]) {
        if (!Number.isFinite(snapshot[key]) || snapshot[key] < 0 || snapshot[key] > 86400) {
          throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid " + label + " " + key);
        }
      }
      if (!Number.isFinite(snapshot.speed) || snapshot.speed < 0 || snapshot.speed > 100) {
        throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid " + label + " speed");
      }
      return snapshot;
    }

    function destinationRequest(args) {
      if (args.destinationSeconds == null && args.destinationTrackIndex == null) return null;
      return {
        seconds: args.destinationSeconds == null ? null : boundedSeconds(args.destinationSeconds, "destinationSeconds"),
        trackIndex: args.destinationTrackIndex == null ? null : nonNegativeInt(args.destinationTrackIndex, "destinationTrackIndex")
      };
    }

    // Frame-snaps the destination, proves its range on the destination track is empty (read-only), and
    // returns the offset the clone needs, in ticks. Everything here is a refusal before any write.
    async function planDestination(context, snapshot, destination) {
      const source = snapshot.source;
      if (source.durationSeconds <= 0 || !numbersEqual(source.endSeconds - source.startSeconds, source.durationSeconds)) {
        throw refuse("UXP_TARGET_UNSUPPORTED", "The source item has no readable positive duration to copy");
      }
      if (typeof context.sequence.getTimebase !== "function") throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere cannot report the sequence frame length to snap the destination");
      if (typeof ppro.TickTime.createWithTicks !== "function") throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere cannot build an exact tick offset for the destination");
      const timebase = String(await context.sequence.getTimebase());
      if (!/^\d{1,18}$/.test(timebase) || BigInt(timebase) <= 0n) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid sequence timebase");
      const frame = BigInt(timebase), ticksPerSecond = BigInt(TICKS_PER_SECOND);
      const sourceTime = await requiredMethod(context.item, "getStartTime")();
      if (!sourceTime || !/^\d{1,30}$/.test(String(sourceTime.ticks))) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an unreadable source start tick value");
      const sourceStart = BigInt(String(sourceTime.ticks));
      const wanted = destination.seconds == null ? sourceStart : BigInt(Math.round(destination.seconds * 1000000)) * ticksPerSecond / 1000000n;
      const startTicks = (wanted + frame / 2n) / frame * frame;
      const startSeconds = Number(startTicks) / TICKS_PER_SECOND, endSeconds = startSeconds + source.durationSeconds;
      const trackIndex = destination.trackIndex == null ? snapshot.trackIndex : destination.trackIndex;
      if (endSeconds > 86400) throw refuse("UXP_INVALID_ARGUMENT", "The copy would run past the documented timeline bounds");
      const title = snapshot.mediaType === "video" ? "Video" : "Audio";
      const count = Number(await context.sequence["get" + title + "TrackCount"]());
      // A track index equal to the count asks Premiere for a new track. That is proven on live 27.0 for video only.
      if (trackIndex > count) throw refuse("UXP_TARGET_NOT_FOUND", "destinationTrackIndex is more than one past the last " + snapshot.mediaType + " track");
      if (trackIndex === count && snapshot.mediaType === "audio") throw refuse("UXP_TARGET_UNSUPPORTED", "Creating a new audio track for a copy is unproven on Premiere 27.0. Copy onto an existing audio track.");
      const existing = [];
      if (trackIndex < count) {
        const items = trackIndex === snapshot.trackIndex ? context.items : (await trackItemsAt(context.sequence, { mediaType: snapshot.mediaType, trackIndex }).catch(function (error) {
          if (error && error.code === "UXP_TARGET_NOT_FOUND") return { items: [] };
          throw error;
        })).items;
        for (let index = 0; index < items.length; index++) {
          const start = tickSeconds(await requiredMethod(items[index], "getStartTime")()), end = tickSeconds(await requiredMethod(items[index], "getEndTime")());
          if (start == null || end == null) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned unreadable item timing while checking the destination");
          if (start < endSeconds - 0.000001 && end > startSeconds + 0.000001) {
            throw refuse("UXP_TARGET_OCCUPIED", "The destination range " + startSeconds.toFixed(3) + "s to " + endSeconds.toFixed(3) + "s on " + snapshot.mediaType + " track " + trackIndex + " overlaps clip " + index + ", so nothing was copied");
          }
          existing.push({ start, end });
        }
      }
      return {
        trackIndex, startSeconds, endSeconds, frameSeconds: Number(frame) / TICKS_PER_SECOND, existing,
        offsetTicks: String(startTicks - sourceStart), verticalOffset: trackIndex - snapshot.trackIndex
      };
    }

    // The copy is found by source item and start (within half a frame), never by index. Every other clip on
    // the destination track must be exactly where it was, so a copy that trimmed a neighbour is caught.
    async function destinationReadback(context, before, plan) {
      const target = { mediaType: before.mediaType, trackIndex: plan.trackIndex, clipIndex: 0 };
      const destinationItems = plan.trackIndex === before.trackIndex ? context.items : (await trackItemsAt(context.sequence, target)).items;
      let duplicate = null, duplicateClipIndex = -1;
      const others = [];
      for (let index = 0; index < destinationItems.length; index++) {
        const start = tickSeconds(await requiredMethod(destinationItems[index], "getStartTime")());
        if (!duplicate && start != null && Math.abs(start - plan.startSeconds) <= plan.frameSeconds / 2) {
          const candidate = await itemSnapshot(destinationItems[index], "duplicate readback");
          if (candidate.projectItemId === before.source.projectItemId) { duplicate = candidate; duplicateClipIndex = index; continue; }
        }
        others.push({ start, end: tickSeconds(await requiredMethod(destinationItems[index], "getEndTime")()) });
      }
      if (!duplicate) throw commandError("UXP_VERIFICATION_FAILED", "Premiere did not expose the duplicate at the requested destination");
      // The source may have shifted index if the copy landed before it on the same track, so find it again by start.
      let sourceNow = null;
      for (let index = 0; index < context.items.length && !sourceNow; index++) {
        const start = tickSeconds(await requiredMethod(context.items[index], "getStartTime")());
        if (index !== duplicateClipIndex || plan.trackIndex !== before.trackIndex) {
          if (start != null && numbersEqual(start, before.source.startSeconds)) sourceNow = await itemSnapshot(context.items[index], "source readback");
        }
      }
      if (!sourceNow) throw commandError("UXP_VERIFICATION_FAILED", "Premiere did not expose the source item after the duplicate");
      const tolerance = plan.frameSeconds / 2;
      const neighboursUnchanged = others.length === plan.existing.length && others.every(function (item, index) {
        return item.start != null && item.end != null && Math.abs(item.start - plan.existing[index].start) <= tolerance && Math.abs(item.end - plan.existing[index].end) <= tolerance;
      });
      return {
        projectGuid: context.projectGuid, sequenceId: context.sequenceId, mediaType: context.mediaType,
        sourceTrackIndex: before.trackIndex, sourceClipIndex: before.clipIndex,
        destinationTrackIndex: plan.trackIndex, duplicateClipIndex,
        sourceTrackItemCount: context.items.length, destinationTrackItemCount: destinationItems.length,
        destinationGrewByOne: destinationItems.length === plan.existing.length + 1, destinationNeighboursUnchanged: neighboursUnchanged,
        source: sourceNow, duplicate
      };
    }

    function sameDestinationResult(before, after, plan) {
      const source = before.source, duplicate = after.duplicate;
      return after.projectGuid === before.projectGuid && after.sequenceId === before.sequenceId && after.mediaType === before.mediaType &&
        after.destinationGrewByOne && after.destinationNeighboursUnchanged &&
        (after.destinationTrackIndex === before.trackIndex || after.sourceTrackItemCount === before.trackItemCount) &&
        sameItem(after.source, source) && duplicate.projectItemId === source.projectItemId &&
        Math.abs(duplicate.startSeconds - plan.startSeconds) <= plan.frameSeconds / 2 &&
        numbersEqual(duplicate.endSeconds - duplicate.startSeconds, source.durationSeconds) &&
        numbersEqual(duplicate.durationSeconds, source.durationSeconds) &&
        numbersEqual(duplicate.inSeconds, source.inSeconds) && numbersEqual(duplicate.outSeconds, source.outSeconds) &&
        numbersEqual(duplicate.speed, source.speed) && duplicate.reversed === source.reversed;
    }

    function assertAppendSupported(snapshot) {
      if (snapshot.clipIndex !== snapshot.trackItemCount - 1) {
        throw refuse("UXP_TARGET_UNSUPPORTED", "Duplicate only appends a copy after the final clip item on the requested track");
      }
      const source = snapshot.source;
      if (source.durationSeconds <= 0 || !numbersEqual(source.endSeconds - source.startSeconds, source.durationSeconds) ||
        source.endSeconds + source.durationSeconds > 86400) {
        throw refuse("UXP_TARGET_UNSUPPORTED", "The source item cannot be safely appended within the documented timeline bounds");
      }
    }

    function sameCloneResult(before, after) {
      const source = before.source, duplicate = after.duplicate;
      return after.projectGuid === before.projectGuid && after.sequenceId === before.sequenceId &&
        after.mediaType === before.mediaType && after.trackIndex === before.trackIndex &&
        after.sourceClipIndex === before.clipIndex && after.duplicateClipIndex === before.clipIndex + 1 &&
        after.trackItemCount === before.trackItemCount + 1 && sameItem(after.source, source) &&
        duplicate.projectItemId === source.projectItemId &&
        numbersEqual(duplicate.startSeconds, source.endSeconds) &&
        numbersEqual(duplicate.endSeconds, source.endSeconds + source.durationSeconds) &&
        numbersEqual(duplicate.durationSeconds, source.durationSeconds) &&
        numbersEqual(duplicate.inSeconds, source.inSeconds) && numbersEqual(duplicate.outSeconds, source.outSeconds) &&
        numbersEqual(duplicate.speed, source.speed) && duplicate.reversed === source.reversed;
    }

    function sameSnapshot(left, right) {
      return left.projectGuid === right.projectGuid && left.sequenceId === right.sequenceId &&
        left.mediaType === right.mediaType && left.trackIndex === right.trackIndex &&
        left.clipIndex === right.clipIndex && left.trackItemCount === right.trackItemCount &&
        sameItem(left.source, right.source);
    }

    function sameItem(left, right) {
      return left.projectItemId === right.projectItemId && numbersEqual(left.startSeconds, right.startSeconds) &&
        numbersEqual(left.endSeconds, right.endSeconds) && numbersEqual(left.inSeconds, right.inSeconds) &&
        numbersEqual(left.outSeconds, right.outSeconds) && numbersEqual(left.durationSeconds, right.durationSeconds) &&
        numbersEqual(left.speed, right.speed) && left.reversed === right.reversed;
    }

    function targetCoordinates(args) {
      return {
        mediaType: enumValue(args.mediaType, "mediaType", ["video", "audio"]),
        trackIndex: nonNegativeInt(args.trackIndex, "trackIndex"),
        clipIndex: nonNegativeInt(args.clipIndex, "clipIndex")
      };
    }

    function requiredSnapshot(value) {
      assertObject(value, "expectedSnapshot");
      const allowed = ["projectGuid", "sequenceId", "mediaType", "trackIndex", "clipIndex", "trackItemCount", "source"];
      assertOnlyKeys(value, allowed);
      for (const key of allowed) if (!(key in value)) throw refuse("UXP_INVALID_ARGUMENT", "expectedSnapshot." + key + " is required");
      return {
        projectGuid: requiredGuid(value.projectGuid, "expectedSnapshot.projectGuid"),
        sequenceId: requiredGuid(value.sequenceId, "expectedSnapshot.sequenceId"),
        mediaType: enumValue(value.mediaType, "expectedSnapshot.mediaType", ["video", "audio"]),
        trackIndex: nonNegativeInt(value.trackIndex, "expectedSnapshot.trackIndex"),
        clipIndex: nonNegativeInt(value.clipIndex, "expectedSnapshot.clipIndex"),
        trackItemCount: positiveInt(value.trackItemCount, "expectedSnapshot.trackItemCount"),
        source: requiredItemSnapshot(value.source, "expectedSnapshot.source")
      };
    }

    function requiredItemSnapshot(value, name) {
      assertObject(value, name);
      const allowed = ["projectItemId", "startSeconds", "endSeconds", "inSeconds", "outSeconds", "durationSeconds", "speed", "reversed"];
      assertOnlyKeys(value, allowed);
      for (const key of allowed) if (!(key in value)) throw refuse("UXP_INVALID_ARGUMENT", name + "." + key + " is required");
      return {
        projectItemId: requiredIdentifier(value.projectItemId, name + ".projectItemId"),
        startSeconds: boundedSeconds(value.startSeconds, name + ".startSeconds"),
        endSeconds: boundedSeconds(value.endSeconds, name + ".endSeconds"),
        inSeconds: boundedSeconds(value.inSeconds, name + ".inSeconds"),
        outSeconds: boundedSeconds(value.outSeconds, name + ".outSeconds"),
        durationSeconds: boundedSeconds(value.durationSeconds, name + ".durationSeconds"),
        speed: boundedSpeed(value.speed, name + ".speed"),
        reversed: requiredBoolean(value.reversed, name + ".reversed")
      };
    }

    function assertExpectedTarget(expected, target) {
      if (expected.mediaType !== target.mediaType || expected.trackIndex !== target.trackIndex || expected.clipIndex !== target.clipIndex) {
        throw refuse("UXP_INVALID_ARGUMENT", "expectedSnapshot target coordinates must match mediaType, trackIndex, and clipIndex");
      }
    }

    function localLock(key, operation) {
      const previous = fallbackTails.get(key) || Promise.resolve();
      let release;
      const gate = new Promise(function (resolve) { release = resolve; });
      const tail = previous.catch(function () { return undefined; }).then(function () { return gate; });
      fallbackTails.set(key, tail);
      return previous.catch(function () { return undefined; }).then(operation).finally(function () {
        release();
        if (fallbackTails.get(key) === tail) fallbackTails.delete(key);
      });
    }

    function requiredMethod(target, name) { if (!target || typeof target[name] !== "function") throw refuse("UXP_COMMAND_UNAVAILABLE", "The required item does not expose " + name); return target[name].bind(target); }
    function assertObject(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse("UXP_INVALID_ARGUMENT", name + " must be an object"); }
    function assertOnlyKeys(value, allowed) { assertObject(value, "arguments"); for (const key of Object.keys(value)) if (allowed.indexOf(key) === -1) throw refuse("UXP_INVALID_ARGUMENT", "Unexpected argument: " + key); }
    function enumValue(value, name, allowed) { if (allowed.indexOf(value) === -1) throw refuse("UXP_INVALID_ARGUMENT", name + " must be one of " + allowed.join(", ")); return value; }
    function nonNegativeInt(value, name) { if (!Number.isSafeInteger(value) || value < 0 || value > 511) throw refuse("UXP_INVALID_ARGUMENT", name + " must be an integer from 0 to 511"); return value; }
    function positiveInt(value, name) { if (!Number.isSafeInteger(value) || value < 1 || value > 512) throw refuse("UXP_INVALID_ARGUMENT", name + " must be an integer from 1 to 512"); return value; }
    function boundedSeconds(value, name) { const seconds = Number(value); if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw refuse("UXP_INVALID_ARGUMENT", name + " must be a number from 0 to 86400"); return seconds; }
    function boundedSpeed(value, name) { const speed = Number(value); if (!Number.isFinite(speed) || speed < 0 || speed > 100) throw refuse("UXP_INVALID_ARGUMENT", name + " must be a number from 0 to 100"); return speed; }
    function requiredBoolean(value, name) { if (typeof value !== "boolean") throw refuse("UXP_INVALID_ARGUMENT", name + " must be a boolean"); return value; }
    function requireConfirmation(value) { if (value !== true) throw refuse("UXP_CONFIRMATION_REQUIRED", "trackItem.clone requires confirmDuplicate: true"); }
    function requireOperationId(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw refuse("UXP_INVALID_ARGUMENT", "operationId is required and must be 1-128 safe characters"); }
    function requiredGuid(value, name) { const guid = guidString(value); if (!guid || guid.length > 128 || guid.indexOf("\u0000") !== -1) throw commandError("UXP_VERIFICATION_FAILED", name + " is unavailable or invalid"); return guid; }
    function requiredIdentifier(value, name) { const id = guidString(value); if (!id || id.length > 512 || id.indexOf("\u0000") !== -1) throw commandError("UXP_VERIFICATION_FAILED", name + " is unavailable or invalid"); return id; }
    function guidString(value) { if (value == null) return ""; try { return typeof value.toString === "function" ? String(value.toString()) : String(value); } catch (_) { return ""; } }
    function tickSeconds(value) { const seconds = value && Number(value.seconds); return Number.isFinite(seconds) ? seconds : null; }
    function numbersEqual(left, right) { return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Math.abs(Number(left) - Number(right)) < 0.000001; }
    function commandError(code, message) { const error = new Error(message); error.code = code; return error; }
    // An error thrown before any host write; the dispatcher may release the operation ID for it.
    function refuse(code, message) { const error = commandError(code, message); error.noHostWrite = true; return error; }

    return definitions;
  }

  return { createCloneWorkflowDefinitions };
});
