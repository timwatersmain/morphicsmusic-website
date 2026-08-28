/**
 * Extract.gs — turning an email body into a list of events.
 *
 * Two shapes are handled, chosen per rule:
 *   'single' — one commitment per email (a booking, a call, a deadline).
 *   'shifts' — a roster listing many dated rows in one email.
 *
 * Pure functions over strings, as in Parse.gs, so the tests exercise this file
 * directly. Body text arrives already stripped of HTML by Gmail.gs.
 */

/** Rows a roster mail carries that are never shifts. */
var CS_SHIFT_NOISE_RE = /\b(?:unsubscribe|view (?:this|in) browser|copyright|all rights reserved|sent (?:to|from)|do not reply|privacy policy)\b/i;

/** Explicit markers that a listed day is not worked. */
var CS_OFF_SHIFT_RE = /\b(?:off|rest day|not scheduled|no shift|unavailable|holiday|vacation|pto|leave)\b/i;

/** Weekday words, stripped out of shift labels. */
var CS_WEEKDAY_RE = /\b(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday)?\b/gi;

/** Punctuation left stranded once a date and its times are removed from a line. */
var CS_LABEL_PUNCT_RE = /[-–—:;,|]+/g;

/**
 * Split a body into candidate lines, one per row.
 *
 * Only newlines separate rows. Roster emails converted from HTML tables arrive
 * with the cells of a row joined by pipes or tabs — "Mon 14 Sep | 9:00-17:00 |
 * Front desk" is a single shift, and splitting on those separators would strand
 * the date on one line and the times on another, losing the row entirely. They
 * are flattened to spaces so the row stays whole.
 */
function csToLines(body) {
  return String(body == null ? '' : body)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(function (line) { return csNormalize(line.replace(/[\t|]+/g, ' ')); })
    .filter(function (line) { return line.length > 0; });
}

/**
 * Everything on a line that is not the date or the times — the shift label
 * ("Bar", "Close", "Studio B"). Punctuation left behind by the removal is
 * trimmed off the ends.
 */
function csLineRemainder(line, parsed) {
  var spans = [parsed.date.span];
  if (parsed.time) spans = spans.concat(parsed.time.spans);
  return csMaskSpans(line, spans)
    .replace(CS_WEEKDAY_RE, ' ')
    .replace(CS_LABEL_PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every dated row in a roster.
 *
 * A row counts as a shift only if it carries both a date and a time. A date
 * with no time in a roster is far more often a header or a "week commencing"
 * line than a real all-day shift, and turning those into events is the fastest
 * way to make the calendar untrustworthy.
 */
function csExtractShifts(body, refDate, options) {
  var opts = options || {};
  var lines = csToLines(body);
  var found = [];
  var seen = {};

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (CS_SHIFT_NOISE_RE.test(line)) continue;
    if (CS_OFF_SHIFT_RE.test(line)) continue;

    var parsed = csParseLine(line, refDate, opts.dateOrder);
    if (!parsed || !parsed.time) continue;

    var interval = csToInterval(parsed, opts.defaultDurationMinutes);
    if (!interval) continue;

    // The same shift listed twice (a summary block plus a detail block) should
    // produce one event, so identical intervals collapse.
    var key = interval.start.getTime() + '|' + (interval.end ? interval.end.getTime() : '');
    if (seen[key]) continue;
    seen[key] = true;

    found.push({
      start: interval.start,
      end: interval.end,
      allDay: false,
      label: csLineRemainder(line, parsed),
      sourceLine: line,
    });
  }

  found.sort(function (a, b) { return a.start.getTime() - b.start.getTime(); });
  return found;
}

/**
 * The single commitment an email describes.
 *
 * The subject is checked first — "Confirmed: studio Sept 14, 7pm" is more
 * reliable than whatever the body's first dated line happens to be — and then
 * body lines in order. A dated line that also has a time beats a bare date, so
 * a signature block mentioning a month does not outrank the real appointment.
 */
function csExtractSingle(subject, body, refDate, options) {
  var opts = options || {};
  var candidates = [subject].concat(csToLines(body));
  var bareDate = null;

  for (var i = 0; i < candidates.length; i++) {
    var line = candidates[i];
    if (!line || CS_SHIFT_NOISE_RE.test(line)) continue;

    var parsed = csParseLine(line, refDate, opts.dateOrder);
    if (!parsed) continue;

    var interval = csToInterval(parsed, opts.defaultDurationMinutes);
    if (!interval) continue;

    if (parsed.time) {
      return {
        start: interval.start,
        end: interval.end,
        allDay: false,
        label: csLineRemainder(line, parsed),
        sourceLine: line,
      };
    }
    if (!bareDate && opts.allDayIfNoTime !== false) {
      bareDate = {
        start: interval.start,
        end: null,
        allDay: true,
        label: csLineRemainder(line, parsed),
        sourceLine: line,
      };
    }
  }

  return bareDate;
}

/**
 * Fill {placeholders} in a rule's title template. Unknown placeholders are
 * dropped rather than left as literal braces in a calendar entry.
 */
function csRenderTemplate(template, values) {
  return String(template == null ? '' : template)
    .replace(/\{(\w+)\}/g, function (whole, key) {
      var value = values[key];
      return value == null || value === '' ? '' : String(value);
    })
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—:]\s*$/, '')
    .trim();
}

