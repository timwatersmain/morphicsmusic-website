/**
 * Calendar.gs — writing events, without ever writing the same one twice.
 *
 * Every event the automation creates carries three tags:
 *   csKey   the stable identity from csEventKey() — one event per key.
 *   csHash  a fingerprint of the details, so an unchanged event is skipped.
 *   csRule  the rule that made it, which is what replaceWindow deletes by.
 *
 * Tags are read back from the calendar itself, so state survives a lost script
 * property, a re-import, or a run from a fresh copy of the project.
 */

var CS_TAG_KEY = 'csKey';
var CS_TAG_HASH = 'csHash';
var CS_TAG_RULE = 'csRule';

function csCalendarFor(calendarId) {
  if (!calendarId || calendarId === 'primary') return CalendarApp.getDefaultCalendar();
  var calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) throw new Error('No calendar found for id: ' + calendarId + ' (check CONFIG.CALENDAR_ID)');
  return calendar;
}

/**
 * Index the automation's own events in a window, by key.
 *
 * Loaded once per run rather than per event: reading a range costs one call,
 * while checking each event separately would cost one per shift.
 */
function csLoadIndex(calendar, from, to) {
  var index = {};
  if (!from || !to || from.getTime() >= to.getTime()) return index;
  var events = calendar.getEvents(from, to);
  for (var i = 0; i < events.length; i++) {
    var key = events[i].getTag(CS_TAG_KEY);
    if (key) index[key] = events[i];
  }
  return index;
}

/** Midnight on the day a date falls in. */
function csStartOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** Midnight after the day a date falls in. */
function csEndOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

/** Widen a range to cover an event, whole days at a time. */
function csExtendRange(range, event) {
  var start = csStartOfDay(event.start);
  var end = csEndOfDay(event.end || event.start);
  if (!range.from || start.getTime() < range.from.getTime()) range.from = start;
  if (!range.to || end.getTime() > range.to.getTime()) range.to = end;
  return range;
}

function csApplyReminders(calendarEvent, reminderMinutes) {
  calendarEvent.removeAllReminders();
  if (!reminderMinutes) return;
  for (var i = 0; i < reminderMinutes.length; i++) {
    calendarEvent.addPopupReminder(reminderMinutes[i]);
  }
}

function csApplyColour(calendarEvent, colourName) {
  if (!colourName) return;
  var colour = CalendarApp.EventColor[colourName];
  if (colour) calendarEvent.setColor(colour);
}

/**
 * Create or update one event.
 *
 * Returns 'created', 'updated' or 'unchanged' — the unchanged case is the
 * common one on a re-run and does no writes at all.
 */
function csUpsertEvent(calendar, index, rule, event) {
  var existing = index[event.key];

  if (existing) {
    if (existing.getTag(CS_TAG_HASH) === event.hash) return 'unchanged';
    if (CONFIG.DRY_RUN) return 'updated';

    existing.setTitle(event.title);
    if (event.allDay) {
      existing.setAllDayDate(event.start);
    } else {
      existing.setTime(event.start, event.end);
    }
    existing.setDescription(event.description);
    if (event.location) existing.setLocation(event.location);
    csApplyReminders(existing, rule.reminderMinutes);
    csApplyColour(existing, rule.colour);
    existing.setTag(CS_TAG_HASH, event.hash);
    return 'updated';
  }

  if (CONFIG.DRY_RUN) return 'created';

  var options = { description: event.description };
  if (event.location) options.location = event.location;

  var created = event.allDay
    ? calendar.createAllDayEvent(event.title, event.start, options)
    : calendar.createEvent(event.title, event.start, event.end, options);

  created.setTag(CS_TAG_KEY, event.key);
  created.setTag(CS_TAG_HASH, event.hash);
  created.setTag(CS_TAG_RULE, event.ruleId);
  csApplyReminders(created, rule.reminderMinutes);
  csApplyColour(created, rule.colour);

  // So a second event with this key in the same run updates rather than duplicates.
  index[event.key] = created;
  return 'created';
}

/**
 * Delete this rule's events inside a window that the newest roster no longer
 * lists — a shift dropped or swapped upstream should leave the calendar too.
 *
 * Scoped hard: only events tagged with this rule, only inside the days the
 * roster actually covered. Events from other rules and anything added by hand
 * are never touched.
 */
function csRemoveDropped(calendar, rule, range, liveKeys) {
  if (!range.from || !range.to) return [];
  var removed = [];
  var events = calendar.getEvents(range.from, range.to);

  for (var i = 0; i < events.length; i++) {
    var calendarEvent = events[i];
    if (calendarEvent.getTag(CS_TAG_RULE) !== rule.id) continue;
    var key = calendarEvent.getTag(CS_TAG_KEY);
    if (!key || liveKeys[key]) continue;

    removed.push(calendarEvent.getTitle() + ' @ ' + calendarEvent.getStartTime());
    if (!CONFIG.DRY_RUN) calendarEvent.deleteEvent();
  }
  return removed;
}
