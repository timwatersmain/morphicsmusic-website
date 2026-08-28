import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * A stand-in for the Apps Script services, good enough to run the whole sync
 * end to end.
 *
 * This exists for one behaviour above all: replaceWindow deletes events. A bug
 * there destroys entries a person put on their calendar by hand, which no
 * amount of careful parsing makes up for — so the deletion path gets tested
 * against a calendar that also holds events it must not touch.
 */

const ALL_SOURCES = ['Config.gs', 'Parse.gs', 'Extract.gs', 'Gmail.gs', 'Calendar.gs', 'Main.gs'];

class FakeEvent {
  constructor(calendar, { title, start, end, allDay, description, location }) {
    this.calendar = calendar;
    this.title = title;
    this.start = start;
    this.end = end;
    this.allDay = Boolean(allDay);
    this.description = description || '';
    this.location = location || '';
    this.tags = {};
    this.reminders = [];
    this.colour = null;
    this.deleted = false;
  }

  getTag(key) { return Object.prototype.hasOwnProperty.call(this.tags, key) ? this.tags[key] : null; }
  setTag(key, value) { this.tags[key] = value; return this; }
  getTitle() { return this.title; }
  setTitle(value) { this.title = value; return this; }
  getStartTime() { return this.start; }
  setTime(start, end) { this.start = start; this.end = end; this.allDay = false; return this; }
  setAllDayDate(date) { this.start = date; this.end = null; this.allDay = true; return this; }
  setDescription(value) { this.description = value; return this; }
  setLocation(value) { this.location = value; return this; }
  removeAllReminders() { this.reminders = []; return this; }
  addPopupReminder(minutes) { this.reminders.push(minutes); return this; }
  setColor(colour) { this.colour = colour; return this; }
  deleteEvent() { this.deleted = true; this.calendar.events = this.calendar.events.filter((e) => e !== this); }
}

class FakeCalendar {
  constructor() { this.events = []; }

  /** Matches CalendarApp: anything overlapping the window, not only fully inside it. */
  getEvents(from, to) {
    return this.events.filter((event) => {
      const start = event.start.getTime();
      const end = (event.end || event.start).getTime();
      return start < to.getTime() && end > from.getTime();
    });
  }

  createEvent(title, start, end, options) {
    const event = new FakeEvent(this, { title, start, end, ...options });
    this.events.push(event);
    return event;
  }

  createAllDayEvent(title, date, options) {
    const event = new FakeEvent(this, { title, start: date, end: null, allDay: true, ...options });
    this.events.push(event);
    return event;
  }

  /** Test helper: an untagged event, as if the user added it by hand. */
  addManualEvent(title, start, end) {
    const event = new FakeEvent(this, { title, start, end });
    this.events.push(event);
    return event;
  }
}

class FakeMessage {
  constructor({ subject, body, from, id, date }) {
    this.subject = subject;
    this.body = body;
    this.from = from;
    this.id = id;
    this.date = date;
  }
  getSubject() { return this.subject; }
  getPlainBody() { return this.body; }
  getFrom() { return this.from; }
  getId() { return this.id; }
  getDate() { return this.date; }
}

class FakeThread {
  constructor(id, messages) {
    this.id = id;
    this.messages = messages.map((m) => new FakeMessage(m));
    this.labels = [];
  }
  getId() { return this.id; }
  getMessages() { return this.messages; }
  addLabel(label) { if (!this.labels.includes(label.name)) this.labels.push(label.name); }
}

/**
 * Build a VM context with the real .gs sources and fake services.
 * @param {Array} threads Thread specs; each { id, matches, messages }.
 */
export function loadWithFakes(threads = []) {
  const calendar = new FakeCalendar();
  const fakeThreads = threads.map((spec) => {
    const thread = new FakeThread(spec.id, spec.messages);
    thread.matches = spec.matches;
    return thread;
  });
  const logs = [];
  const sentMail = [];

  const globals = {
    CalendarApp: {
      getDefaultCalendar: () => calendar,
      getCalendarById: () => calendar,
      // Real EventColor members are string ids; the names are all the code uses.
      EventColor: { PALE_BLUE: '1', TANGERINE: '6', GRAPE: '3', SAGE: '2', FLAMINGO: '4' },
    },
    GmailApp: {
      /** `matches` on a thread spec names the rule ids whose query it answers. */
      search: (query) => fakeThreads.filter((t) => t.matches.some((id) => query.includes(id))),
      getUserLabelByName: (name) => ({ name }),
      createLabel: (name) => ({ name }),
    },
    MailApp: { sendEmail: (to, subject, body) => sentMail.push({ to, subject, body }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Logger: { log: (message) => logs.push(String(message)) },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }),
    },
  };

  const context = vm.createContext(globals);
  for (const name of ALL_SOURCES) {
    const path = fileURLToPath(new URL(`../../automation/calendar-sync/src/${name}`, import.meta.url));
    vm.runInContext(readFileSync(path, 'utf8'), context, { filename: name });
  }

  /** Deliver a new email between runs, the way a corrected roster arrives. */
  function addThread(spec) {
    const thread = new FakeThread(spec.id, spec.messages);
    thread.matches = spec.matches;
    fakeThreads.push(thread);
    return thread;
  }

  return { context, calendar, threads: fakeThreads, logs, sentMail, addThread };
}

/**
 * The rule id is embedded in the query so the fake GmailApp can route threads
 * to the right rule without implementing Gmail search.
 */
export function ruleQueryFor(id) {
  return `fake-query-${id}`;
}
