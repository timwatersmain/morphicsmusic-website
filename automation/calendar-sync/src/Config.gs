/**
 * Config.gs — the only file you normally edit.
 *
 * Start with DRY_RUN true. Run previewSync() from the Apps Script editor and
 * read the log: it prints every event it *would* create without touching the
 * calendar. Flip DRY_RUN to false once the output looks right.
 */

var CONFIG = {
  /**
   * 'primary' is your main Google Calendar. Strongly consider making a separate
   * calendar (Google Calendar -> Other calendars -> Create new calendar), then
   * pasting its Calendar ID here: everything the automation writes is then in
   * one place you can hide, recolour, or wipe in a single action if a rule
   * misbehaves.
   */
  CALENDAR_ID: 'primary',

  /** Log intended changes without writing them. Leave true until you trust it. */
  DRY_RUN: true,

  /**
   * How ambiguous numeric dates are read. 'MDY' -> 9/14 is 14 September.
   * 'DMY' -> 14/9 is the same day. Unambiguous formats ignore this.
   */
  DATE_ORDER: 'MDY',

  /**
   * How far back each run looks. This is a safety rail as much as a filter:
   * it stops a first run from back-filling years of old mail into a calendar.
   */
  LOOKBACK_DAYS: 14,

  /** Cap on threads examined per rule per run, so one noisy sender cannot stall a run. */
  MAX_THREADS_PER_RULE: 50,

  /** Applied to every email that produced an event, so Gmail shows the automation's reach. */
  PROCESSED_LABEL: 'Calendar Sync/Added',

  /** Applied when a rule matched but no date could be read — the list to review. */
  UNPARSED_LABEL: 'Calendar Sync/No Date Found',

  /** Length for an event whose email gave a start time but no end time. */
  DEFAULT_DURATION_MINUTES: 60,

  /** Minutes before the event for a popup reminder. Empty array means no reminder. */
  DEFAULT_REMINDER_MINUTES: [60],

  /** Your address for a summary of each run's changes. Empty string disables it. */
  DIGEST_EMAIL: '',

  /** Send the digest even when a run changed nothing. Noisy; off by default. */
  DIGEST_WHEN_EMPTY: false,
};

/**
 * The rules. Each one is a Gmail search plus instructions for what to do with
 * what it finds. Add, remove and reorder freely — they are independent.
 *
 * Fields:
 *   id                Stable, unique, and permanent. It tags every event this
 *                     rule creates; renaming it orphans those events.
 *   enabled           false parks a rule without deleting it.
 *   query             Any Gmail search string. Test it in Gmail's search box
 *                     first — if it returns the wrong mail there, it will here.
 *                     A 'newer_than' clause is added automatically.
 *   mode              'single' — one event per email thread.
 *                     'shifts' — every dated row in the email becomes an event.
 *   titleTemplate     Placeholders: {subject}, {from}, {shift}, {label}.
 *   location          Fixed location for the event. Optional.
 *   durationMinutes   Overrides DEFAULT_DURATION_MINUTES for this rule.
 *   reminderMinutes   Overrides DEFAULT_REMINDER_MINUTES for this rule.
 *   colour            A CalendarApp.EventColor name, e.g. 'PALE_BLUE', 'SAGE',
 *                     'TANGERINE', 'GRAPE', 'FLAMINGO'. Optional.
 *   allDayIfNoTime    'single' mode only. true (default) turns a date with no
 *                     time into an all-day event; false skips it.
 *   replaceWindow     'shifts' mode only, and the reason rosters work well:
 *                     within the date range a new roster covers, shifts this
 *                     rule created that the new roster no longer lists are
 *                     deleted. That is how a dropped or swapped shift leaves
 *                     your calendar instead of lingering.
 *   dateOrder         Per-rule override of CONFIG.DATE_ORDER.
 */
var RULES = [
  {
    id: 'work-schedule',
    enabled: false, // Turn on once the query below matches your real roster mail.
    query: 'from:scheduling@example.com subject:(schedule OR roster OR shifts)',
    mode: 'shifts',
    titleTemplate: 'Work — {shift}',
    location: '',
    durationMinutes: 480,
    reminderMinutes: [120],
    colour: 'PALE_BLUE',
    replaceWindow: true,
  },
  {
    id: 'bookings',
    enabled: false,
    query: 'from:(booking@example.com OR venue@example.com)',
    mode: 'single',
    titleTemplate: '{subject}',
    reminderMinutes: [1440, 120],
    colour: 'TANGERINE',
    allDayIfNoTime: true,
  },
  {
    id: 'starred-by-hand',
    enabled: false,
    /**
     * The manual escape hatch, and the one worth turning on first. Star an
     * email on your phone and its date lands on the calendar — no rule writing
     * needed, and it is a fast way to see how well parsing handles your mail.
     */
    query: 'is:starred',
    mode: 'single',
    titleTemplate: '{subject}',
    colour: 'GRAPE',
    allDayIfNoTime: true,
  },
];

/** Rule defaults filled in from CONFIG, so rules only state what differs. */
function csResolveRule(rule) {
  return {
    id: rule.id,
    enabled: rule.enabled !== false,
    query: rule.query,
    mode: rule.mode === 'shifts' ? 'shifts' : 'single',
    titleTemplate: rule.titleTemplate || '{subject}',
    location: rule.location || '',
    durationMinutes: rule.durationMinutes || CONFIG.DEFAULT_DURATION_MINUTES,
    reminderMinutes: rule.reminderMinutes || CONFIG.DEFAULT_REMINDER_MINUTES,
    colour: rule.colour || null,
    allDayIfNoTime: rule.allDayIfNoTime !== false,
    replaceWindow: rule.replaceWindow === true,
    dateOrder: rule.dateOrder || CONFIG.DATE_ORDER,
    calendarId: rule.calendarId || CONFIG.CALENDAR_ID,
  };
}

/**
 * Rule ids must be unique and present: they are the tag that ties an event back
 * to the rule that made it, and replaceWindow deletes by that tag. A duplicate
 * id would let one rule delete another's events.
 */
function csValidateRules(rules) {
  var problems = [];
  var seen = {};
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var where = 'rule at index ' + i;
    if (!rule.id) {
      problems.push(where + ' has no id');
      continue;
    }
    if (seen[rule.id]) problems.push('duplicate rule id: ' + rule.id);
    seen[rule.id] = true;
    if (!rule.query) problems.push(rule.id + ' has no query');
    if (rule.mode && rule.mode !== 'shifts' && rule.mode !== 'single') {
      problems.push(rule.id + ' has unknown mode: ' + rule.mode);
    }
    if (rule.replaceWindow && rule.mode !== 'shifts') {
      problems.push(rule.id + ' sets replaceWindow, which only applies to mode "shifts"');
    }
  }
  return problems;
}