/** Local-time ISO stamp — no UTC shift, so keys read as the user's own clock. */
function csIsoLocal(date) {
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/**
 * A stable identifier for an event, used to decide create-vs-update and to
 * spot shifts a later roster dropped.
 *
 * Shift rules key on the start time alone: a re-sent roster arrives as a new
 * message, and keying on the message would duplicate every shift in it.
 * Single-event rules key on the thread, so a "moved to Thursday" reply updates
 * the event in place instead of adding a second one.
 */
function csEventKey(rule, context, event) {
  if (rule.mode === 'shifts') {
    return rule.id + '|' + csIsoLocal(event.start);
  }
  return rule.id + '|' + context.threadId;
}

/**
 * Fingerprint of the details that matter, so an unchanged event is left alone
 * and a changed one is updated. djb2 — this guards against pointless writes,
 * not against tampering.
 */
function csContentHash(event) {
  var input = [
    event.title,
    csIsoLocal(event.start),
    event.end ? csIsoLocal(event.end) : '',
    event.allDay ? 'allday' : 'timed',
    event.location || '',
  ].join(' ');
  var hash = 5381;
  for (var i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** A whole-day number, for comparing which days two emails cover. */
function csDayIndex(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}

/** Inverse of csDayIndex: midnight local time on that day. */
function csDayIndexToDate(dayIndex) {
  var utc = new Date(dayIndex * 86400000);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

/** The span of days a message's shifts fall on, by start day. */
function csPlanWindow(events) {
  var from = null;
  var to = null;
  for (var i = 0; i < events.length; i++) {
    var day = csDayIndex(events[i].start);
    if (from === null || day < from) from = day;
    if (to === null || day > to) to = day;
  }
  return from === null ? null : { from: from, to: to };
}

/**
 * Drop shifts from an email that a newer email has already spoken for.
 *
 * A corrected roster is sent as a second email, and both sit in the lookback
 * window, so both get parsed on every run. Without this the older one keeps
 * re-creating the shifts the correction removed, and the cleanup pass sees them
 * as current — the calendar would never let go of a cancelled shift.
 *
 * When two messages from the same rule cover overlapping days, the newer one
 * supersedes the older completely, not merely the days they share. That is what
 * makes a dropped shift disappear: an amended week listing Monday and Wednesday
 * has nothing to say about Friday except by being the newer word on that week.
 * It is also why this applies only to replaceWindow rules, where each email is
 * declared to be the whole truth for the period it covers.
 *
 * Each surviving plan comes back with a `cleanupWindow` spanning its own days
 * plus those of every email it superseded. Without that reach, an amendment
 * covering Monday to Wednesday could never clear the Friday shift it dropped:
 * cleanup would only look at the days the new roster still mentions.
 *
 * @param {Array} plans Each { rule, context, events }, any order.
 * @return {Array} The surviving plans, in their original order.
 */
function csDropSupersededPlans(plans) {
  var newestFirst = plans.slice().sort(function (a, b) {
    return b.context.date.getTime() - a.context.date.getTime();
  });

  var claimed = {};
  var survivors = [];

  for (var i = 0; i < newestFirst.length; i++) {
    var plan = newestFirst[i];
    if (!plan.rule.replaceWindow) {
      survivors.push(plan);
      continue;
    }

    var window = csPlanWindow(plan.events);
    if (!window) continue;

    var ranges = claimed[plan.rule.id] || (claimed[plan.rule.id] = []);
    var superseded = null;
    for (var r = 0; r < ranges.length; r++) {
      if (window.from <= ranges[r].to && window.to >= ranges[r].from) {
        superseded = ranges[r];
        break;
      }
    }

    if (superseded) {
      // The newer email now answers for these days too, so its cleanup has to
      // reach them — that is where the dropped shift still sits.
      superseded.from = Math.min(superseded.from, window.from);
      superseded.to = Math.max(superseded.to, window.to);
      continue;
    }

    plan.cleanupWindow = { from: window.from, to: window.to };
    ranges.push(plan.cleanupWindow);
    survivors.push(plan);
  }

  var order = {};
  for (var p = 0; p < plans.length; p++) order[plans[p].context.messageId] = p;
  survivors.sort(function (a, b) {
    return order[a.context.messageId] - order[b.context.messageId];
  });
  return survivors;
}

/** Provenance in the event body, so a surprising entry can be traced back. */
function csEventDescription(rule, context, item) {
  var lines = [];
  if (context.subject) lines.push('From email: ' + context.subject);
  if (context.from) lines.push('Sender: ' + context.from);
  if (item.sourceLine) lines.push('Parsed from: ' + item.sourceLine);
  lines.push('Added by calendar-sync (rule: ' + rule.id + ')');
  if (context.permalink) lines.push(context.permalink);
  return lines.join('\n');
}

/**
 * Apply a rule to one message, producing calendar-ready events.
 * context: { subject, body, from, fromName, threadId, messageId, date, permalink }
 */
function csBuildEvents(rule, context) {
  var options = {
    dateOrder: rule.dateOrder,
    defaultDurationMinutes: rule.durationMinutes,
    allDayIfNoTime: rule.allDayIfNoTime,
  };

  var raw;
  if (rule.mode === 'shifts') {
    raw = csExtractShifts(context.body, context.date, options);
  } else {
    var single = csExtractSingle(context.subject, context.body, context.date, options);
    raw = single ? [single] : [];
  }

  var events = [];
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i];
    var title = csRenderTemplate(rule.titleTemplate, {
      subject: context.subject,
      from: context.fromName || context.from,
      label: item.label,
      shift: item.label,
    });
    if (!title) title = context.subject || rule.id;

    var event = {
      key: csEventKey(rule, context, item),
      ruleId: rule.id,
      title: title,
      start: item.start,
      end: item.end,
      allDay: item.allDay,
      location: rule.location || '',
      sourceLine: item.sourceLine,
    };
    event.description = csEventDescription(rule, context, item);
    event.hash = csContentHash(event);
    events.push(event);
  }
  return events;
}
