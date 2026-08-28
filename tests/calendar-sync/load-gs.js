import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Apps Script has no modules: every .gs file shares one global scope and the
 * runtime concatenates them. These tests reproduce that by evaluating the real
 * source files in a single VM context, so they exercise the code that actually
 * ships rather than a copy that can drift out of sync with it.
 *
 * Calendar.gs and Main.gs are left out: they call Apps Script services that do
 * not exist here. Config.gs and Gmail.gs load fine — they name GmailApp and
 * CalendarApp only inside function bodies these tests never call.
 */
const SOURCES = ['Config.gs', 'Parse.gs', 'Extract.gs', 'Gmail.gs'];

export function loadCalendarSync() {
  const context = vm.createContext({});
  for (const name of SOURCES) {
    const path = fileURLToPath(new URL(`../../automation/calendar-sync/src/${name}`, import.meta.url));
    vm.runInContext(readFileSync(path, 'utf8'), context, { filename: name });
  }
  return context;
}

/** A fixed reference date keeps year inference deterministic across runs. */
export const REF = new Date(2026, 8, 1, 12, 0, 0); // 1 September 2026, local time.

/** Compact local-time stamp for assertions: 2026-09-14 19:00. */
export function stamp(date) {
  if (!date) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
