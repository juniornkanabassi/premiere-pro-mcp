(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpRippleDeleteWorkflows = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TrackItems = typeof require === "function" ? require("./track-items.cjs") : globalThis.PremiereMcpTrackItems;
  const HostActions = typeof require === "function" ? require("./host-actions.cjs") : globalThis.PremiereMcpHostActions;

  // Premiere's own ripple flag is not trusted (live 27.0: shiftOverLapping behaves
  // oppositely to its name, and the shift is whole frames, which left a 17 ms gap).
  // So every ripple here removes without ripple and then moves each later item by
  // the exact amount, and every result is read back against a planned layout.
  // trackItem.rippleDelete stays narrow: one item with a contiguous successor.
  // trackItems.remove, trackItem.razor and timeline.range.extract are the
  // coordinate and range editors built on the same primitives. A razor is a
  // clone parked past the end, trimmed there, then moved back (live-proven, P5).
  const TICKS_PER_SECOND = 254016000000n;
  const PARKING_GAP = 10n * TICKS_PER_SECOND;
  const AUDIO_SAMPLE_TICKS = 5292000n; // one 48 kHz sample
  const MAX_TRACK_ITEMS = 512;
  const MAX_SCANNED_ITEMS = 4096;
  // Live 27.0: transactions of up to 3 clips or 51 moves on one track verified; a 9-clip, 3-track compound did not.
  // So one razor round handles at most this many tracks, and a move transaction groups whole tracks up to this many items.
  const RAZOR_BATCH = 4;
  const MOVE_BATCH = 50;
  const STALE_OBJECT = /no longer valid/i;
  const STALE_ATTEMPTS = 3;

  function createRippleDeleteWorkflowDefinitions(deps) {
    const ppro = deps.ppro;
    const fallbackTails = new Map();
    const locks = deps.locks && typeof deps.locks.withTrackMutationLock === "function"
      ? deps.locks
      : { withTrackMutationLock: localLock };
    const definitions = {
      "trackItem.rippleDelete.inspect": {
        readOnly: true,
        targetCapabilityProbe: true,
        minHostVersion: "25.6.0",
        probe: canUseRippleDelete,
        handler: inspectRippleDelete
      },
      "trackItem.rippleDelete": {
        destructive: true,
        undoable: true,
        idempotent: true,
        targetCapabilityProbe: true,
        minHostVersion: "25.6.0",
        probe: canUseRippleDelete,
        handler: rippleDelete
      },
      "trackItems.remove": {
        destructive: true, undoable: true, idempotent: true, targetCapabilityProbe: true, minHostVersion: "25.6.0",
        probe: canUseRippleDelete, handler: removeTrackItems
      },
      "trackItem.razor": {
        destructive: true, undoable: true, idempotent: true, targetCapabilityProbe: true, minHostVersion: "25.6.0",
        probe: canUseRippleDelete, handler: razorTrackItem
      },
      "timeline.range.extract": {
        destructive: true, undoable: true, idempotent: true, targetCapabilityProbe: true, minHostVersion: "25.6.0",
        probe: canUseRippleDelete, handler: extractRange
      }
    };

    function canUseRippleDelete() {
      return !!(ppro.Project && typeof ppro.Project.getActiveProject === "function" &&
        ppro.SequenceEditor && typeof ppro.SequenceEditor.getEditor === "function" &&
        ppro.TrackItemSelection && typeof ppro.TrackItemSelection.createEmptySelection === "function" &&
        ppro.TickTime && typeof ppro.TickTime.createWithTicks === "function" &&
        ppro.Constants && ppro.Constants.MediaType);
    }

    async function inspectRippleDelete(args) {
      assertOnlyKeys(args, ["mediaType", "trackIndex", "clipIndex"]);
      const context = await activeTarget(args, false);
      const snapshot = await rippleSnapshot(context);
      assertRippleSupported(snapshot);
      return snapshot;
    }

    async function rippleDelete(args) {
      assertOnlyKeys(args, ["mediaType", "trackIndex", "clipIndex", "expectedSnapshot", "confirmRippleDelete", "operationId"]);
      requireConfirmation(args.confirmRippleDelete);
      requireOperationId(args.operationId);
      const target = targetCoordinates(args), expected = requiredSnapshot(args.expectedSnapshot);
      assertExpectedTarget(expected, target);
      const initial = await activeTarget(target, true);
      if (initial.projectGuid !== expected.projectGuid || initial.sequenceId !== expected.sequenceId) {
        throw refuse("UXP_STALE_TRACK_ITEM", "The active project or sequence no longer matches the reviewed ripple-delete snapshot");
      }
      const key = initial.projectGuid + "\u0000" + initial.sequenceId + "\u0000" + target.mediaType + "\u0000" + target.trackIndex;
      return locks.withTrackMutationLock(key, async function () {
        // This full preflight occurs after entering the same per-track tail as
        // slips, slides, and append duplicates, so a distinct operation ID
        // cannot construct a remove action from an obsolete timeline state.
        let context;
        try {
          context = await activeTarget(target, true);
        } catch (error) {
          if (error && error.code === "UXP_TARGET_NOT_FOUND") {
            throw refuse("UXP_STALE_TRACK_ITEM", "The reviewed target no longer exists before the ripple-delete transaction");
          }
          throw error;
        }
        if (context.projectGuid !== expected.projectGuid || context.sequenceId !== expected.sequenceId) {
          throw refuse("UXP_STALE_TRACK_ITEM", "The active project or sequence changed before the ripple-delete transaction");
        }
        let before;
        try {
          before = await rippleSnapshot(context);
        } catch (error) {
          if (error && error.code === "UXP_TARGET_UNSUPPORTED") {
            throw refuse("UXP_STALE_TRACK_ITEM", "The reviewed contiguous successor changed before the ripple-delete transaction");
          }
          throw error;
        }
        if (!sameSnapshot(before, expected)) {
          throw refuse("UXP_STALE_TRACK_ITEM", "The reviewed target or contiguous successor changed since inspection");
        }
        assertRippleSupported(before);
        // Other tracks no longer block the delete (live 27.0 refused it for nothing), but their
        // items are not moved, so a linked partner drifts. Report them; the scan is advisory.
        let scan = null, scanError = null;
        try { scan = await crossTrackBlockers(context.sequence, context, before.target.startSeconds, before.target.endSeconds); } catch (error) { scanError = error && error.message ? error.message : String(error); }
        const progress = { undoSteps: 0 };
        const scanReport = { otherTrackItemsOverRange: scan ? scan.blockers.slice(0, 8) : null, laterClipsOnUntouchedTracks: scan ? scan.later : null, ...(scanError ? { scanError } : {}) };
        let after;
        try {
          // The edit engine needs the sequence timebase, which the inspection context does not carry.
          const edit = await editContext();
          if (edit.projectGuid !== before.projectGuid || edit.sequenceId !== before.sequenceId) throw refuse("UXP_STALE_TRACK_ITEM", "The active project or sequence changed before the ripple-delete transaction");
          const closed = await removeAndClose(edit, progress, [{
            mediaType: target.mediaType, trackIndex: target.trackIndex, clipIndex: target.clipIndex, expectedProjectItemId: before.target.projectItemId
          }], true, "Ripple delete timeline item");
          after = await retryStale(async function () {
            const afterContext = await activeTarget(target, true);
            if (afterContext.projectGuid !== before.projectGuid || afterContext.sequenceId !== before.sequenceId) {
              throw commandError("UXP_VERIFICATION_FAILED", "Premiere changed the active project or sequence during the committed ripple delete");
            }
            return rippleReadback(afterContext, before);
          });
          const notes = closed.problems.slice();
          if (!sameRippleResult(before, after)) notes.unshift(describeRippleDivergence(before, after));
          if (notes.length) throw commandError("UXP_VERIFICATION_FAILED", notes.join("; "));
        } catch (error) {
          if (!progress.undoSteps) throw error;
          // The remove already committed, so a bare failure would invite a retry that deletes a second clip.
          // Return the same receipt shape as remove, razor and extract so undo can record it.
          return Object.assign(unverified({ rippleDeleted: false, before, after: null, ...scanReport }, progress, [
            "The project has already changed, but the result is not the requested contiguous ripple delete: " + (error && error.message ? error.message : String(error)) + ". Do not retry this call."
          ]), { readbackError: error && error.message ? error.message : String(error) });
        }
        return {
          rippleDeleted: true,
          before,
          after,
          outcome: "verified",
          verificationBoundary: "planned_track_layout_and_successor_readback",
          undoLabel: "Ripple delete timeline item",
          undoSteps: progress.undoSteps,
          ...scanReport
        };
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

    // Items on other tracks over the removed range are not moved by a single-track ripple, so
    // a linked partner or spanning layer drifts. Count them, and the clips after the edit point
    // that are now out of sync, so the receipt can say so.
    async function crossTrackBlockers(sequence, target, startSeconds, endSeconds) {
      const itemType = ppro.Constants && ppro.Constants.TrackItemType, blockers = [];
      let scanned = 0, later = 0;
      for (const mediaType of ["video", "audio"]) {
        const title = mediaType === "video" ? "Video" : "Audio";
        const countMethod = "get" + title + "TrackCount", trackMethod = "get" + title + "Track";
        if (typeof sequence[countMethod] !== "function" || typeof sequence[trackMethod] !== "function") {
          throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere cannot list " + mediaType + " tracks to check the ripple range");
        }
        const count = Number(await sequence[countMethod]());
        if (!Number.isInteger(count) || count < 0 || count > 512) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned unreadable track counts while checking the ripple range");
        for (let trackIndex = 0; trackIndex < count; trackIndex++) {
          if (mediaType === target.mediaType && trackIndex === target.trackIndex) continue;
          const track = await sequence[trackMethod](trackIndex);
          if (!track || typeof track.getTrackItems !== "function") throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere cannot inspect a track while checking the ripple range");
          const items = await TrackItems.sortByStart(await track.getTrackItems(itemType.CLIP, false));
          for (let clipIndex = 0; clipIndex < items.length; clipIndex++) {
            if (++scanned > 4096) throw refuse("UXP_TARGET_UNSUPPORTED", "Too many timeline items to check the ripple range safely");
            const start = tickSeconds(await items[clipIndex].getStartTime()), end = tickSeconds(await items[clipIndex].getEndTime());
            if (start == null || end == null) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned unreadable item timing while checking the ripple range");
            if (start < endSeconds - 0.000001 && end > startSeconds + 0.000001) blockers.push({ mediaType, trackIndex, clipIndex });
            else if (start >= endSeconds - 0.000001) later++;
          }
        }
      }
      return { blockers, later };
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
      const items = await TrackItems.sortByStart(await track.getTrackItems(itemType.CLIP, false));
      if (!items.length) throw refuse("UXP_TARGET_NOT_FOUND", "The target track has no clip items");
      if (items.length > 512) throw refuse("UXP_TARGET_TOO_LARGE", "The target track has more than 512 clip items");
      return { items };
    }

    async function rippleSnapshot(context) {
      const following = context.items[context.clipIndex + 1];
      if (!following) throw refuse("UXP_TARGET_UNSUPPORTED", "Ripple delete requires one immediate following clip item on the same track");
      return {
        projectGuid: context.projectGuid,
        sequenceId: context.sequenceId,
        mediaType: context.mediaType,
        trackIndex: context.trackIndex,
        clipIndex: context.clipIndex,
        trackItemCount: context.items.length,
        target: await itemSnapshot(context.item, "target"),
        following: await itemSnapshot(following, "following")
      };
    }

    async function rippleReadback(context, before) {
      return {
        projectGuid: context.projectGuid,
        sequenceId: context.sequenceId,
        mediaType: context.mediaType,
        trackIndex: context.trackIndex,
        successorClipIndex: before.clipIndex,
        trackItemCount: context.items.length,
        successor: await itemSnapshot(context.item, "successor readback")
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

    function assertRippleSupported(snapshot) {
      if (snapshot.clipIndex >= snapshot.trackItemCount - 1) {
        throw refuse("UXP_TARGET_UNSUPPORTED", "Ripple delete requires a following clip item to close the requested cut");
      }
      const target = snapshot.target, following = snapshot.following;
      if (target.endSeconds <= target.startSeconds || following.endSeconds <= following.startSeconds ||
        target.durationSeconds <= 0 || following.durationSeconds <= 0 ||
        !numbersEqual(target.endSeconds, following.startSeconds)) {
        throw refuse("UXP_TARGET_UNSUPPORTED", "Ripple delete supports only positive-duration items with one contiguous same-track successor");
      }
    }

    function sameRippleResult(before, after) {
      const targetTimelineDuration = before.target.endSeconds - before.target.startSeconds;
      const following = before.following, successor = after.successor;
      return after.projectGuid === before.projectGuid && after.sequenceId === before.sequenceId &&
        after.mediaType === before.mediaType && after.trackIndex === before.trackIndex &&
        after.successorClipIndex === before.clipIndex && after.trackItemCount === before.trackItemCount - 1 &&
        successor.projectItemId === following.projectItemId &&
        numbersEqual(successor.startSeconds, following.startSeconds - targetTimelineDuration) &&
        numbersEqual(successor.endSeconds, following.endSeconds - targetTimelineDuration) &&
        numbersEqual(successor.inSeconds, following.inSeconds) && numbersEqual(successor.outSeconds, following.outSeconds) &&
        numbersEqual(successor.durationSeconds, following.durationSeconds) &&
        numbersEqual(successor.speed, following.speed) && successor.reversed === following.reversed;
    }

    function describeRippleDivergence(before, after) {
      const notes = [];
      const targetTimelineDuration = before.target.endSeconds - before.target.startSeconds;
      const following = before.following, successor = after.successor;
      if (after.projectGuid !== before.projectGuid || after.sequenceId !== before.sequenceId ||
        after.mediaType !== before.mediaType || after.trackIndex !== before.trackIndex) {
        notes.push("the coordinate no longer resolves the same project, sequence, or track");
      }
      if (after.trackItemCount === before.trackItemCount) {
        notes.push("the track still holds " + after.trackItemCount + " clip items, so nothing was removed");
      } else if (after.trackItemCount !== before.trackItemCount - 1) {
        notes.push("the track holds " + after.trackItemCount + " clip items instead of the expected " + (before.trackItemCount - 1));
      }
      if (successor.projectItemId !== following.projectItemId) {
        notes.push("a different clip now occupies the removed item's index");
      } else if (!numbersEqual(successor.startSeconds, following.startSeconds - targetTimelineDuration)) {
        notes.push(numbersEqual(successor.startSeconds, following.startSeconds)
          ? "the following clip did not move, so the delete left a gap of " + seconds(targetTimelineDuration) +
            " instead of rippling the track closed"
          : "the following clip starts at " + seconds(successor.startSeconds) + " instead of the expected " +
            seconds(following.startSeconds - targetTimelineDuration));
      }
      if (successor.projectItemId === following.projectItemId &&
        (!numbersEqual(successor.inSeconds, following.inSeconds) || !numbersEqual(successor.outSeconds, following.outSeconds) ||
          !numbersEqual(successor.durationSeconds, following.durationSeconds))) {
        notes.push("the following clip's source range or duration changed, which a ripple delete must leave untouched");
      }
      return notes.length ? notes.join("; ") : "the readback did not match the requested ripple delete";
    }

    function seconds(value) {
      return (Math.round(value * 1000) / 1000) + "s";
    }

    function sameSnapshot(left, right) {
      return left.projectGuid === right.projectGuid && left.sequenceId === right.sequenceId &&
        left.mediaType === right.mediaType && left.trackIndex === right.trackIndex &&
        left.clipIndex === right.clipIndex && left.trackItemCount === right.trackItemCount &&
        sameItem(left.target, right.target) && sameItem(left.following, right.following);
    }

    function sameItem(left, right) {
      return left.projectItemId === right.projectItemId && numbersEqual(left.startSeconds, right.startSeconds) &&
        numbersEqual(left.endSeconds, right.endSeconds) && numbersEqual(left.inSeconds, right.inSeconds) &&
        numbersEqual(left.outSeconds, right.outSeconds) && numbersEqual(left.durationSeconds, right.durationSeconds) &&
        numbersEqual(left.speed, right.speed) && left.reversed === right.reversed;
    }

    // ---- Shared editing engine -------------------------------------------------
    // Times are BigInt ticks. Every selection and action is built inside the one
    // lockedAccess callback that uses it (live 27.0: they die when it returns).

    async function editContext() {
      if (!ppro.Project || typeof ppro.Project.getActiveProject !== "function") throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere project APIs are unavailable");
      const project = await ppro.Project.getActiveProject();
      if (!project) throw refuse("UXP_NO_ACTIVE_PROJECT", "No active project");
      if (typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function" || typeof project.getActiveSequence !== "function") {
        throw refuse("UXP_COMMAND_UNAVAILABLE", "This Premiere build does not expose locked undoable transactions");
      }
      const sequence = await project.getActiveSequence();
      if (!sequence) throw refuse("UXP_NO_ACTIVE_SEQUENCE", "No active sequence");
      const timebase = String(await requiredMethod(sequence, "getTimebase")());
      if (!/^\d{1,18}$/.test(timebase) || BigInt(timebase) <= 0n) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid sequence timebase");
      return { project, sequence, projectGuid: requiredGuid(project.guid, "active project GUID"), sequenceId: requiredGuid(sequence.guid, "active sequence GUID"), frame: BigInt(timebase) };
    }

    // Never reuse a project or sequence across a committed transaction: Premiere may have killed both.
    // After every commit they are resolved again (the active project, then its active sequence) and checked
    // to be the same ones.
    async function refreshContext(context) {
      const fresh = await retryStale(editContext);
      if (fresh.projectGuid !== context.projectGuid || fresh.sequenceId !== context.sequenceId) {
        throw commandError("UXP_STALE_TRACK_ITEM", "The active project or sequence changed during the edit");
      }
      context.project = fresh.project;
      context.sequence = fresh.sequence;
    }

    function snapTicks(seconds, frame) {
      const perFrame = frame * 1000000n;
      return (BigInt(Math.round(seconds * 1000000)) * TICKS_PER_SECOND + perFrame / 2n) / perFrame * frame;
    }
    function ceilTo(value, frame) { return (value + frame - 1n) / frame * frame; }
    function tickTime(value) { return ppro.TickTime.createWithTicks(String(value)); }
    function secondsOf(ticks) { return Math.round(Number(ticks) / Number(TICKS_PER_SECOND) * 1000) / 1000; }
    function tolerance(context, mediaType) { return mediaType === "video" ? context.frame / 2n : AUDIO_SAMPLE_TICKS; }

    async function trackCount(sequence, mediaType) {
      const count = Number(await requiredMethod(sequence, mediaType === "video" ? "getVideoTrackCount" : "getAudioTrackCount")());
      if (!Number.isSafeInteger(count) || count < 0 || count > 512) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid " + mediaType + " track count");
      return count;
    }

    async function clipItemsOf(sequence, mediaType, trackIndex) {
      const track = await requiredMethod(sequence, mediaType === "video" ? "getVideoTrack" : "getAudioTrack")(trackIndex);
      if (!track || typeof track.getTrackItems !== "function") throw refuse("UXP_TARGET_NOT_FOUND", mediaType + " track " + trackIndex + " is unavailable");
      const items = await TrackItems.sortByStart(await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
      if (items.length > MAX_TRACK_ITEMS) throw refuse("UXP_TARGET_TOO_LARGE", "A track has more than " + MAX_TRACK_ITEMS + " clip items");
      return items;
    }

    async function ticksOf(item, method) {
      const time = await requiredMethod(item, method)();
      const ticks = time && time.ticks != null ? String(time.ticks) : "";
      if (!/^-?\d{1,30}$/.test(ticks)) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an unreadable " + method + " tick value");
      return BigInt(ticks);
    }

    async function infoOf(item) {
      const sourceItem = await requiredMethod(item, "getProjectItem")();
      return {
        item, start: await ticksOf(item, "getStartTime"), end: await ticksOf(item, "getEndTime"),
        inPoint: await ticksOf(item, "getInPoint"), outPoint: await ticksOf(item, "getOutPoint"),
        pid: requiredIdentifier(await requiredMethod(sourceItem, "getId")(), "project-item ID")
      };
    }

    // Premiere kills host objects around a commit (live 27.0: handles read just after one died with "The script
    // object is no longer valid."). A read, or any step that has not yet written, is simply done again on fresh
    // objects, a few times with a short pause.
    async function retryStale(step) {
      for (let attempt = 1; ; attempt++) {
        try { return await step(); } catch (error) {
          if (attempt >= STALE_ATTEMPTS || !STALE_OBJECT.test(error && error.message ? error.message : "")) throw error;
          await new Promise(function (resolve) { setTimeout(resolve, 25 * attempt); });
        }
      }
    }

    // Reads a track from clipIndex `from` on, so a caller never touches items before its first target.
    function readTrack(sequence, mediaType, trackIndex, from) {
      return retryStale(async function () {
        const items = (await clipItemsOf(sequence, mediaType, trackIndex)).slice(from || 0), infos = [];
        for (const item of items) infos.push(await infoOf(item));
        return { items, infos };
      });
    }

    async function nameOf(item) {
      try { return typeof item.getName === "function" ? String(await item.getName()) : "a clip"; } catch (_) { return "a clip"; }
    }

    // The edit math in one place: cut at `a`..`b`, drop what is inside, close the gap.
    // With a === b it is a razor cut (nothing dropped, nothing moved).
    function layoutAfter(infos, a, b) {
      const shift = b - a, out = [];
      for (const it of infos) {
        if (it.end <= a) out.push({ pid: it.pid, start: it.start, end: it.end, inPoint: it.inPoint, outPoint: it.outPoint });
        else if (it.start >= b) out.push({ pid: it.pid, start: it.start - shift, end: it.end - shift, inPoint: it.inPoint, outPoint: it.outPoint });
        else {
          if (it.start < a) out.push({ pid: it.pid, start: it.start, end: a, inPoint: it.inPoint, outPoint: it.inPoint + (a - it.start) });
          if (it.end > b) out.push({ pid: it.pid, start: a, end: it.end - shift, inPoint: it.inPoint + (b - it.start), outPoint: it.outPoint });
        }
      }
      return out;
    }

    function layoutProblems(actual, expected, tol, label, offset) {
      const problems = [];
      let maxError = 0n;
      if (actual.length !== expected.length) problems.push(label + " holds " + actual.length + " clip items instead of the expected " + expected.length);
      for (let i = 0; i < Math.min(actual.length, expected.length) && problems.length < 10; i++) {
        const got = actual[i], want = expected[i], where = label + " clip " + (i + offset);
        if (got.pid !== want.pid) { problems.push(where + " is a different source item than planned"); continue; }
        const errors = [got.start - want.start, got.end - want.end, got.inPoint - want.inPoint, got.outPoint - want.outPoint].map(function (value) { return value < 0n ? -value : value; });
        for (const error of errors.slice(0, 2)) if (error > maxError) maxError = error;
        if (errors.some(function (error) { return error > tol; })) {
          problems.push(where + " is at " + secondsOf(got.start) + "s to " + secondsOf(got.end) + "s (source " + secondsOf(got.inPoint) + "s to " + secondsOf(got.outPoint) + "s) instead of " +
            secondsOf(want.start) + "s to " + secondsOf(want.end) + "s (source " + secondsOf(want.inPoint) + "s to " + secondsOf(want.outPoint) + "s)");
        }
      }
      return { problems, maxError };
    }

    // plans: [{ mediaType, trackIndex, from, expected }]
    async function verifyLayouts(context, plans) {
      const problems = [];
      let maxError = 0n;
      for (const plan of plans) {
        const read = await readTrack(context.sequence, plan.mediaType, plan.trackIndex, plan.from);
        const result = layoutProblems(read.infos, plan.expected, tolerance(context, plan.mediaType), plan.mediaType + " track " + plan.trackIndex, plan.from);
        problems.push.apply(problems, result.problems);
        if (result.maxError > maxError) maxError = result.maxError;
      }
      return { problems, maxError };
    }

    function stop(progress, code, message) { return progress.undoSteps ? commandError(code, message) : refuse(code, message); }

    function createSelection(items) {
      let selection = null;
      const created = ppro.TrackItemSelection.createEmptySelection(function (value) { selection = value; });
      if (created !== true || !selection || typeof selection.addItem !== "function") throw commandError("UXP_SELECTION_REJECTED", "Premiere did not create a selection");
      for (const item of items) if (selection.addItem(item, false) !== true) throw commandError("UXP_SELECTION_REJECTED", "Premiere rejected an item for the selection");
      return selection;
    }

    // Host objects die (live 27.0: "The script object is no longer valid") once a transaction or a
    // long run of reads has passed, so no item is carried from one step to the next. Each step names
    // its items by position (ref) and they are fetched again here, one track call each, right before
    // the lockedAccess that uses them. ref: { mediaType, trackIndex, index, start } with start in ticks.
    async function freshItems(context, progress, refs) {
      const tracks = new Map(), items = [];
      for (const ref of refs) {
        const key = ref.mediaType + ":" + ref.trackIndex;
        if (!tracks.has(key)) tracks.set(key, await clipItemsOf(context.sequence, ref.mediaType, ref.trackIndex));
        const item = tracks.get(key)[ref.index];
        if (!item || await ticksOf(item, "getStartTime") !== ref.start) {
          const moved = stop(progress, "UXP_VERIFICATION_FAILED", ref.mediaType + " track " + ref.trackIndex + " clip " + ref.index + " is no longer where it was read");
          moved.readMismatch = true;
          throw moved;
        }
        items.push(item);
      }
      return items;
    }

    // One undoable transaction. `build(make, fail, items)` runs inside lockedAccess with the refs' fresh items
    // and returns the actions. `make` creates the two editor actions here, where the lock is held.
    // An object that died before the transaction ran wrote nothing, so that case is retried on new objects.
    async function transact(context, progress, label, refs, build) {
      for (let attempt = 1; ; attempt++) {
        let committed = false, reached = false;
        try {
          const items = await freshItems(context, progress, refs);
          context.project.lockedAccess(function () {
            if (guidString(context.project.guid) !== context.projectGuid || guidString(context.sequence.guid) !== context.sequenceId) {
              throw stop(progress, "UXP_STALE_TRACK_ITEM", "The active project or sequence changed before the edit");
            }
            const editor = ppro.SequenceEditor.getEditor(context.sequence);
            if (!editor) throw stop(progress, "UXP_COMMAND_UNAVAILABLE", "Premiere does not expose SequenceEditor actions");
            const make = {
              // Never Premiere's own ripple: it shifts by whole frames and its overlap flag is unreliable.
              remove: function (selection, mediaType) {
                if (typeof editor.createRemoveItemsAction !== "function") throw stop(progress, "UXP_COMMAND_UNAVAILABLE", "Premiere does not expose documented remove actions");
                return editor.createRemoveItemsAction(selection, false, mediaType, false);
              },
              clone: function (item, offset) {
                if (typeof editor.createCloneTrackItemAction !== "function") throw stop(progress, "UXP_COMMAND_UNAVAILABLE", "Premiere does not expose SequenceEditor clone actions");
                return editor.createCloneTrackItemAction(item, offset, 0, 0, false, false);
              }
            };
            const actions = build(make, function (code, message) { return stop(progress, code, message); }, items);
            for (const action of actions) if (!action) throw stop(progress, "UXP_ACTION_REJECTED", "Premiere did not create every action for " + label);
            reached = true;
            committed = context.project.executeTransaction(function (compoundAction) {
              for (const action of actions) if (compoundAction.addAction(action) === false) throw commandError("UXP_ACTION_REJECTED", "Premiere rejected an action for " + label);
            }, label);
          });
        } catch (error) {
          // Right after a commit Premiere may still refuse actions or read back a clip mid-update (live 27.0).
          if (attempt < STALE_ATTEMPTS && !reached && (error && error.readMismatch || STALE_OBJECT.test(error && error.message ? error.message : ""))) {
            await HostActions.settle(attempt);
            continue;
          }
          throw error;
        }
        if (!committed) throw commandError("UXP_TRANSACTION_FAILED", "Premiere did not commit " + label);
        progress.undoSteps++;
        await refreshContext(context);
        return;
      }
    }

    // Runs an edit; once a transaction has committed, any later failure becomes a
    // committed_unverified receipt that says how many Undo steps to take. A razor parks clones past the
    // end of a track; whenever one may be left there the receipt lists exactly where (parkedClones).
    async function guarded(progress, base, operation) {
      let receipt;
      try { receipt = await operation(); } catch (error) {
        if (!progress.undoSteps) throw error;
        receipt = Object.assign({}, base, {
          committed: true, verified: false, partial: true, outcome: "committed_unverified", undoSteps: progress.undoSteps, rollbackPerformed: false,
          verificationBoundary: "committed_transaction_with_failed_follow_up",
          readbackError: error && error.message ? error.message : String(error),
          nextStep: "Inspect the affected tracks before any retry. Use Premiere Undo " + progress.undoSteps + " time" + (progress.undoSteps === 1 ? "" : "s") + " to reverse the committed steps."
        });
      }
      if (receipt && receipt.partial === true && progress.parking) await reportParked(progress, receipt);
      return receipt;
    }

    // progress.parking: { context, floors: [{ mediaType, trackIndex, floor }] }. Anything at or after a
    // floor is a parked clone: originals end at least a full parking gap before it.
    async function reportParked(progress, receipt) {
      const found = [];
      try {
        for (const spot of progress.parking.floors) {
          const read = await readTrack(progress.parking.context.sequence, spot.mediaType, spot.trackIndex, 0);
          read.infos.forEach(function (info, clipIndex) {
            if (info.start >= spot.floor) found.push({ mediaType: spot.mediaType, trackIndex: spot.trackIndex, clipIndex, projectItemId: info.pid, startSeconds: secondsOf(info.start), endSeconds: secondsOf(info.end) });
          });
        }
      } catch (error) {
        receipt.parkedClones = null;
        receipt.parkedScanError = error && error.message ? error.message : String(error);
        return;
      }
      receipt.parkedClones = found;
      if (found.length) {
        receipt.nextStep = (receipt.nextStep || "") + " " + found.length + " cloned clip" + (found.length === 1 ? " is" : "s are") + " still parked past the end of the timeline (see parkedClones). Remove them with remove_track_items_uxp, or Undo the committed steps.";
      }
    }

    function unverified(base, progress, problems) {
      return Object.assign({}, base, {
        committed: true, verified: false, partial: true, outcome: "committed_unverified", undoSteps: progress.undoSteps, rollbackPerformed: false,
        problems: problems.slice(0, 20), verificationBoundary: "committed_transaction_with_failed_readback",
        nextStep: "The edit committed but did not read back as planned. Use Premiere Undo " + progress.undoSteps + " time" + (progress.undoSteps === 1 ? "" : "s") + " to reverse it, then inspect."
      });
    }

    // ---- Removal and gap closing -----------------------------------------------

    async function loadRemovalGroups(context, requests) {
      const byTrack = new Map();
      for (const request of requests) {
        const key = request.mediaType + ":" + request.trackIndex;
        if (!byTrack.has(key)) byTrack.set(key, []);
        byTrack.get(key).push(request);
      }
      const groups = [];
      let scanned = 0;
      for (const list of byTrack.values()) {
        const mediaType = list[0].mediaType, trackIndex = list[0].trackIndex;
        const all = await clipItemsOf(context.sequence, mediaType, trackIndex);
        const from = Math.min.apply(null, list.map(function (request) { return request.clipIndex; }));
        for (const request of list) if (request.clipIndex >= all.length) throw refuse("UXP_TARGET_NOT_FOUND", mediaType + " track " + trackIndex + " has no clip " + request.clipIndex);
        const read = await readTrack(context.sequence, mediaType, trackIndex, from);
        scanned += read.infos.length;
        if (scanned > MAX_SCANNED_ITEMS) throw refuse("UXP_TARGET_TOO_LARGE", "Too many timeline items to edit safely in one call");
        const removed = new Set();
        for (const request of list) {
          const info = read.infos[request.clipIndex - from];
          if (request.expectedProjectItemId != null && info.pid !== request.expectedProjectItemId) {
            throw refuse("UXP_STALE_TRACK_ITEM", mediaType + " track " + trackIndex + " clip " + request.clipIndex + " is not the reviewed source item");
          }
          if (request.expectedStartTicks != null && info.start !== BigInt(request.expectedStartTicks)) {
            throw refuse("UXP_STALE_TRACK_ITEM", mediaType + " track " + trackIndex + " clip " + request.clipIndex + " does not start at the reviewed time");
          }
          // Seconds come from trackItem.inspect as floats, so match within half a frame.
          if (request.expectedStartSeconds != null) {
            const wantTicks = BigInt(Math.round(request.expectedStartSeconds * 1000000)) * TICKS_PER_SECOND / 1000000n, off = info.start - wantTicks;
            if ((off < 0n ? -off : off) > context.frame / 2n) throw refuse("UXP_STALE_TRACK_ITEM", mediaType + " track " + trackIndex + " clip " + request.clipIndex + " does not start at the reviewed time");
          }
          removed.add(request.clipIndex - from);
        }
        groups.push({ mediaType, trackIndex, from, items: read.items, infos: read.infos, removed });
      }
      return groups;
    }

    // What the track should hold after the removal. With ripple, each later item shifts left
    // by the length of every removed item that ended before it started; gaps are kept.
    function removalLayout(group, ripple) {
      const gone = group.infos.filter(function (info, index) { return group.removed.has(index); });
      return group.infos.filter(function (info, index) { return !group.removed.has(index); }).map(function (info) {
        let shift = 0n;
        if (ripple) for (const removed of gone) if (removed.end <= info.start) shift += removed.end - removed.start;
        return { pid: info.pid, start: info.start - shift, end: info.end - shift, inPoint: info.inPoint, outPoint: info.outPoint };
      });
    }

    async function removeTransaction(context, progress, groups, label) {
      const refs = [], types = new Set();
      for (const group of groups) group.removed.forEach(function (index) {
        refs.push({ mediaType: group.mediaType, trackIndex: group.trackIndex, index: group.from + index, start: group.infos[index].start });
        types.add(group.mediaType);
      });
      await transact(context, progress, label, refs, function (make, fail, items) {
        const constants = ppro.Constants.MediaType;
        const mediaType = types.size === 1 ? constants[types.values().next().value.toUpperCase()] : constants.ANY;
        if (mediaType == null) throw fail("UXP_COMMAND_UNAVAILABLE", "Premiere does not expose this media type constant");
        return [make.remove(createSelection(items), mediaType)];
      });
    }

    // Moves every later item to its planned start (see the ordering below).
    // plans: [{ mediaType, trackIndex, from, expected }]. Returns how many items moved.
    async function moveToLayout(context, progress, plans, label) {
      const moves = [];
      for (const plan of plans) {
        const read = await readTrack(context.sequence, plan.mediaType, plan.trackIndex, plan.from);
        if (read.infos.length !== plan.expected.length) {
          throw commandError("UXP_VERIFICATION_FAILED", plan.mediaType + " track " + plan.trackIndex + " holds " + read.infos.length + " clip items after the removal instead of " + plan.expected.length);
        }
        read.infos.forEach(function (info, index) {
          if (info.pid !== plan.expected[index].pid) throw commandError("UXP_VERIFICATION_FAILED", plan.mediaType + " track " + plan.trackIndex + " has a different clip order after the removal than planned");
          const delta = plan.expected[index].start - info.start;
          if (delta !== 0n) moves.push({ ref: { mediaType: plan.mediaType, trackIndex: plan.trackIndex, index: plan.from + index, start: info.start }, delta, start: info.start });
        });
      }
      if (!moves.length) return 0;
      // Never rely on the host's item order: left moves go earliest first, right moves latest first, so each lands in space already freed.
      const byStart = function (left, right) { return left.start < right.start ? -1 : left.start > right.start ? 1 : 0; };
      const ordered = moves.filter(function (move) { return move.delta < 0n; }).sort(byStart)
        .concat(moves.filter(function (move) { return move.delta > 0n; }).sort(function (left, right) { return byStart(right, left); }));
      // A track's moves always go in one transaction (a 51-move track was verified live that way; one split
      // across two transactions hung the panel on 27.0). Tracks are independent, so whole tracks are grouped
      // into batches of about MOVE_BATCH moves, and a longer track is a batch of its own. Within a track the
      // order above is kept.
      const byTrack = new Map();
      for (const move of ordered) {
        const key = move.ref.mediaType + ":" + move.ref.trackIndex;
        if (!byTrack.has(key)) byTrack.set(key, []);
        byTrack.get(key).push(move);
      }
      const batches = [];
      let current = [];
      for (const list of byTrack.values()) {
        if (current.length && current.length + list.length > MOVE_BATCH) { batches.push(current); current = []; }
        current = current.concat(list);
      }
      if (current.length) batches.push(current);
      for (const batch of batches) {
        await transact(context, progress, label, batch.map(function (move) { return move.ref; }), function (make, fail, items) {
          return batch.map(function (move, index) { return requiredMethod(items[index], "createMoveAction")(tickTime(move.delta)); });
        });
      }
      return moves.length;
    }

    async function removeAndClose(context, progress, requests, ripple, label) {
      const groups = await loadRemovalGroups(context, requests);
      for (const group of groups) group.expected = removalLayout(group, ripple);
      await removeTransaction(context, progress, groups, label + " (remove)");
      const moved = ripple ? await moveToLayout(context, progress, groups, label + " (close gap)") : 0;
      const verified = await verifyLayouts(context, groups);
      return { problems: verified.problems, maxErrorTicks: verified.maxError, removed: requests.length, moved };
    }

    async function removeTrackItems(args) {
      assertOnlyKeys(args, ["items", "ripple", "confirmRemove", "operationId"]);
      if (args.confirmRemove !== true) throw refuse("UXP_CONFIRMATION_REQUIRED", "trackItems.remove requires confirmRemove: true");
      requireOperationId(args.operationId);
      const ripple = args.ripple == null ? false : requiredBoolean(args.ripple, "ripple");
      if (!Array.isArray(args.items) || !args.items.length || args.items.length > MAX_TRACK_ITEMS) throw refuse("UXP_INVALID_ARGUMENT", "items must be a list of 1 to " + MAX_TRACK_ITEMS + " track-item coordinates");
      const seen = new Set();
      const requests = args.items.map(function (value) {
        assertObject(value, "items[]");
        assertOnlyKeys(value, ["mediaType", "trackIndex", "clipIndex", "expectedProjectItemId", "expectedStartTicks", "expectedStartSeconds"]);
        const request = targetCoordinates(value), key = request.mediaType + ":" + request.trackIndex + ":" + request.clipIndex;
        if (seen.has(key)) throw refuse("UXP_INVALID_ARGUMENT", "items lists " + key + " twice");
        seen.add(key);
        // A clip index shifts whenever anything is cut or removed, so every coordinate must name its clip and where it starts.
        if (value.expectedProjectItemId == null || (value.expectedStartTicks == null && value.expectedStartSeconds == null)) {
          throw refuse("UXP_INVALID_ARGUMENT", "items[] needs expectedProjectItemId and expectedStartTicks (or expectedStartSeconds) so a shifted clip index cannot remove the wrong clip");
        }
        request.expectedProjectItemId = requiredIdentifierArg(value.expectedProjectItemId, "expectedProjectItemId");
        if (value.expectedStartTicks != null) {
          if (typeof value.expectedStartTicks !== "string" || !/^\d{1,30}$/.test(value.expectedStartTicks)) throw refuse("UXP_INVALID_ARGUMENT", "expectedStartTicks must be a non-negative tick string");
          request.expectedStartTicks = value.expectedStartTicks;
        }
        if (value.expectedStartSeconds != null) request.expectedStartSeconds = boundedSeconds(value.expectedStartSeconds, "expectedStartSeconds");
        return request;
      });
      const context = await editContext(), progress = { undoSteps: 0 };
      const base = { removed: false, ripple };
      return guarded(progress, base, async function () {
        const closed = await removeAndClose(context, progress, requests, ripple, "Remove timeline items");
        if (closed.problems.length) return unverified(base, progress, closed.problems);
        return {
          removed: true, committed: true, verified: true, outcome: "verified", ripple, itemsRemoved: closed.removed, itemsMoved: closed.moved,
          maxPositionErrorSeconds: secondsOf(closed.maxErrorTicks), undoSteps: progress.undoSteps,
          verificationBoundary: "planned_track_layout_readback",
          note: ripple ? "Only the edited tracks were closed up; items on other tracks (such as a linked partner) were not moved." : undefined
        };
      });
    }

    // ---- Razor -------------------------------------------------------------------

    async function assertPlain(item, name, progress) {
      const speed = Number(await requiredMethod(item, "getSpeed")()), reversed = Boolean(await requiredMethod(item, "isSpeedReversed")());
      if (Math.abs(speed - 1) > 0.0001 || reversed) throw stop(progress, "UXP_TARGET_UNSUPPORTED", name + " has a speed change or is reversed, so a cut inside it cannot be proven");
    }

    // specs: [{ mediaType, trackIndex, clipIndex? }]. With clipIndex the item must cross the cut.
    async function planCut(context, progress, specs, cut) {
      const targets = [];
      let scanned = 0;
      for (const spec of specs) {
        const read = await readTrack(context.sequence, spec.mediaType, spec.trackIndex, 0);
        scanned += read.infos.length;
        if (scanned > MAX_SCANNED_ITEMS) throw stop(progress, "UXP_TARGET_TOO_LARGE", "Too many timeline items to cut safely in one call");
        let info;
        if (spec.clipIndex != null) {
          info = read.infos[spec.clipIndex];
          if (!info) throw stop(progress, "UXP_TARGET_NOT_FOUND", spec.mediaType + " track " + spec.trackIndex + " has no clip " + spec.clipIndex);
          if (!(info.start < cut && info.end > cut)) {
            throw stop(progress, "UXP_INVALID_ARGUMENT", "Clip " + spec.clipIndex + " runs " + secondsOf(info.start) + "s to " + secondsOf(info.end) + "s, so " + secondsOf(cut) + "s is not inside it");
          }
        } else {
          info = read.infos.find(function (it) { return it.start < cut && it.end > cut; });
          if (!info) continue;
        }
        await assertPlain(info.item, await nameOf(info.item), progress);
        targets.push({ mediaType: spec.mediaType, trackIndex: spec.trackIndex, infos: read.infos, info, index: read.infos.indexOf(info) });
      }
      return targets;
    }

    function assignParking(context, targets, cut) {
      const gap = ceilTo(PARKING_GAP, context.frame);
      for (const target of targets) {
        const last = target.infos.reduce(function (max, it) { return it.end > max ? it.end : max; }, cut);
        target.park = ceilTo(last, context.frame) + gap;
      }
    }

    async function findParked(context, target, approxStart) {
      const tol = tolerance(context, target.mediaType);
      const infos = (await readTrack(context.sequence, target.mediaType, target.trackIndex, 0)).infos;
      const index = infos.findIndex(function (it) { return it.pid === target.info.pid && (it.start > approxStart ? it.start - approxStart : approxStart - it.start) <= tol; });
      if (index === -1) throw commandError("UXP_VERIFICATION_FAILED", "The cut clip is not at its parking position on " + target.mediaType + " track " + target.trackIndex);
      return { index, start: infos[index].start };
    }

    function parkedRef(target, found) { return { mediaType: target.mediaType, trackIndex: target.trackIndex, index: found.index, start: found.start }; }

    // Clone parked past the end, trim the clone's start, move it back: three undo steps (live-proven, P5).
    // Done in rounds of RAZOR_BATCH tracks; each step reads its items again right before it uses them.
    async function razorTargets(context, progress, targets, cut, label) {
      progress.parking = progress.parking || { context, floors: [] };
      for (let at = 0; at < targets.length; at += RAZOR_BATCH) {
        const round = targets.slice(at, at + RAZOR_BATCH);
        for (const target of round) progress.parking.floors.push({ mediaType: target.mediaType, trackIndex: target.trackIndex, floor: target.park - PARKING_GAP / 2n });
        await razorRound(context, progress, round, cut, label);
        const problems = [];
        for (const target of round) {
          const read = await readTrack(context.sequence, target.mediaType, target.trackIndex, 0);
          problems.push.apply(problems, layoutProblems(read.infos, layoutAfter(target.infos, cut, cut), tolerance(context, target.mediaType), target.mediaType + " track " + target.trackIndex, 0).problems);
        }
        if (problems.length) return problems;
      }
      return [];
    }

    async function razorRound(context, progress, targets, cut, label) {
      await transact(context, progress, label + " (cut)", targets.map(function (target) { return { mediaType: target.mediaType, trackIndex: target.trackIndex, index: target.index, start: target.info.start }; }), function (make, fail, items) {
        const actions = [];
        targets.forEach(function (target, index) {
          actions.push(make.clone(items[index], tickTime(target.park - target.info.start)));
          actions.push(requiredMethod(items[index], "createSetEndAction")(tickTime(cut)));
        });
        return actions;
      });
      const parked = [];
      for (const target of targets) parked.push(await findParked(context, target, target.park));
      await transact(context, progress, label + " (trim)", targets.map(function (target, index) { return parkedRef(target, parked[index]); }), function (make, fail, items) {
        return items.map(function (item, index) { return requiredMethod(item, "createSetStartAction")(tickTime(parked[index].start + (cut - targets[index].info.start))); });
      });
      const trimmed = [];
      for (let index = 0; index < targets.length; index++) trimmed.push(await findParked(context, targets[index], parked[index].start + (cut - targets[index].info.start)));
      await transact(context, progress, label + " (place)", targets.map(function (target, index) { return parkedRef(target, trimmed[index]); }), function (make, fail, items) {
        return items.map(function (item, index) { return requiredMethod(item, "createMoveAction")(tickTime(cut - trimmed[index].start)); });
      });
    }

    async function razorTrackItem(args) {
      assertOnlyKeys(args, ["mediaType", "trackIndex", "clipIndex", "allTracks", "timeSeconds", "confirmRazor", "operationId"]);
      if (args.confirmRazor !== true) throw refuse("UXP_CONFIRMATION_REQUIRED", "trackItem.razor requires confirmRazor: true");
      requireOperationId(args.operationId);
      const timeSeconds = boundedSeconds(args.timeSeconds, "timeSeconds");
      const allTracks = args.allTracks == null ? false : requiredBoolean(args.allTracks, "allTracks");
      const coordinate = args.mediaType != null || args.trackIndex != null || args.clipIndex != null;
      if (allTracks === coordinate) throw refuse("UXP_INVALID_ARGUMENT", "Give either mediaType, trackIndex and clipIndex, or allTracks: true");
      const context = await editContext(), cut = snapTicks(timeSeconds, context.frame), progress = { undoSteps: 0 };
      const specs = [];
      if (coordinate) specs.push(targetCoordinates(args));
      else for (const mediaType of ["video", "audio"]) {
        const count = await trackCount(context.sequence, mediaType);
        for (let trackIndex = 0; trackIndex < count; trackIndex++) specs.push({ mediaType, trackIndex });
      }
      const targets = await planCut(context, progress, specs, cut);
      if (!targets.length) throw refuse("UXP_TARGET_NOT_FOUND", "No clip item crosses " + secondsOf(cut) + "s");
      assignParking(context, targets, cut);
      const base = { razored: false, cutSeconds: secondsOf(cut), cutTicks: String(cut) };
      return guarded(progress, base, async function () {
        const problems = await razorTargets(context, progress, targets, cut, "Razor timeline item");
        if (problems.length) return unverified(base, progress, problems);
        return {
          razored: true, committed: true, verified: true, outcome: "verified", cutSeconds: secondsOf(cut), cutTicks: String(cut),
          halves: targets.map(function (target) {
            return { mediaType: target.mediaType, trackIndex: target.trackIndex, projectItemId: target.info.pid, leftStartSeconds: secondsOf(target.info.start), rightEndSeconds: secondsOf(target.info.end) };
          }),
          undoSteps: progress.undoSteps, linkedHalvesRelinked: false,
          note: "The halves of a linked video and audio pair are not linked to each other again; razor both tracks with allTracks to cut them together.",
          verificationBoundary: "planned_track_layout_readback"
        };
      });
    }

    // ---- Extract a time range ------------------------------------------------------

    async function extractRange(args) {
      assertOnlyKeys(args, ["startSeconds", "endSeconds", "videoTracks", "audioTracks", "confirmExtract", "operationId"]);
      if (args.confirmExtract !== true) throw refuse("UXP_CONFIRMATION_REQUIRED", "timeline.range.extract requires confirmExtract: true");
      requireOperationId(args.operationId);
      const startSeconds = boundedSeconds(args.startSeconds, "startSeconds"), endSeconds = boundedSeconds(args.endSeconds, "endSeconds");
      // Naming tracks for one media type leaves the other alone, so the blocker check protects a linked partner. Naming neither means every track.
      const named = args.videoTracks != null || args.audioTracks != null;
      const wanted = { video: trackList(args.videoTracks, "videoTracks") || (named ? [] : null), audio: trackList(args.audioTracks, "audioTracks") || (named ? [] : null) };
      const context = await editContext(), progress = { undoSteps: 0 };
      const a = snapTicks(startSeconds, context.frame), b = snapTicks(endSeconds, context.frame);
      if (b <= a) throw refuse("UXP_INVALID_ARGUMENT", "endSeconds must be after startSeconds once both snap to a frame");
      const shift = b - a, chosen = [], blockers = [];
      let scanned = 0, touched = 0, later = 0, laterUntouched = 0;
      for (const mediaType of ["video", "audio"]) {
        const count = await trackCount(context.sequence, mediaType);
        for (const index of wanted[mediaType] || []) if (index >= count) throw refuse("UXP_TARGET_NOT_FOUND", mediaType + " track " + index + " does not exist");
        for (let trackIndex = 0; trackIndex < count; trackIndex++) {
          const read = await readTrack(context.sequence, mediaType, trackIndex, 0);
          scanned += read.infos.length;
          if (scanned > MAX_SCANNED_ITEMS) throw refuse("UXP_TARGET_TOO_LARGE", "Too many timeline items to extract from safely in one call");
          if (wanted[mediaType] && wanted[mediaType].indexOf(trackIndex) === -1) {
            read.infos.forEach(function (info, clipIndex) {
              if (info.start < b && info.end > a) blockers.push(mediaType + " track " + trackIndex + " clip " + clipIndex);
              else if (info.start >= b) laterUntouched++;
            });
            continue;
          }
          for (const info of read.infos) {
            if (info.end > a && info.start < b) touched++;
            if (info.start >= b) later++;
            if ((info.start < a && info.end > a) || (info.start < b && info.end > b)) await assertPlain(info.item, await nameOf(info.item), progress);
          }
          chosen.push({ mediaType, trackIndex, from: 0, infos: read.infos, expected: layoutAfter(read.infos, a, b) });
        }
      }
      if (blockers.length) {
        throw refuse("UXP_TARGET_UNSUPPORTED", "Tracks you did not choose have items over the range (" + blockers.slice(0, 8).join(", ") + (blockers.length > 8 ? ", ..." : "") +
          "). Closing the gap would leave them out of sync. Choose those tracks too, or take the range from all tracks. Nothing was changed.");
      }
      if (!touched && !later) throw refuse("UXP_TARGET_NOT_FOUND", "Nothing on the chosen tracks is inside or after the range");
      if (later > MAX_TRACK_ITEMS) throw refuse("UXP_TARGET_TOO_LARGE", "More than " + MAX_TRACK_ITEMS + " items would have to move");
      const specs = chosen.map(function (track) { return { mediaType: track.mediaType, trackIndex: track.trackIndex }; });
      const base = { extracted: false, startSeconds: secondsOf(a), endSeconds: secondsOf(b), laterClipsOnUntouchedTracks: laterUntouched };
      return guarded(progress, base, async function () {
        // Cut at the far edge first so the second cut still finds one item to split.
        for (const cut of [b, a]) {
          const targets = await planCut(context, progress, specs, cut);
          if (!targets.length) continue;
          assignParking(context, targets, cut);
          const problems = await razorTargets(context, progress, targets, cut, "Extract range (razor at " + secondsOf(cut) + "s)");
          if (problems.length) return unverified(base, progress, problems);
        }
        const requests = [];
        for (const spec of specs) {
          (await readTrack(context.sequence, spec.mediaType, spec.trackIndex, 0)).infos.forEach(function (info, clipIndex) {
            if (info.start >= a && info.end <= b) requests.push({ mediaType: spec.mediaType, trackIndex: spec.trackIndex, clipIndex });
          });
        }
        if (requests.length) await removeTransaction(context, progress, await loadRemovalGroups(context, requests), "Extract range (remove)");
        const moved = await moveToLayout(context, progress, chosen, "Extract range (close gap)");
        const verified = await verifyLayouts(context, chosen);
        if (verified.problems.length) return unverified(base, progress, verified.problems);
        return {
          extracted: true, committed: true, verified: true, outcome: "verified", startSeconds: secondsOf(a), endSeconds: secondsOf(b), removedSeconds: secondsOf(shift),
          tracks: chosen.length, itemsRemoved: requests.length, itemsMoved: moved, maxPositionErrorSeconds: secondsOf(verified.maxError),
          laterClipsOnUntouchedTracks: laterUntouched,
          undoSteps: progress.undoSteps, verificationBoundary: "planned_track_layout_readback"
        };
      });
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
      const allowed = ["projectGuid", "sequenceId", "mediaType", "trackIndex", "clipIndex", "trackItemCount", "target", "following"];
      assertOnlyKeys(value, allowed);
      for (const key of allowed) if (!(key in value)) throw refuse("UXP_INVALID_ARGUMENT", "expectedSnapshot." + key + " is required");
      return {
        projectGuid: requiredGuid(value.projectGuid, "expectedSnapshot.projectGuid"),
        sequenceId: requiredGuid(value.sequenceId, "expectedSnapshot.sequenceId"),
        mediaType: enumValue(value.mediaType, "expectedSnapshot.mediaType", ["video", "audio"]),
        trackIndex: nonNegativeInt(value.trackIndex, "expectedSnapshot.trackIndex"),
        clipIndex: nonNegativeInt(value.clipIndex, "expectedSnapshot.clipIndex"),
        trackItemCount: positiveInt(value.trackItemCount, "expectedSnapshot.trackItemCount"),
        target: requiredItemSnapshot(value.target, "expectedSnapshot.target"),
        following: requiredItemSnapshot(value.following, "expectedSnapshot.following")
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

    function requiredMethod(target, name) { if (!target || typeof target[name] !== "function") throw commandError("UXP_COMMAND_UNAVAILABLE", "The required item does not expose " + name); return target[name].bind(target); }
    function requiredIdentifierArg(value, name) { if (typeof value !== "string" || !value || value.length > 512 || value.indexOf("\u0000") !== -1) throw refuse("UXP_INVALID_ARGUMENT", name + " must be a non-empty string"); return value; }
    function trackList(value, name) {
      if (value == null) return null;
      if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length || value.some(function (index) { return !Number.isSafeInteger(index) || index < 0 || index > 511; })) {
        throw refuse("UXP_INVALID_ARGUMENT", name + " must be a list of distinct track indexes from 0 to 511");
      }
      return value.slice();
    }
    function assertObject(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse("UXP_INVALID_ARGUMENT", name + " must be an object"); }
    function assertOnlyKeys(value, allowed) { assertObject(value, "arguments"); for (const key of Object.keys(value)) if (allowed.indexOf(key) === -1) throw refuse("UXP_INVALID_ARGUMENT", "Unexpected argument: " + key); }
    function enumValue(value, name, allowed) { if (allowed.indexOf(value) === -1) throw refuse("UXP_INVALID_ARGUMENT", name + " must be one of " + allowed.join(", ")); return value; }
    function nonNegativeInt(value, name) { if (!Number.isSafeInteger(value) || value < 0 || value > 511) throw refuse("UXP_INVALID_ARGUMENT", name + " must be an integer from 0 to 511"); return value; }
    function positiveInt(value, name) { if (!Number.isSafeInteger(value) || value < 1 || value > 512) throw refuse("UXP_INVALID_ARGUMENT", name + " must be an integer from 1 to 512"); return value; }
    function boundedSeconds(value, name) { const seconds = Number(value); if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw refuse("UXP_INVALID_ARGUMENT", name + " must be a number from 0 to 86400"); return seconds; }
    function boundedSpeed(value, name) { const speed = Number(value); if (!Number.isFinite(speed) || speed < 0 || speed > 100) throw refuse("UXP_INVALID_ARGUMENT", name + " must be a number from 0 to 100"); return speed; }
    function requiredBoolean(value, name) { if (typeof value !== "boolean") throw refuse("UXP_INVALID_ARGUMENT", name + " must be a boolean"); return value; }
    function requireConfirmation(value) { if (value !== true) throw refuse("UXP_CONFIRMATION_REQUIRED", "trackItem.rippleDelete requires confirmRippleDelete: true"); }
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

  return { createRippleDeleteWorkflowDefinitions };
});
