/**
 * Main.gs — entry points. Run these from the Apps Script editor's function
 * picker, or from a trigger.
 *
 *   previewSync()      Parse everything, write nothing, log what would happen.
 *   syncCalendar()     The real run. This is what the trigger calls.
 *   installTrigger()   Schedule syncCalendar() every 15 minutes.
 *   removeTriggers()   Unschedule it.
 *   testRule()         Show what one rule matches and what it parsed.
 *   testParseText()    Parse a block of text you paste in, with no email involved.
 */

/** Schedule the sync. Safe to re-run; it replaces any existing schedule. */
function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('syncCalendar').timeBased().everyMinutes(15).create();
  Logger.log('Trigger installed: syncCalendar every 15 minutes.');
}

function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncCalendar') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' trigger(s).');
}

/** The real run. */
function syncCalendar() {
  return csRun(false);
}

/** A rehearsal: identical parsing, no writes, full log. */
function previewSync() {
  return csRun(true);
}

/**
 * @param {boolean} forceDryRun Overrides CONFIG.DRY_RUN for this execution only.
 */
function csRun(forceDryRun) {
  var problems = csValidateRules(RULES);
  if (problems.length) throw new Error('Config problems:\n  ' + problems.join('\n  '));

  // Runs overlap when one is slow and the trigger fires again; two runs writing
  // the same events would race on the create-vs-update check.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Another run is in progress; skipping this one.');
    return null;
  }

  var originalDryRun = CONFIG.DRY_RUN;
  if (forceDryRun) CONFIG.DRY_RUN = true;

  try {
    return csExecute();
  } finally {
    CONFIG.DRY_RUN = originalDryRun;
    lock.releaseLock();
  }
}

function csExecute() {
  var summary = {
    dryRun: CONFIG.DRY_RUN,
    created: [],
    updated: [],
    unchanged: 0,
    removed: [],
    unparsed: [],
    errors: [],
  };

  // Phase 1: read all the mail and work out every event, touching no calendar.
  // Phase 2 then needs a single index read per calendar rather than one per event.
  var plans = [];
  var ranges = {};

  for (var r = 0; r < RULES.length; r++) {
    var rule = csResolveRule(RULES[r]);
    if (!rule.enabled) continue;

    try {
      var contexts = csFetchMessages(rule);
      for (var c = 0; c < contexts.length; c++) {
        var context = contexts[c];
        var events = csBuildEvents(rule, context);

        if (!events.length) {
          summary.unparsed.push(rule.id + ': ' + context.subject);
          csLabelThread(context.thread, CONFIG.UNPARSED_LABEL);
          continue;
        }

        plans.push({ rule: rule, context: context, events: events });
      }
    } catch (err) {
      summary.errors.push(rule.id + ': ' + err.message);
    }
  }

  // A corrected roster and the original it replaces are both in the lookback
  // window, so both parse on every run. Resolve that before anything is written.
  plans = csDropSupersededPlans(plans);

  for (var q = 0; q < plans.length; q++) {
    var planCalendarId = plans[q].rule.calendarId;
    if (!ranges[planCalendarId]) ranges[planCalendarId] = { from: null, to: null };
    for (var ev = 0; ev < plans[q].events.length; ev++) {
      csExtendRange(ranges[planCalendarId], plans[q].events[ev]);
    }
  }

  // Phase 2: one index read per calendar, then all the writes.
  var calendars = {};
  var indexes = {};
  for (var calendarId in ranges) {
    if (!Object.prototype.hasOwnProperty.call(ranges, calendarId)) continue;
    calendars[calendarId] = csCalendarFor(calendarId);
    indexes[calendarId] = csLoadIndex(calendars[calendarId], ranges[calendarId].from, ranges[calendarId].to);
  }

  // Tracked per rule so replaceWindow knows which shifts are still current and
  // over which days it is allowed to delete.
  var live = {};

  for (var p = 0; p < plans.length; p++) {
    var plan = plans[p];
    var calendar = calendars[plan.rule.calendarId];
    var index = indexes[plan.rule.calendarId];
    var produced = false;

    for (var i = 0; i < plan.events.length; i++) {
      var event = plan.events[i];
      try {
        var outcome = csUpsertEvent(calendar, index, plan.rule, event);
        if (outcome === 'created') summary.created.push(csDescribeEvent(event));
        else if (outcome === 'updated') summary.updated.push(csDescribeEvent(event));
        else summary.unchanged++;
        produced = true;

        if (plan.rule.replaceWindow) {
          if (!live[plan.rule.id]) live[plan.rule.id] = { rule: plan.rule, keys: {}, range: { from: null, to: null } };
          live[plan.rule.id].keys[event.key] = true;
          csExtendRange(live[plan.rule.id].range, event);

          // Also cover the days of any roster this email superseded, so a shift
          // the amendment dropped is still inside the range cleanup examines.
          if (plan.cleanupWindow) {
            csExtendRange(live[plan.rule.id].range, {
              start: csDayIndexToDate(plan.cleanupWindow.from),
              end: csDayIndexToDate(plan.cleanupWindow.to),
            });
          }
        }
      } catch (err) {
        summary.errors.push(plan.rule.id + ' / ' + event.title + ': ' + err.message);
      }
    }

    if (produced) csLabelThread(plan.context.thread, CONFIG.PROCESSED_LABEL);
  }

  for (var ruleId in live) {
    if (!Object.prototype.hasOwnProperty.call(live, ruleId)) continue;
    var entry = live[ruleId];
    try {
      var removed = csRemoveDropped(calendars[entry.rule.calendarId], entry.rule, entry.range, entry.keys);
      summary.removed = summary.removed.concat(removed);
    } catch (err) {
      summary.errors.push(ruleId + ' (cleanup): ' + err.message);
    }
  }

  var report = csFormatSummary(summary);
  Logger.log(report);

  var changed = summary.created.length || summary.updated.length || summary.removed.length || summary.errors.length;
  if (changed || CONFIG.DIGEST_WHEN_EMPTY) {
    csSendDigest('Calendar sync: ' + summary.created.length + ' added, ' + summary.updated.length + ' updated', report);
  }
  return summary;
}

