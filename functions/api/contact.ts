// POST /api/contact — the booking/contact portal's one endpoint.
//
// Delivers the enquiry to the inbox its intent routes to (see routeFor) and
// sends the enquirer an acknowledgement stating when they'll hear back. An
// enquiry that vanishes silently is worse than no form: the sender has no
// idea whether to chase, and a talent buyer simply books someone else.
//
// Reply-To is set to the enquirer, so answering is one tap from the inbox
// rather than a copy-paste of an address out of the body.

import { corsHandler, preflight } from '../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../_lib/ratelimit';
import {
  INTENTS, isIntent, routeFor, validateSubmission, spamScore, formatSubmission,
  SPAM_REFUSE_AT, type ContactRouting,
} from '../_lib/contact';

interface Env extends ContactRouting {
  DOWNLOADS: KVNamespace;
  RESEND_API_KEY?: string;
  ORDER_FROM_EMAIL?: string;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function senderAddress(env: Env): string {
  // Same guard as every other sender here: a stale @resend.dev address only
  // delivers to the account owner, so a real enquiry would silently vanish.
  const configured = env.ORDER_FROM_EMAIL;
  return (!configured || configured.endsWith('@resend.dev')) ? 'orders@morphicsmusic.com' : configured;
}

async function send(env: Env, payload: Record<string, unknown>): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — contact email not sent');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error('Resend rejected contact email:', res.status, await res.text());
    return res.ok;
  } catch (e) {
    console.error('contact email send failed:', e);
    return false;
  }
}

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  // TWO limits, because they protect different things and a single one gets
  // this wrong in a way that only shows up on the longest form.
  //
  // This first one is the abuse guard on requests. It has to be loose:
  // every failed validation is a request too, and a booking enquiry has ten
  // fields, so a person fumbling their way through one can easily submit
  // four or five times before anything is ever sent. A tight limit here
  // locks a real talent buyer out mid-enquiry — which is exactly what
  // happened the first time this was driven end to end.
  const rl = await rateLimit(env, 'contact', 'ip', clientIp(request), 20, 600);
  if (!rl.ok) return rateLimitedJson(rl);

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const intent = body.intent;
  if (!isIntent(intent)) return json({ error: 'unknown_intent' }, 400);

  const score = spamScore({ honeypot: body.website, elapsedSeconds: Number(body.elapsed_seconds) });
  if (score >= SPAM_REFUSE_AT) {
    // 200, not 4xx: a bot learns nothing from a success it did not get, and
    // a human who somehow trips this still sees the normal confirmation
    // rather than an accusation. Nothing is sent.
    console.warn('contact submission refused, spam score', score);
    return json({ ok: true });
  }

  const { ok, errors, clean } = validateSubmission(intent, body);
  if (!ok) return json({ error: 'validation_failed', errors }, 400);

  // The second limit, on the action that actually costs something: sending
  // mail. Checked only now, so a rejected or fumbled submission never
  // spends any of it. Five real enquiries per ten minutes is far more than
  // a person sends and worthless to a spammer.
  const sendRl = await rateLimit(env, 'contact_send', 'ip', clientIp(request), 5, 600);
  if (!sendRl.ok) return rateLimitedJson(sendRl);

  const spec = INTENTS[intent];
  const to = routeFor(intent, env);
  const from = senderAddress(env);
  const replyTo = clean.email;
  const who = clean.organization || clean.name;
  const summary = formatSubmission(intent, clean);

  const delivered = await send(env, {
    from: `Morphics site <${from}>`,
    to: [to],
    reply_to: replyTo,
    subject: `[${spec.subject}] ${who}${clean.city ? ` — ${clean.city}` : ''}`,
    text: `${summary}\n\n—\nSent from the ${spec.label.toLowerCase()} form on morphicsmusic.com`
      + (score > 0 ? `\n\nNOTE: this submission scored ${score} on the spam heuristics — worth a second look.` : ''),
  });

  // The acknowledgement is best-effort and never gates the response: the
  // enquiry itself is already delivered, and failing the request here would
  // invite a resubmit that duplicates it in the inbox.
  await send(env, {
    from: `Morphics <${from}>`,
    to: [replyTo],
    subject: 'Got your message — Morphics',
    html: `
      <div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
        <h1 style="font-weight:700;letter-spacing:-0.02em">Thanks — this arrived.</h1>
        <p>Your ${escapeHtml(spec.label.toLowerCase())} enquiry is in. You'll hear back ${escapeHtml(spec.replyWithin)}.</p>
        <p style="opacity:0.5;font-size:12px;margin-top:24px">A copy of what you sent:</p>
        <pre style="white-space:pre-wrap;font-family:monospace;font-size:12px;opacity:0.7;border-left:2px solid #2a3132;padding-left:12px">${escapeHtml(summary)}</pre>
        <p style="opacity:0.4;font-size:11px;margin-top:32px">Replying to this email reaches me directly. — Morphics</p>
      </div>`,
  });

  return json({ ok: true, delivered, reply_within: spec.replyWithin });
});
