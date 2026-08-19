# Future work — one booking address, self-maintaining CC list

Not a priority. Recorded 19 Aug 2026 so it isn't lost.

## What the owner wants

A single primary booking address that he can read himself, which also
auto-forwards to whoever is currently on his team. Crucially: when a manager
or agent changes, he wants to update that in **one place** and have the CC
list adjust itself — never to go hunting through forwarding rules, form
config and PDFs to find every place the old contact was written down.

That instinct is right, and it is exactly the failure this project already
hit once: the 2022 rider PDF still named a manager who had left, because the
contact lived inside a document instead of in data.

## Why this is mostly already built

Two pieces exist:

- **`src/data/epk.json` → `management`** is already the single source of
  truth for the current manager, and both the rider and the one-sheet read
  from it. Change it there and `node press-kit/build-all.mjs` reissues both
  PDFs with the new contact.
- **`functions/_lib/contact.ts` → `routeFor()`** already routes each enquiry
  intent to its own address, via `CONTACT_TO_BOOKING`, `CONTACT_TO_LICENSING`,
  `CONTACT_TO_PRESS` and `CONTACT_TO_GENERAL`. Booking can be split off its
  own inbox today without touching code.

The gap is only that those two do not talk to each other: the routing reads
env vars, and the team roster lives in JSON.

## The shape of the remaining work

1. Add a `team` array to `epk.json` — role, name, email, active. `management`
   becomes the entry with `role: "management"`, so nothing that reads it
   today breaks.
2. Have `/api/contact` build its recipient list from that roster: the primary
   booking address as `to`, every active team member as `cc`. Then adding an
   agent is one line of JSON and one deploy, with no mail rules touched.
3. Keep a real mailbox (e.g. `booking@morphicsmusic.com`) as the published
   address so it survives any team change, and so it can be printed on a
   rider that stays correct.

## Two things to decide first

- **Whether the site sends the CC, or the mailbox forwards it.** Sending from
  the site keeps everything in one config and is simpler to reason about.
  Mailbox forwarding also catches enquiries that arrive by other routes —
  someone replying to an old thread, or emailing the address off a flier.
  Doing both double-sends; pick one deliberately.
- **A departing team member keeps receiving mail until the roster is updated.**
  Whichever route is chosen, removing someone must be as easy as adding them,
  or this ends up in the same stale state as the 2022 rider.
