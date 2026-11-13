(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpCopyClipsWorkflows = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TrackItems = typeof require === "function" ? require("./track-items.cjs") : globalThis.PremiereMcpTrackItems;

  // Copy a time range of clips from one sequence to another (or to another
  // place in the same sequence) the way an editor's copy and paste does: each
  // clip is cloned with SequenceEditor.createCloneTrackItemAction, so it keeps
  // its effects, keyframes, enabled state and source range. Legacy CEP can only
  // re-place a clip from its project item, which drops all of that.
  //
  // A clip wholly inside the range is cloned straight to its destination. A
  // clip that crosses an edge of the range is cloned whole to a parking spot
  // past the end of every destination track, trimmed to the range there, and
  // then moved into place, so its untrimmed length never overwrites a
  // neighbour. Every destination range must be empty beforehand; nothing is
  // ever overwritten.
  const MAX_PLACEMENTS = 512;
  const TICKS_PER_SECOND = 254016000000n;
  const PARKING_GAP = 10n * TICKS_PER_SECOND;
  const MAX_SEGMENTS = 256;
  // Premiere places audio on the sample grid, so a planned audio edge can land
  // up to one sample away; video lands within half a frame. Readback accepts
  // exactly that and reports the largest miss. The sample comes from the
  // sequence's audio rate; without one, the 44.1 kHz sample (the larger common one).
  const FALLBACK_SAMPLE_TICKS = 5760000n;
  // Parked clones are full-length source clips, so one round of parking is
  // capped at this extent and a long cut is done in several rounds that
  // reuse the same slot (shortcut: 3 Undo steps per round, raise if rounds are common).
  const PARKING_BUDGET = 12n * 3600n * TICKS_PER_SECOND;
  // Live 27.0: rounds of 3 or fewer parked clones verified; 9 parked clones in one round did not.
  const MAX_PARKED_PER_ROUND = 4;
  const STALE_OBJECT = /no longer valid/i;
  const STALE_ATTEMPTS = 3;
  const SEGMENT_KEYS = ["sourceStartTicks", "sourceEndTicks", "sourceStartSeconds", "sourceEndSeconds", "videoTrack"];
  // segments mode copies camera ranges from one video track each onto one
  // "program" video track of the same sequence; nothing else may be given.
  const SEGMENT_EXCLUDED = ["sourceStartTicks", "sourceEndTicks", "destinationStartTicks", "sourceStartSeconds", "sourceEndSeconds",
    "destinationStartSeconds", "videoTracks", "audioTracks", "videoTrackOffset", "audioTrackOffset"];

  function createCopyClipsWorkflowDefinitions(deps) {
    const ppro = deps.ppro;
    const definitions = {
      "sequence.copyClips.inspect": {
        readOnly: true,
        targetCapabilityProbe: true,
        minHostVersion: "25.6.0",
        probe: canCopy,
        handler: inspectCopy
      },
      "sequence.copyClips": {
        destructive: true,
        undoable: true,
        idempotent: true,
        targetCapabilityProbe: true,
        minHostVersion: "25.6.0",
        probe: canCopy,
        handler: applyCopy
      }
    };
    const TIME_KEYS = ["sourceStart", "sourceEnd", "destinationStart"];
    const ARG_KEYS = ["sourceSequenceId", "destinationSequenceId", "sourceStartTicks", "sourceEndTicks", "destinationStartTicks",
      "sourceStartSeconds", "sourceEndSeconds", "destinationStartSeconds",
      "videoTracks", "audioTracks", "videoTrackOffset", "audioTrackOffset", "segments", "programTrack"];

    function canCopy() {
      return !!(ppro.Project && typeof ppro.Project.getActiveProject === "function" &&
        ppro.SequenceEditor && typeof ppro.SequenceEditor.getEditor === "function" &&
        ppro.TickTime && typeof ppro.TickTime.createWithTicks === "function" &&
        ppro.Constants && ppro.Constants.TrackItemType);
    }

    async function inspectCopy(args) {
      assertOnlyKeys(args, ARG_KEYS);
      const request = copyRequest(args);
      const context = await projectContext(request, false);
      await resolveTimes(context, request);
      return (await planCopy(context, request)).snapshot;
    }

    async function applyCopy(args) {
      assertOnlyKeys(args, ARG_KEYS.concat(["expectedSnapshot", "confirmCopy", "operationId"]));
      if (args.confirmCopy !== true) throw refuse("UXP_CONFIRMATION_REQUIRED", "sequence.copyClips requires confirmCopy: true");
      if (typeof args.operationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.operationId)) {
        throw refuse("UXP_INVALID_ARGUMENT", "operationId is required and must be 1-128 safe characters");
      }
      assertObject(args.expectedSnapshot, "expectedSnapshot");
      const request = copyRequest(args);
      const context = await projectContext(request, true);
      await resolveTimes(context, request);
      const plan = await planCopy(context, request);
      if (canonical(plan.snapshot) !== canonical(args.expectedSnapshot)) {
        throw refuse("UXP_STALE_TRACK_ITEM", "The source clips or the destination changed since inspection; inspect again before copying");
      }
      const editor = ppro.SequenceEditor.getEditor(context.destination);
      if (!editor || typeof editor.createCloneTrackItemAction !== "function") {
        throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere does not expose SequenceEditor clone actions");
      }
      const label = "Copy " + plan.snapshot.clips.length + " clip" + (plan.snapshot.clips.length === 1 ? "" : "s") + " from " + plan.snapshot.sourceSequenceName;
      const direct = plan.entries.filter(function (entry) { return !entry.trimmed; });
      const parked = plan.entries.filter(function (entry) { return entry.trimmed; });
      const roundCount = parked.length ? parked[parked.length - 1].round + 1 : 0;

      // After a failure, lists exactly which clones are still parked past the end of their tracks.
      // Originals end well before the first parking slot, so anything at or after it is a parked clone.
      async function withParked(receipt) {
        if (!parked.length) return receipt;
        const floor = parked.reduce(function (min, entry) { return entry.parkedStart < min ? entry.parkedStart : min; }, parked[0].parkedStart);
        const spots = new Map();
        for (const entry of parked) spots.set(entry.placement.mediaType + ":" + entry.placement.targetTrackIndex, entry.placement);
        const found = [];
        try {
          for (const spot of spots.values()) {
            const items = await clipItems(context.destination, spot.mediaType, spot.targetTrackIndex);
            for (let index = 0; index < items.length; index++) {
              const start = BigInt(await ticksOf(items[index], "getStartTime"));
              if (start >= floor) found.push({ mediaType: spot.mediaType, trackIndex: spot.targetTrackIndex, clipIndex: index, projectItemId: await projectItemId(items[index]), startTicks: String(start), endTicks: await ticksOf(items[index], "getEndTime") });
            }
          }
        } catch (scanError) {
          return Object.assign(receipt, { parkedClones: null, parkedScanError: scanError && scanError.message ? scanError.message : String(scanError) });
        }
        if (found.length) receipt.nextStep += " " + found.length + " cloned clip" + (found.length === 1 ? " is" : "s are") + " still parked past the end of the destination tracks (see parkedClones). Remove them with remove_track_items_uxp, or Undo the committed steps.";
        return Object.assign(receipt, { parkedClones: found });
      }

      // Host objects die ("The script object is no longer valid", live 27.0), so no item is carried from
      // one step to the next. Each transaction reads its items again just before it, and a step whose
      // object died before the transaction ran wrote nothing, so it is tried once more on new objects.
      async function lockedTransaction(prepare, build, name, firstWrite) {
        for (let attempt = 1; ; attempt++) {
          let reached = false;
          try {
            const items = await prepare();
            context.project.lockedAccess(function () {
              // The editor is taken here, inside the lock, from the destination as resolved for this step.
              const editor = ppro.SequenceEditor.getEditor(context.destination);
              if (!editor || typeof editor.createCloneTrackItemAction !== "function") throw refuse("UXP_COMMAND_UNAVAILABLE", "Premiere does not expose SequenceEditor clone actions");
              const make = { clone: function (item, offset, videoOffset, audioOffset) { return editor.createCloneTrackItemAction(item, offset, videoOffset, audioOffset, false, false); } };
              const actions = checked(build(items, make));
              reached = true;
              committed(context.project.executeTransaction(function (compoundAction) {
                for (const action of actions) if (compoundAction.addAction(action) === false) throw commandError("UXP_ACTION_REJECTED", "Premiere rejected a copy action");
              }, name), name);
            });
            // Never reuse the project or the sequences across a commit: resolve them again by GUID.
            await retryStale(async function () { Object.assign(context, await projectContext(request, true)); });
            return;
          } catch (error) {
            if (attempt < STALE_ATTEMPTS && !reached && STALE_OBJECT.test(error && error.message ? error.message : "")) { await pause(attempt); continue; }
            if (firstWrite && !reached && error && typeof error === "object") error.noHostWrite = true;
            throw error;
          }
        }
      }

      // Transaction 1: every clone, direct ones at their destination and
      // trimmed ones at the parking spot. A clone into a track that does not
      // exist yet creates it (live 27.0, probe P4), so when the program track
      // is new its first clone goes in a transaction of its own and the rest
      // follow once the track is there.
      async function cloneTransaction(entries, name, firstWrite) {
        await lockedTransaction(
          async function () { const items = []; for (const entry of entries) items.push(await freshSource(context, entry)); return items; },
          function (items, make) {
            return entries.map(function (entry, index) {
              const at = entry.trimmed ? entry.parkedStart : BigInt(entry.placement.startTicks);
              return make.clone(items[index], ppro.TickTime.createWithTicks(String(at - entry.sourceStart)), entry.videoOffset, entry.audioOffset);
            });
          }, name, firstWrite);
      }
      // Round 0 of parking goes in with the direct clones; later rounds reuse
      // the slot once the previous round has been moved into place.
      const first = plan.entries.filter(function (entry) { return !entry.trimmed || entry.round === 0; });
      const chunks = plan.newTrack && first.length > 1 ? [first.slice(0, 1), first.slice(1)] : [first];
      await cloneTransaction(chunks[0], label, true);
      let steps = 1;
      try {
        if (plan.newTrack) {
          // Never go on unless the first clone made the track and landed on it:
          // the rest would overwrite whatever track it really went to.
          const entry = chunks[0][0], want = entry.placement.targetTrackIndex;
          const count = await trackCount(context.destination, "video");
          if (count !== want + 1) {
            throw commandError("UXP_VERIFICATION_FAILED", "Premiere did not create video track " + want + " (the sequence has " + count + " video tracks); the first clone may be on another track and the remaining clones were not made");
          }
          await findClone(context.destination, entry, entry.trimmed ? entry.parkedStart : BigInt(entry.placement.startTicks), plan);
        }
        if (chunks.length > 1) { await cloneTransaction(chunks[1], label + " (rest)"); steps++; }
        for (let round = 0; round < roundCount; round++) {
          const mine = parked.filter(function (entry) { return entry.round === round; });
          if (round > 0) { await cloneTransaction(mine, label + " (park " + (round + 1) + ")"); steps++; }
          // Transaction 2: trim each parked clone to the range. Transaction 3:
          // move it into place.
          const clones = [];
          for (const entry of mine) clones.push({ entry, at: await findClone(context.destination, entry, entry.parkedStart, plan) });
          await lockedTransaction(
            function () { return fetchAt(context.destination, clones.map(function (clone) { return clone.at; })); },
            function (items) {
              const actions = [];
              clones.forEach(function (clone, index) {
                const placement = clone.entry.placement, head = BigInt(placement.trimHeadTicks), tail = BigInt(placement.trimTailTicks);
                // Each of these is a full edge trim: SetStart moves the start and
                // the source in together, SetEnd the end and the source out
                // (live 26.0.2; SetInPoint/SetOutPoint do the same again, so
                // using both pairs trims twice).
                if (head > 0n) actions.push(requiredMethod(items[index], "createSetStartAction")(ppro.TickTime.createWithTicks(String(clone.entry.parkedStart + head))));
                if (tail > 0n) actions.push(requiredMethod(items[index], "createSetEndAction")(ppro.TickTime.createWithTicks(String(clone.entry.parkedEnd - tail))));
              });
              return actions;
            }, label + " (trim)");
          steps++;
          const trimmed = [];
          for (const entry of mine) trimmed.push({ entry, at: await findClone(context.destination, entry, entry.parkedStart + BigInt(entry.placement.trimHeadTicks), plan) });
          await lockedTransaction(
            function () { return fetchAt(context.destination, trimmed.map(function (clone) { return clone.at; })); },
            function (items) {
              return trimmed.map(function (clone, index) {
                const from = clone.entry.parkedStart + BigInt(clone.entry.placement.trimHeadTicks);
                return requiredMethod(items[index], "createMoveAction")(ppro.TickTime.createWithTicks(String(BigInt(clone.entry.placement.startTicks) - from)));
              });
            }, label + " (place)");
          steps++;
        }
      } catch (error) {
        return await withParked({ copied: false, committed: true, verified: false, partial: true, outcome: "committed_unverified", undoSteps: steps,
          readbackError: error && error.message ? error.message : String(error), rollbackPerformed: false,
          verificationBoundary: "committed_transaction_with_failed_follow_up",
          nextStep: "Some clips were cloned but not trimmed or placed. Use Premiere Undo " + steps + " time" + (steps === 1 ? "" : "s") + " to remove them, then inspect again." });
      }

      try {
        const { problems, maxDeviationTicks } = await readbackProblems(context.destination, plan);
        if (problems.length) {
          return await withParked({ copied: false, committed: true, verified: false, partial: true, outcome: "committed_unverified", undoSteps: steps,
            problems: problems.slice(0, 20), maxDeviationTicks, rollbackPerformed: false,
            verificationBoundary: "committed_transaction_with_failed_readback",
            nextStep: "The copy committed but did not read back as planned. Use Premiere Undo " + steps + " time" + (steps === 1 ? "" : "s") + " to remove it, then inspect again." });
        }
        return { copied: true, committed: true, verified: true, outcome: "verified",
          sourceSequenceName: plan.snapshot.sourceSequenceName, destinationSequenceName: plan.snapshot.destinationSequenceName,
          clipsCopied: direct.length + parked.length, clipsTrimmed: parked.length, undoSteps: steps, maxDeviationTicks,
          verificationBoundary: "placement_start_source_range_and_project_item_readback", undoLabel: label };
      } catch (error) {
        return await withParked({ copied: false, committed: true, verified: false, partial: true, outcome: "committed_unverified", undoSteps: steps,
          readbackError: error && error.message ? error.message : String(error), rollbackPerformed: false,
          verificationBoundary: "committed_transaction_with_failed_readback",
          nextStep: "Inspect the destination before any retry. Use Premiere Undo " + steps + " time" + (steps === 1 ? "" : "s") + " to remove the copy." });
      }
    }

    function checked(actions) {
      for (const action of actions) if (!action) throw commandError("UXP_ACTION_REJECTED", "Premiere did not create every copy action");
      return actions;
    }

    function committed(result, label) {
      if (!result) throw commandError("UXP_TRANSACTION_FAILED", "Premiere did not commit the copy transaction (" + label + ")");
    }

    async function projectContext(request, requireTransaction) {
      const project = await ppro.Project.getActiveProject();
      if (!project) throw refuse("UXP_NO_ACTIVE_PROJECT", "No active project");
      if (requireTransaction && (typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function")) {
        throw refuse("UXP_COMMAND_UNAVAILABLE", "This Premiere build does not expose locked undoable transactions");
      }
      const sequences = Array.from(await requiredMethod(project, "getSequences")() || []);
      const find = function (id, role) {
        const match = sequences.filter(function (sequence) { return identifier(sequence.guid) === id; });
        if (match.length !== 1) throw refuse("UXP_TARGET_NOT_FOUND", "The " + role + " sequence " + id + " is not in the active project");
        return match[0];
      };
      return { project, source: find(request.sourceSequenceId, "source"), destination: find(request.destinationSequenceId, "destination") };
    }

    // Seconds snap to the nearest frame of the sequence they are measured on,
    // so a range edge never splits a frame.
    async function resolveTimes(context, request) {
      const snap = async function (holder, key, sequence) {
        if (holder[key + "Ticks"] != null) return;
        const frame = await timebase(sequence);
        const exact = BigInt(Math.round(holder[key + "Seconds"] * 1000000)) * TICKS_PER_SECOND;
        const perFrame = frame * 1000000n;
        holder[key + "Ticks"] = String((exact + perFrame / 2n) / perFrame * frame);
      };
      if (request.segments) {
        let previousEnd = -1n;
        for (const [position, segment] of request.segments.entries()) {
          await snap(segment, "sourceStart", context.source);
          await snap(segment, "sourceEnd", context.source);
          if (BigInt(segment.sourceEndTicks) <= BigInt(segment.sourceStartTicks)) throw refuse("UXP_INVALID_ARGUMENT", "segments[" + position + "] must end after it starts");
          if (BigInt(segment.sourceStartTicks) < previousEnd) throw refuse("UXP_INVALID_ARGUMENT", "segments must be in time order and must not overlap (segments[" + position + "])");
          previousEnd = BigInt(segment.sourceEndTicks);
        }
        // The whole cut, for the plan's header; each clip carries its own placement.
        request.sourceStartTicks = request.destinationStartTicks = request.segments[0].sourceStartTicks;
        request.sourceEndTicks = String(previousEnd);
        return;
      }
      for (const key of TIME_KEYS) await snap(request, key, key === "destinationStart" ? context.destination : context.source);
      if (BigInt(request.sourceEndTicks) <= BigInt(request.sourceStartTicks)) throw refuse("UXP_INVALID_ARGUMENT", "The source end must be after the source start");
    }

    async function planCopy(context, request) {
      const { project, source, destination } = context;
      // Premiere snaps a clone to the destination's frame grid, so every
      // planned time must already sit on it, and both grids must agree.
      const frame = await timebase(source);
      if (await timebase(destination) !== frame) {
        throw refuse("UXP_TARGET_UNSUPPORTED", "The source and destination sequences have different frame rates; copying between them is not supported");
      }
      // One pass per range. Plain copies have one; a camera cut has one per
      // segment, each reading one camera track and landing on the program
      // track at the same time (shift 0).
      const segments = request.segments;
      if (segments) {
        for (const [position, segment] of segments.entries()) {
          for (const key of ["sourceStartTicks", "sourceEndTicks"]) {
            if (BigInt(segment[key]) % frame !== 0n) throw refuse("UXP_INVALID_ARGUMENT", "segments[" + position + "]." + key + " is not on a frame boundary of the sequence");
          }
        }
      } else {
        for (const key of TIME_KEYS) {
          if (BigInt(request[key + "Ticks"]) % frame !== 0n) throw refuse("UXP_INVALID_ARGUMENT", key + "Ticks is not on a frame boundary of the sequence");
        }
      }
      const passes = segments
        ? segments.map(function (segment) {
          return { start: BigInt(segment.sourceStartTicks), end: BigInt(segment.sourceEndTicks), shift: 0n, video: [segment.videoTrack], audio: [] };
        })
        : [{ start: BigInt(request.sourceStartTicks), end: BigInt(request.sourceEndTicks),
          shift: BigInt(request.destinationStartTicks) - BigInt(request.sourceStartTicks), video: request.videoTracks, audio: request.audioTracks }];
      const counts = { video: await trackCount(destination, "video"), audio: await trackCount(destination, "audio") };
      let newTrack = false;
      if (segments) {
        // The program track is an existing empty track, or the next index,
        // which a clone creates (live 27.0, probe P4). Never a busy one.
        if (request.programTrack > counts.video) {
          throw refuse("UXP_TARGET_UNSUPPORTED", "programTrack " + request.programTrack + " does not exist; use an empty track or " + counts.video + " to create the next one");
        }
        newTrack = request.programTrack === counts.video;
        if (!newTrack && (await clipItems(destination, "video", request.programTrack)).length) {
          throw refuse("UXP_TARGET_OCCUPIED", "The program track (video " + request.programTrack + ") is not empty; choose an empty track");
        }
      }
      const entries = [];
      for (const [passIndex, pass] of passes.entries()) {
      const rangeStart = pass.start, rangeEnd = pass.end, shift = pass.shift, firstEntry = entries.length;
      for (const mediaType of ["video", "audio"]) {
        const sourceCount = await trackCount(source, mediaType), destinationCount = counts[mediaType];
        const wanted = pass[mediaType];
        const offset = request[mediaType + "TrackOffset"];
        const tracks = wanted || range(sourceCount);
        for (const trackIndex of tracks) {
          if (trackIndex >= sourceCount) throw refuse("UXP_TARGET_NOT_FOUND", "Source " + mediaType + " track " + trackIndex + " does not exist");
          const items = await clipItems(source, mediaType, trackIndex);
          for (let clipIndex = 0; clipIndex < items.length; clipIndex++) {
            const item = items[clipIndex];
            const start = BigInt(await ticksOf(item, "getStartTime")), end = BigInt(await ticksOf(item, "getEndTime"));
            if (end <= rangeStart || start >= rangeEnd) continue;
            const targetTrackIndex = segments ? request.programTrack : trackIndex + offset;
            if (targetTrackIndex < 0 || targetTrackIndex >= destinationCount && !(segments && newTrack)) {
              throw refuse("UXP_TARGET_UNSUPPORTED", "Destination " + mediaType + " track " + targetTrackIndex + " does not exist; add a track and inspect again");
            }
            const name = String(await maybeCall(item, "getName") || "a clip");
            const inPoint = BigInt(await ticksOf(item, "getInPoint")), outPoint = BigInt(await ticksOf(item, "getOutPoint"));
            const head = start < rangeStart ? rangeStart - start : 0n, tail = end > rangeEnd ? end - rangeEnd : 0n;
            if (head > 0n || tail > 0n) {
              const speed = Number(await requiredMethod(item, "getSpeed")()), reversed = Boolean(await requiredMethod(item, "isSpeedReversed")());
              if (Math.abs(speed - 1) > 0.0001 || reversed) {
                throw refuse("UXP_TARGET_UNSUPPORTED", name + " crosses the edge of the range and has a speed change or is reversed; widen the range to take it whole");
              }
            }
            entries.push({
              item, sourceStart: start, sourceIn: inPoint, trimmed: head > 0n || tail > 0n,
              videoOffset: segments ? targetTrackIndex - trackIndex : request.videoTrackOffset,
              audioOffset: segments ? 0 : request.audioTrackOffset,
              placement: {
                mediaType, sourceTrackIndex: trackIndex, sourceClipIndex: clipIndex, targetTrackIndex, name,
                projectItemId: await projectItemId(item),
                startTicks: String(start + head + shift), endTicks: String(end - tail + shift),
                inTicks: String(inPoint + head), outTicks: String(outPoint - tail),
                trimHeadTicks: String(head), trimTailTicks: String(tail),
                disabled: Boolean(await maybeCall(item, "isDisabled"))
              }
            });
            if (entries.length > MAX_PLACEMENTS) throw refuse("UXP_TARGET_TOO_LARGE", "The range holds more than " + MAX_PLACEMENTS + " clips");
          }
        }
      }
      if (segments && entries.length === firstEntry) {
        throw refuse("UXP_TARGET_NOT_FOUND", "segments[" + passIndex + "] has no clip on video track " + segments[passIndex].videoTrack + " in its range");
      }
      }
      if (!entries.length) throw refuse("UXP_TARGET_NOT_FOUND", "No clips on the chosen source tracks fall inside the range");
      for (const entry of entries) {
        if (BigInt(entry.placement.startTicks) < 0n) throw refuse("UXP_INVALID_ARGUMENT", "The destination start would place " + entry.placement.name + " before the start of the sequence");
      }

      // Nothing at the destination may be overwritten, and the parking spot
      // sits past the last clip on every destination track the copy touches.
      const occupancy = {};
      let lastEnd = 0n;
      for (const entry of entries) {
        const placement = entry.placement, key = placement.mediaType + ":" + placement.targetTrackIndex;
        if (!occupancy[key]) {
          occupancy[key] = [];
          // A track the cut is about to create has nothing on it yet.
          const existing = placement.targetTrackIndex < counts[placement.mediaType] ? await clipItems(destination, placement.mediaType, placement.targetTrackIndex) : [];
          for (const item of existing) {
            occupancy[key].push({ start: BigInt(await ticksOf(item, "getStartTime")), end: BigInt(await ticksOf(item, "getEndTime")), name: String(await maybeCall(item, "getName") || "a clip") });
          }
        }
        for (const occupant of occupancy[key]) {
          if (occupant.end > lastEnd) lastEnd = occupant.end;
          if (occupant.start < BigInt(placement.endTicks) && occupant.end > BigInt(placement.startTicks)) {
            throw refuse("UXP_TARGET_OCCUPIED", "Destination " + placement.mediaType + " track " + placement.targetTrackIndex + " is occupied by " + occupant.name + " where " + placement.name + " would land");
          }
        }
        if (BigInt(placement.endTicks) > lastEnd) lastEnd = BigInt(placement.endTicks);
      }
      const gap = (PARKING_GAP + frame - 1n) / frame * frame;
      const parkingBase = (lastEnd + frame - 1n) / frame * frame + gap;
      let parking = parkingBase, round = 0, inRound = 0;
      for (const entry of entries) {
        if (!entry.trimmed) continue;
        const length = BigInt(entry.placement.endTicks) - BigInt(entry.placement.startTicks) + BigInt(entry.placement.trimHeadTicks) + BigInt(entry.placement.trimTailTicks);
        if (length + gap > PARKING_BUDGET) throw refuse("UXP_TARGET_TOO_LARGE", entry.placement.name + " is too long to park while it is trimmed; split the range so it crosses fewer long clips");
        if (parking - parkingBase + length > PARKING_BUDGET || inRound >= MAX_PARKED_PER_ROUND) { round++; parking = parkingBase; inRound = 0; }
        inRound++;
        entry.round = round;
        entry.parkedStart = parking;
        entry.parkedEnd = parking + length;
        parking = (entry.parkedEnd + frame - 1n) / frame * frame + gap;
      }

      return {
        entries, frame, newTrack, sampleTicks: await sampleTicksOf(destination),
        rounds: round + 1,
        snapshot: {
          projectGuid: requiredIdentifier(project.guid, "project GUID"),
          sourceSequenceId: request.sourceSequenceId,
          sourceSequenceName: String(await maybeCall(source, "getName") || source.name || ""),
          destinationSequenceId: request.destinationSequenceId,
          destinationSequenceName: String(await maybeCall(destination, "getName") || destination.name || ""),
          sourceStartTicks: request.sourceStartTicks,
          sourceEndTicks: request.sourceEndTicks,
          destinationStartTicks: request.destinationStartTicks,
          clips: entries.map(function (entry) { return entry.placement; })
        }
      };
    }

    async function timebase(sequence) {
      const text = String(await requiredMethod(sequence, "getTimebase")());
      if (!/^\d{1,20}$/.test(text) || BigInt(text) <= 0n) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid sequence timebase");
      return BigInt(text);
    }

    // Half a frame for video, one audio sample for audio.
    function tolerance(mediaType, plan) { return mediaType === "audio" ? plan.sampleTicks : plan.frame / 2n; }
    async function sampleTicksOf(sequence) {
      let rate = Number(await maybeCall(sequence, "getAudioSampleRate"));
      if (!(rate > 0)) {
        const settings = await maybeCall(sequence, "getSettings");
        rate = Number(settings ? await maybeCall(settings, "getAudioSampleRate") : NaN);
      }
      return rate >= 8000 && rate <= 192000 ? TICKS_PER_SECOND / BigInt(Math.round(rate)) : FALLBACK_SAMPLE_TICKS;
    }
    function distance(left, right) { const d = BigInt(left) - BigInt(right); return d < 0n ? -d : d; }

    // Premiere kills host objects around a commit; a read is simply done again on fresh objects.
    function pause(attempt) { return new Promise(function (resolve) { setTimeout(resolve, 25 * attempt); }); }
    async function retryStale(step) {
      for (let attempt = 1; ; attempt++) {
        try { return await step(); } catch (error) {
          if (attempt >= STALE_ATTEMPTS || !STALE_OBJECT.test(error && error.message ? error.message : "")) throw error;
          await pause(attempt);
        }
      }
    }

    // Where the clone sits now: { mediaType, trackIndex, index, start } (start in ticks as a string).
    function findClone(sequence, entry, startTicks, plan) { return retryStale(function () { return findCloneOnce(sequence, entry, startTicks, plan); }); }
    async function findCloneOnce(sequence, entry, startTicks, plan) {
      const placement = entry.placement, tol = tolerance(placement.mediaType, plan);
      let best = null, bestDistance = tol + 1n;
      const items = await clipItems(sequence, placement.mediaType, placement.targetTrackIndex);
      for (let index = 0; index < items.length; index++) {
        const start = await ticksOf(items[index], "getStartTime"), away = distance(start, startTicks);
        if (away <= tol && away < bestDistance && await projectItemId(items[index]) === placement.projectItemId) { best = { mediaType: placement.mediaType, trackIndex: placement.targetTrackIndex, index, start }; bestDistance = away; }
      }
      if (best) return best;
      const seen = [];
      for (const item of items) seen.push(await ticksOf(item, "getStartTime"));
      throw commandError("UXP_VERIFICATION_FAILED", placement.name + " is not at its parking position " + startTicks + " on " + placement.mediaType + " track " + placement.targetTrackIndex + " (clip starts there: " + seen.slice(0, 8).join(", ") + ")");
    }

    // The items at those positions, fetched again (one track call each) right before they are used.
    function fetchAt(sequence, positions) { return retryStale(function () { return fetchAtOnce(sequence, positions); }); }
    async function fetchAtOnce(sequence, positions) {
      const tracks = new Map(), items = [];
      for (const at of positions) {
        const key = at.mediaType + ":" + at.trackIndex;
        if (!tracks.has(key)) tracks.set(key, await clipItems(sequence, at.mediaType, at.trackIndex));
        const item = tracks.get(key)[at.index];
        if (!item || await ticksOf(item, "getStartTime") !== at.start) throw commandError("UXP_VERIFICATION_FAILED", at.mediaType + " track " + at.trackIndex + " clip " + at.index + " is no longer where it was found");
        items.push(item);
      }
      return items;
    }

    // A source clip, read again from its track (it may be in the sequence the copy is writing to).
    async function freshSource(context, entry) {
      const placement = entry.placement, items = await clipItems(context.source, placement.mediaType, placement.sourceTrackIndex);
      const wanted = String(entry.sourceStart), matches = async function (item) { return await ticksOf(item, "getStartTime") === wanted && await projectItemId(item) === placement.projectItemId; };
      const direct = items[placement.sourceClipIndex];
      if (direct && await matches(direct)) return direct;
      for (const item of items) if (await matches(item)) return item;
      throw refuse("UXP_STALE_TRACK_ITEM", placement.name + " is no longer in the source sequence where the copy was planned");
    }

    // Compares every start, end, source in and source out within the media
    // type's tolerance, and reports the largest deviation seen in ticks, so a
    // sample-grid or 1-tick landing verifies and a real miss does not.
    function readbackProblems(sequence, plan) { return retryStale(function () { return readbackProblemsOnce(sequence, plan); }); }
    async function readbackProblemsOnce(sequence, plan) {
      const problems = [];
      const claimed = new Set();
      const cache = {};
      let maxDeviation = 0n;
      async function track(mediaType, index) {
        const key = mediaType + ":" + index;
        if (!cache[key]) {
          cache[key] = [];
          for (const item of await clipItems(sequence, mediaType, index)) {
            cache[key].push({ start: await ticksOf(item, "getStartTime"), end: await ticksOf(item, "getEndTime"),
              inTicks: await ticksOf(item, "getInPoint"), outTicks: await ticksOf(item, "getOutPoint"),
              projectItemId: await projectItemId(item), disabled: Boolean(await maybeCall(item, "isDisabled")) });
          }
        }
        return cache[key];
      }
      for (const entry of plan.entries) {
        const want = entry.placement, tol = tolerance(want.mediaType, plan);
        const items = await track(want.mediaType, want.targetTrackIndex);
        let found = -1, foundDistance = tol + 1n;
        for (let index = 0; index < items.length; index++) {
          const key = want.mediaType + ":" + want.targetTrackIndex + ":" + index;
          if (claimed.has(key) || items[index].projectItemId !== want.projectItemId) continue;
          const away = distance(items[index].start, want.startTicks);
          if (away <= tol && away < foundDistance) { found = index; foundDistance = away; }
        }
        if (found === -1) { problems.push(want.name + " is not at its planned start on " + want.mediaType + " track " + want.targetTrackIndex); continue; }
        claimed.add(want.mediaType + ":" + want.targetTrackIndex + ":" + found);
        const got = items[found];
        const misses = [distance(got.start, want.startTicks), distance(got.end, want.endTicks), distance(got.inTicks, want.inTicks), distance(got.outTicks, want.outTicks)];
        for (const miss of misses) if (miss > maxDeviation) maxDeviation = miss;
        if (misses.some(function (miss) { return miss > tol; })) problems.push(want.name + " on " + want.mediaType + " track " + want.targetTrackIndex + " does not have its planned source range");
        if (got.disabled !== want.disabled) problems.push(want.name + " on " + want.mediaType + " track " + want.targetTrackIndex + " changed enabled state");
        if (entry.trimmed && items.some(function (item) { return BigInt(item.start) >= entry.parkedStart && item.projectItemId === want.projectItemId; })) {
          problems.push(want.name + " was left at its parking position on " + want.mediaType + " track " + want.targetTrackIndex);
        }
      }
      return { problems, maxDeviationTicks: String(maxDeviation) };
    }

    async function trackCount(sequence, mediaType) {
      const method = mediaType === "video" ? "getVideoTrackCount" : "getAudioTrackCount";
      const count = Number(await requiredMethod(sequence, method)());
      if (!Number.isSafeInteger(count) || count < 0 || count > 512) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid " + mediaType + " track count");
      return count;
    }

    async function clipItems(sequence, mediaType, trackIndex) {
      const method = mediaType === "video" ? "getVideoTrack" : "getAudioTrack";
      const track = await requiredMethod(sequence, method)(trackIndex);
      if (!track || typeof track.getTrackItems !== "function") throw commandError("UXP_TARGET_NOT_FOUND", mediaType + " track " + trackIndex + " is unavailable");
      const items = await TrackItems.sortByStart(await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
      if (items.length > MAX_PLACEMENTS) throw commandError("UXP_TARGET_TOO_LARGE", "A track has more than " + MAX_PLACEMENTS + " clip items");
      return items;
    }

    async function ticksOf(item, method) {
      const time = await requiredMethod(item, method)();
      const ticks = time && time.ticks != null ? String(time.ticks) : "";
      if (!/^-?\d{1,30}$/.test(ticks)) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an unreadable " + method + " tick value");
      return ticks;
    }

    async function projectItemId(item) {
      const projectItem = await requiredMethod(item, "getProjectItem")();
      return requiredIdentifier(projectItem && typeof projectItem.getId === "function" ? await projectItem.getId() : null, "project-item ID");
    }

    async function maybeCall(target, name) {
      if (!target || typeof target[name] !== "function") return undefined;
      try { return await target[name](); } catch (_) { return undefined; }
    }

    // Exactly one of <key>Ticks / <key>Seconds, validated; written onto `into`.
    function readTime(source, key, label, into) {
      const ticks = source[key + "Ticks"], seconds = source[key + "Seconds"];
      if ((ticks == null) === (seconds == null)) throw refuse("UXP_INVALID_ARGUMENT", "Give exactly one of " + label + key + "Ticks or " + label + key + "Seconds");
      if (ticks != null && (typeof ticks !== "string" || !/^\d{1,30}$/.test(ticks))) throw refuse("UXP_INVALID_ARGUMENT", label + key + "Ticks must be a non-negative tick string");
      if (seconds != null && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400)) throw refuse("UXP_INVALID_ARGUMENT", label + key + "Seconds must be a number from 0 to 86400");
      into[key + "Ticks"] = ticks == null ? null : ticks;
      into[key + "Seconds"] = seconds == null ? null : seconds;
    }

    function copyRequest(args) {
      const request = {};
      for (const key of ["sourceSequenceId", "destinationSequenceId"]) {
        if (typeof args[key] !== "string" || !args[key] || args[key].length > 512) throw refuse("UXP_INVALID_ARGUMENT", key + " is required");
        request[key] = args[key];
      }
      if (args.segments != null || args.programTrack != null) return segmentRequest(args, request);
      for (const key of TIME_KEYS) readTime(args, key, "", request);
      for (const mediaType of ["video", "audio"]) {
        const tracks = args[mediaType + "Tracks"];
        if (tracks != null) {
          if (!Array.isArray(tracks) || tracks.length > 64 || tracks.some(function (value) { return !Number.isSafeInteger(value) || value < 0 || value > 511; }) ||
            new Set(tracks).size !== tracks.length) {
            throw refuse("UXP_INVALID_ARGUMENT", mediaType + "Tracks must be a list of distinct track indexes from 0 to 511");
          }
        }
        request[mediaType + "Tracks"] = tracks == null ? null : tracks.slice();
        const offset = args[mediaType + "TrackOffset"] == null ? 0 : args[mediaType + "TrackOffset"];
        if (!Number.isSafeInteger(offset) || offset < -511 || offset > 511) throw refuse("UXP_INVALID_ARGUMENT", mediaType + "TrackOffset must be an integer from -511 to 511");
        request[mediaType + "TrackOffset"] = offset;
      }
      if (request.videoTracks && request.audioTracks && !request.videoTracks.length && !request.audioTracks.length) {
        throw refuse("UXP_INVALID_ARGUMENT", "Choose at least one video or audio track");
      }
      return request;
    }

    // Camera-cut mode: copy ranges of chosen video tracks onto one program
    // track of the same sequence, at the same times.
    function segmentRequest(args, request) {
      for (const key of SEGMENT_EXCLUDED) {
        if (args[key] != null) throw refuse("UXP_INVALID_ARGUMENT", "segments cannot be combined with " + key);
      }
      if (request.sourceSequenceId !== request.destinationSequenceId) throw refuse("UXP_INVALID_ARGUMENT", "A camera cut stays inside one sequence; sourceSequenceId and destinationSequenceId must match");
      if (!Number.isSafeInteger(args.programTrack) || args.programTrack < 0 || args.programTrack > 511) throw refuse("UXP_INVALID_ARGUMENT", "programTrack must be an integer from 0 to 511");
      if (!Array.isArray(args.segments) || !args.segments.length || args.segments.length > MAX_SEGMENTS) throw refuse("UXP_INVALID_ARGUMENT", "segments must hold 1-" + MAX_SEGMENTS + " ranges");
      request.programTrack = args.programTrack;
      request.videoTrackOffset = 0;
      request.audioTrackOffset = 0;
      request.videoTracks = null;
      request.audioTracks = null;
      request.segments = args.segments.map(function (raw, position) {
        assertObject(raw, "segments[" + position + "]");
        assertOnlyKeys(raw, SEGMENT_KEYS);
        if (!Number.isSafeInteger(raw.videoTrack) || raw.videoTrack < 0 || raw.videoTrack > 511) throw refuse("UXP_INVALID_ARGUMENT", "segments[" + position + "].videoTrack must be an integer from 0 to 511");
        if (raw.videoTrack === args.programTrack) throw refuse("UXP_INVALID_ARGUMENT", "segments[" + position + "].videoTrack is the program track itself");
        const segment = { videoTrack: raw.videoTrack };
        readTime(raw, "sourceStart", "segments[" + position + "].", segment);
        readTime(raw, "sourceEnd", "segments[" + position + "].", segment);
        return segment;
      });
      return request;
    }

    function range(count) { const out = []; for (let index = 0; index < count; index++) out.push(index); return out; }

    function canonical(value) {
      if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
      if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ":" + canonical(value[key]); }).join(",") + "}";
      return JSON.stringify(value);
    }

    function identifier(value) { try { return value == null ? "" : String(typeof value.toString === "function" ? value.toString() : value); } catch (_) { return ""; } }
    function requiredMethod(target, name) { if (!target || typeof target[name] !== "function") throw commandError("UXP_COMMAND_UNAVAILABLE", "The required item does not expose " + name); return target[name].bind(target); }
    function assertObject(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse("UXP_INVALID_ARGUMENT", name + " must be an object"); }
    function assertOnlyKeys(value, allowed) { assertObject(value, "arguments"); for (const key of Object.keys(value)) if (allowed.indexOf(key) === -1) throw refuse("UXP_INVALID_ARGUMENT", "Unexpected argument: " + key); }
    function requiredIdentifier(value, name) { const id = identifier(value); if (!id || id.length > 512 || id.indexOf("\u0000") !== -1) throw commandError("UXP_VERIFICATION_FAILED", name + " is unavailable or invalid"); return id; }
    function commandError(code, message) { const error = new Error(message); error.code = code; return error; }
    // A refusal thrown before any host write; the dispatcher keeps the flag.
    function refuse(code, message) { const error = commandError(code, message); error.noHostWrite = true; return error; }

    return definitions;
  }

  return { createCopyClipsWorkflowDefinitions };
});
