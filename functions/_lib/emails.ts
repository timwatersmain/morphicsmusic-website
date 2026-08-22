// Transactional emails that more than one entry point needs to send.
//
// The pre-order confirmation lives here because two different paths produce a
// pre-order: a paid one through stripe-webhook.ts, and a free claim through
// api/claim.ts. A second copy of the template would drift the moment either
// one was edited, and the buyer cannot tell which path issued their order.

interface EmailEnv {
  RESEND_API_KEY?: string;
  ORDER_FROM_EMAIL?: string;
}

// onboarding@resend.dev is Resend's shared test sender: it only delivers to
// the account owner, so real buyers never receive anything. morphicsmusic.com
// is verified in Resend as of 2026-08-09, so ignore that value if it is still
// configured rather than depending on someone remembering to clear it.
export function fromAddress(env: EmailEnv): string {
  const configured = env.ORDER_FROM_EMAIL;
  return (!configured || configured.endsWith('@resend.dev'))
    ? 'orders@morphicsmusic.com'
    : configured;
}

// A pre-order gets its own email, with NO download button. The ordinary
// receipt cannot be reused with the link removed: its 7-day grant would have
// expired long before a release that is weeks out, so pointing a buyer at a
// link that is dead on arrival is worse than sending no link. The library is
// the durable route, and it unlocks itself at midnight ET on the date.
export async function sendPreorderEmail(
  env: EmailEnv,
  to: string,
  items: Array<{ title: string; date: string }>,
) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — skipping email');
    return;
  }
  const from = fromAddress(env);
  const titles = items.map(i => i.title).join(', ');
  const rows = items
    .map(i => `<li style="margin-bottom:6px">${i.title} — unlocks ${i.date || 'on release'}</li>`)
    .join('');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Morphics <${from}>`,
      to: [to],
      subject: `Pre-order confirmed · ${titles}`,
      html: `
        <div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
          <h1 style="font-weight:700;letter-spacing:-0.02em">Pre-order confirmed.</h1>
          <p>Thanks for backing this before it is out. Nothing to download yet — the files appear in your library automatically on release day, and your access is permanent from then on.</p>
          <ul style="opacity:0.85;font-size:14px;padding-left:18px">${rows}</ul>
          <p style="margin:24px 0">
            <a href="https://morphicsmusic.com/library" style="background:#fff;color:#000;padding:14px 24px;text-decoration:none;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;font-size:11px">Your library</a>
          </p>
          <p style="opacity:0.7;font-size:13px;margin:24px 0">
            Sign in with this email address — no password needed.
          </p>
          <p style="opacity:0.4;font-size:11px;margin-top:32px">— Morphics</p>
        </div>`,
    }),
  });
  if (!res.ok) console.error('Resend failed:', await res.text());
}
