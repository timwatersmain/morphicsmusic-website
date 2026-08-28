# calendar-sync

Reads specific emails in your Gmail and puts what they describe on your Google
Calendar, which your phone then shows. Runs on Google's servers every 15
minutes — nothing to host, nothing to keep awake.

It handles two shapes of email:

- **Single events** — a booking, a call, a deadline. One email, one calendar entry.
- **Rosters** — a work schedule listing several dated shifts. One email, many entries,
  and shifts dropped from a later roster are removed from your calendar.

## Why Google Calendar

You said you don't currently use a calendar app, so this targets Google Calendar:
it's the only option Apps Script can write to with no OAuth setup, and both
phones read it. On **Android** it's already the built-in calendar. On **iPhone**,
Settings → Apps → Calendar → Accounts → Add Account → Google, and events show up
in the stock Calendar app alongside everything else. You don't need the Google
Calendar app on either.

## Setup

Roughly ten minutes, and nothing is written to your calendar until step 6.

**1. Make a calendar for it.** In [Google Calendar](https://calendar.google.com),
under *Other calendars* click **+** → *Create new calendar*. Name it something
like `Auto`. Open its settings and copy the **Calendar ID** near the bottom.

This is optional but worth it: everything the automation creates lands in one
calendar you can recolour, hide, or delete wholesale if a rule misbehaves. Left
as `primary`, its events are mixed into your main calendar and are fiddlier to
undo.

**2. Create the script.** Go to [script.google.com](https://script.google.com) →
**New project**. Name it `calendar-sync`.

**3. Copy the files in.** For each `.gs` file in `src/`, add a file of the same
name in the editor (the **+** next to *Files*, choose *Script*, and type the name
without the extension) and paste the contents. Delete the default `Code.gs`.

To see `appsscript.json`, click the gear (*Project Settings*) and tick *Show
"appsscript.json" manifest file in editor*, then paste that file over it too. It
sets the timezone and the permissions the script asks for.

**4. Set your timezone.** In `appsscript.json`, `timeZone` is `America/New_York`.
Change it if that's wrong — every time in every email is read as this zone, so a
wrong value shifts every event by the offset.

**5. Configure.** In `Config.gs`:

- `CALENDAR_ID` — the ID from step 1, or leave `'primary'`.
- `DATE_ORDER` — `'MDY'` means `9/14` is 14 September. Use `'DMY'` if your
  senders write `14/9`. Only affects ambiguous numeric dates; `2026-09-14` and
  `Sept 14` are read correctly either way.
- `RULES` — see below. All three ship disabled; turn on what you want.

**6. Rehearse, then go live.** With `DRY_RUN: true`, run `previewSync` from the
function dropdown. Google asks you to authorize on the first run — it will warn
the app is unverified, because it's your own script and not a published one;
*Advanced* → *Go to calendar-sync (unsafe)* is the path through.

Open **Execution log** and read what it would have created. When that looks
right, set `DRY_RUN: false` and run `installTrigger` once. It's now live.

## Writing rules

A rule is a Gmail search plus what to do with what it finds. Test the search in
Gmail's own search box first — if it returns the wrong mail there, it will here.

```js
{
  id: 'bookings',              // permanent; it tags the events this rule creates
  enabled: true,
  query: 'from:booking@venue.com',
  mode: 'single',              // one event per email thread
  titleTemplate: '{subject}',  // {subject} {from} {shift}
  reminderMinutes: [1440, 120],
  colour: 'TANGERINE',
}
```

`id` is permanent. It's written onto every event the rule creates and is how the
automation recognises its own work later; renaming it strands the existing
events, which then have to be deleted by hand.

The **`starred-by-hand`** rule is the one to enable first. Star an email on your
phone and its date goes on the calendar — no rule writing, and it's the quickest
way to see how well parsing copes with your actual mail.

### Work schedules

When your rosters start arriving, set `query` to match them and use `mode: 'shifts'`:

```js
{
  id: 'work-schedule',
  enabled: true,
  query: 'from:scheduling@work.com subject:(schedule OR roster)',
  mode: 'shifts',
  titleTemplate: 'Work — {shift}',
  durationMinutes: 480,        // used only if a row gives no end time
  replaceWindow: true,
  colour: 'PALE_BLUE',
}
```

Every row carrying both a date and a time becomes an event:

```
Mon 14 Sep: 9:00-17:00 Front desk   ->  Mon 14 Sep, 09:00-17:00, "Work — Front desk"
Tue 15 Sep: OFF                     ->  skipped
Wed 16 Sep: 22:00-06:00 Overnight   ->  Wed 22:00 to Thu 06:00
Week commencing 14 September        ->  skipped (a date but no time)
```

`replaceWindow: true` is what makes rosters behave. Shifts this rule created
that the latest roster no longer lists are deleted, so a dropped or swapped
shift leaves your calendar instead of lingering. It only ever touches events
tagged with this rule's `id`, within the dates the roster covers — other rules'
events and anything you added by hand are never affected.

The rule it follows: **when two of this rule's emails cover overlapping days,
the newer one is the whole truth for that period.** A corrected roster listing
only Monday and Wednesday doesn't just update those two days — it says Friday is
no longer a shift, and Friday is removed. Emails covering separate weeks don't
interact, so next week's roster arriving never disturbs this week's.

That is the right behaviour when each email is a complete schedule for its
period, which is what rosters usually are. If your schedule instead arrives as
incremental "one extra shift added" emails, leave `replaceWindow` off — those
would otherwise wipe the rest of the week.

**Before enabling it**, paste a real roster into `TEXT_TO_TEST` in `Main.gs` and
run `testParseText`. The log shows exactly which rows became events and which
were ignored. That loop takes seconds and needs neither Gmail nor a calendar.
Once mail is arriving, `testRule` does the same against real messages — set
`RULE_TO_TEST` to the rule's id, and for any email it couldn't read it prints
the first 15 lines of the body so you can see what it saw.

## What it will and won't do

**Running the same email twice never duplicates an event.** Each event carries a
stable key. A re-sent roster updates its shifts in place; a "moved to Thursday"
reply on a booking thread moves that event rather than adding a second one.
Re-running `syncCalendar` by hand is always safe.

**It only looks back `LOOKBACK_DAYS` (14).** The first run won't back-fill years
of old mail. It also means an email that arrives while a rule is disabled is
picked up if you enable the rule within a fortnight, and missed after that.

**It reads dates, not intent.** `Sept 14 at 7pm`, `14/09 19:00`, `2026-09-14`,
`7-11pm`, and overnight ranges all parse. An email saying "let's do next Tuesday"
does not — there's no date to read. Emails a rule matched but that yielded no
date get the `Calendar Sync/No Date Found` label, so that list is worth checking
early on: it tells you which senders need a tighter query or a different rule.

**A year is inferred when the email omits one.** A bare `March 3` means the next
one, with about six weeks of slack backwards so a roster mailed on the 1st can
still refer to the end of last month.

**Only whole emails, and only the newest part of a thread.** Quoted reply chains
are stripped before parsing, so old dates in a `>` block don't resurrect.

## Troubleshooting

**Everything is off by some hours.** `timeZone` in `appsscript.json` doesn't
match the zone your senders write times in. Fix it, then delete the wrong events
and re-run.

**A date landed on the wrong day.** Almost always `DATE_ORDER` — `9/10` is
genuinely ambiguous, and only you know which your sender means.

**Nothing happens.** Check *Executions* in the left sidebar for errors. If runs
succeed but do nothing, run the rule's query in Gmail: usually the query matches
no mail, or `LOOKBACK_DAYS` has passed.

**It made a mess.** Set `DRY_RUN: true` and run `removeTriggers`. If you gave it
its own calendar, delete that calendar and start again.

**Wrong events keep coming back.** Fix the rule first — an event deleted while
the rule still matches its email is recreated on the next run. Narrow the query
or set `enabled: false`, then delete.

## Development

The parsing is plain functions with no Apps Script calls, so it's tested under
this repo's own suite — `tests/calendar-sync/` evaluates the real `.gs` files in
a VM context, the same way Apps Script concatenates them, so the tests exercise
what actually ships rather than a copy.

```sh
npx vitest run tests/calendar-sync/
```

Add a case there before changing a regex; date parsing is exactly the kind of
code where a fix for one format quietly breaks another.

| File | Role |
| --- | --- |
| `Config.gs` | Rules and settings — the only file you normally edit |
| `Parse.gs` | Dates and times out of text |
| `Extract.gs` | Emails into events; identity and change detection |
| `Gmail.gs` | Finding and labelling the mail |
| `Calendar.gs` | Creating, updating and removing events |
| `Main.gs` | Entry points, the run loop, diagnostics |
