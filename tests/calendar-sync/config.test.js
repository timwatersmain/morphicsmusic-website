import { describe, it, expect, beforeAll } from 'vitest';
import { loadCalendarSync } from './load-gs.js';

let cs;
beforeAll(() => {
  cs = loadCalendarSync();
});

describe('rule validation', () => {
  it('accepts the shipped rules', () => {
    expect(cs.csValidateRules(cs.RULES)).toEqual([]);
  });

  it('rejects a duplicate id', () => {
    // Ids tag events on the calendar and replaceWindow deletes by that tag, so
    // two rules sharing an id would let one delete the other's events.
    const rules = [
      { id: 'work', query: 'from:a@example.com' },
      { id: 'work', query: 'from:b@example.com' },
    ];
    expect(cs.csValidateRules(rules)).toContain('duplicate rule id: work');
  });

  it('rejects a rule with no id or no query', () => {
    expect(cs.csValidateRules([{ query: 'from:a@example.com' }])).toContain('rule at index 0 has no id');
    expect(cs.csValidateRules([{ id: 'x' }])).toContain('x has no query');
  });

  it('rejects an unknown mode', () => {
    const problems = cs.csValidateRules([{ id: 'x', query: 'q', mode: 'rota' }]);
    expect(problems).toContain('x has unknown mode: rota');
  });

  it('rejects replaceWindow outside shift mode', () => {
    // Deleting "events this rule made that the email no longer lists" only has
    // a meaning when one email lists the whole set.
    const problems = cs.csValidateRules([{ id: 'x', query: 'q', mode: 'single', replaceWindow: true }]);
    expect(problems[0]).toContain('replaceWindow');
  });
});

describe('rule defaults', () => {
  it('fills unset fields from CONFIG', () => {
    const rule = cs.csResolveRule({ id: 'x', query: 'q' });
    expect(rule).toMatchObject({
      mode: 'single',
      enabled: true,
      titleTemplate: '{subject}',
      durationMinutes: cs.CONFIG.DEFAULT_DURATION_MINUTES,
      dateOrder: cs.CONFIG.DATE_ORDER,
      calendarId: cs.CONFIG.CALENDAR_ID,
      allDayIfNoTime: true,
      replaceWindow: false,
    });
  });

  it('lets a rule override the defaults', () => {
    const rule = cs.csResolveRule({
      id: 'x',
      query: 'q',
      mode: 'shifts',
      durationMinutes: 480,
      dateOrder: 'DMY',
      allDayIfNoTime: false,
      replaceWindow: true,
    });
    expect(rule).toMatchObject({
      mode: 'shifts',
      durationMinutes: 480,
      dateOrder: 'DMY',
      allDayIfNoTime: false,
      replaceWindow: true,
    });
  });

  it('treats enabled:false as disabled and a missing enabled as on', () => {
    expect(cs.csResolveRule({ id: 'x', query: 'q', enabled: false }).enabled).toBe(false);
    expect(cs.csResolveRule({ id: 'x', query: 'q' }).enabled).toBe(true);
  });
});

describe('gmail query building', () => {
  it('scopes every rule query to the lookback window', () => {
    // The rail that stops a first run back-filling years of mail.
    const rule = cs.csResolveRule({ id: 'x', query: 'from:a@example.com' });
    expect(cs.csRuleQuery(rule)).toBe(`(from:a@example.com) newer_than:${cs.CONFIG.LOOKBACK_DAYS}d`);
  });
});