function csDescribeEvent(event) {
  var when = event.allDay
    ? csIsoLocal(event.start).slice(0, 10) + ' (all day)'
    : csIsoLocal(event.start) + ' - ' + (event.end ? csIsoLocal(event.end).slice(11) : '?');
  return event.title + '  [' + when + ']';
}

function csFormatSummary(summary) {
  var lines = [];
  lines.push(summary.dryRun ? '=== DRY RUN — nothing was written ===' : '=== Calendar sync ===');
  lines.push('Created: ' + summary.created.length);
  for (var a = 0; a < summary.created.length; a++) lines.push('  + ' + summary.created[a]);
  lines.push('Updated: ' + summary.updated.length);
  for (var b = 0; b < summary.updated.length; b++) lines.push('  ~ ' + summary.updated[b]);
  lines.push('Removed: ' + summary.removed.length);
  for (var c = 0; c < summary.removed.length; c++) lines.push('  - ' + summary.removed[c]);
  lines.push('Unchanged: ' + summary.unchanged);
  if (summary.unparsed.length) {
    lines.push('Matched but no date found: ' + summary.unparsed.length);
    for (var d = 0; d < summary.unparsed.length; d++) lines.push('  ? ' + summary.unparsed[d]);
  }
  if (summary.errors.length) {
    lines.push('Errors: ' + summary.errors.length);
    for (var e = 0; e < summary.errors.length; e++) lines.push('  ! ' + summary.errors[e]);
  }
  return lines.join('\n');
}

/**
 * Diagnostic: what does one rule actually match, and what does it read out of
 * each email? Edit RULE_TO_TEST, run this, and read the log. Nothing is written.
 *
 * This is the tool for onboarding a new sender — especially a work roster,
 * where the first question is always whether the shift rows parse.
 */
var RULE_TO_TEST = 'work-schedule';

function testRule() {
  var found = null;
  for (var i = 0; i < RULES.length; i++) {
    if (RULES[i].id === RULE_TO_TEST) found = csResolveRule(RULES[i]);
  }
  if (!found) throw new Error('No rule with id "' + RULE_TO_TEST + '". Check RULE_TO_TEST.');

  var lines = ['Rule: ' + found.id, 'Query: ' + csRuleQuery(found), ''];
  var contexts = csFetchMessages(found);
  lines.push('Matched ' + contexts.length + ' message(s).');

  for (var c = 0; c < contexts.length; c++) {
    var context = contexts[c];
    lines.push('');
    lines.push('--- ' + context.date + ' | ' + context.from);
    lines.push('    ' + context.subject);
    var events = csBuildEvents(found, context);
    if (!events.length) {
      lines.push('    NO EVENTS PARSED. First 15 lines of the body:');
      var body = csToLines(context.body).slice(0, 15);
      for (var b = 0; b < body.length; b++) lines.push('      | ' + body[b]);
    }
    for (var e = 0; e < events.length; e++) {
      lines.push('    -> ' + csDescribeEvent(events[e]));
      lines.push('       from line: ' + events[e].sourceLine);
    }
  }

  Logger.log(lines.join('\n'));
}

/**
 * Diagnostic: paste a roster (or any text) between the backticks and run this
 * to see exactly which rows become events. No Gmail, no calendar — the fastest
 * loop for tuning a new schedule format.
 */
var TEXT_TO_TEST = [
  'Week of Sept 14',
  'Mon 14 Sep: 9:00-17:00 Front desk',
  'Tue 15 Sep: OFF',
  'Wed 16 Sep 22:00-06:00 Overnight',
].join('\n');

function testParseText() {
  var now = new Date();
  var lines = ['Parsing as of ' + now + ' with DATE_ORDER=' + CONFIG.DATE_ORDER, ''];

  var shifts = csExtractShifts(TEXT_TO_TEST, now, {
    dateOrder: CONFIG.DATE_ORDER,
    defaultDurationMinutes: CONFIG.DEFAULT_DURATION_MINUTES,
  });
  lines.push('As a roster (mode: shifts) — ' + shifts.length + ' event(s):');
  for (var i = 0; i < shifts.length; i++) {
    lines.push('  ' + shifts[i].start + '  ->  ' + shifts[i].end + '   "' + shifts[i].label + '"');
    lines.push('    from line: ' + shifts[i].sourceLine);
  }

  var single = csExtractSingle('', TEXT_TO_TEST, now, {
    dateOrder: CONFIG.DATE_ORDER,
    defaultDurationMinutes: CONFIG.DEFAULT_DURATION_MINUTES,
  });
  lines.push('');
  lines.push('As one event (mode: single): ' + (single ? single.start + ' -> ' + single.end : 'nothing found'));

  Logger.log(lines.join('\n'));
}
