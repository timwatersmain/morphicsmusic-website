// The "what you own" markup, in one place, rendered identically by
// /library and by the Your library block on /community/me. Both pages used
// to carry their own copy of this (with a comment on the second one saying
// it was copied verbatim from the first), which is exactly how the two
// drift apart the first time either is touched.
//
// The ownership story this renders, deliberately and consistently:
//
//   * Anything you own is yours for life, with unlimited downloads. That is
//     what /api/download's cookie path has always done — no expiry, no use
//     cap — and every label here now says so out loud.
//   * The ONLY limit that appears anywhere is a LICENCE, and only on
//     digital products (typefaces, plugins, packs), where it describes
//     usage rights (e.g. "commercial licence, up to 5 users"), never
//     download counts. It comes from digital.json via _lib/entitlements.
//   * The 7-day / 5-use figure on an emailed download link is NOT shown
//     here at all: that's a bearer-token security control on a link anyone
//     holding it can use, and it has nothing to do with what you own.

export const esc = (s: any) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Only http(s) or site-root URLs reach an <img src>; anything else renders empty. */
export const safeImg = (s: any) => {
  const v = String(s ?? '');
  return /^(https?:|\/)/.test(v) ? v : '';
};

export function fmtSize(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.ceil(b / 1024) + ' KB';
}

export function fmtDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The one line every owned-item section carries. Ownership never expires. */
export const LIFETIME_NOTE = 'Yours for life · unlimited downloads · re-download any time you’re signed in';

function sectionHeader(title: string, note?: string): string {
  return `
    <div class="flex flex-wrap items-baseline gap-3 mb-4">
      <span class="font-mono text-xs text-secondary uppercase tracking-widest">${esc(title)}</span>
      <div class="h-[1px] flex-1 min-w-8 bg-outline-variant/30"></div>
      ${note ? `<span class="font-mono text-[10px] text-white/40 normal-case">${esc(note)}</span>` : ''}
    </div>`;
}

function fileRow(f: any): string {
  const size = fmtSize(f.size);
  return `
    <li class="flex items-center gap-4 py-3">
      <span class="font-mono text-[10px] text-white/30 uppercase">${esc(f.ext || '')}</span>
      <span class="flex-1 font-mono text-[11px] text-white/80 truncate">${esc(f.filename)}</span>
      <span class="font-mono text-[10px] text-white/40">${esc(size)}</span>
      <a href="/api/download?key=${encodeURIComponent(f.key)}"
         class="px-3 py-2 border border-primary/20 hover:border-primary/60 hover:bg-primary/5 font-mono text-[10px] tracking-widest uppercase text-primary rounded-full">
        Download
      </a>
    </li>`;
}

function itemCard(opts: { artwork: string; kicker: string; title: string; footnote?: string | null; files: any[]; emptyNote: string }): string {
  return `
    <section class="border border-white/5 p-6">
      <div class="flex items-center gap-4 mb-4">
        <img src="${esc(safeImg(opts.artwork))}" alt="" loading="lazy" class="w-16 h-16 object-cover bg-white/5" />
        <div class="flex-1">
          <div class="font-mono text-[10px] text-secondary uppercase tracking-widest">${esc(opts.kicker)}</div>
          <h2 class="font-headline text-2xl text-primary uppercase tracking-tight">${esc(opts.title)}</h2>
          ${opts.footnote ? `<p class="font-mono text-[10px] text-white/40 mt-1">${esc(opts.footnote)}</p>` : ''}
        </div>
      </div>
      ${opts.files.length === 0
        ? `<p class="font-mono text-[11px] text-white/30">${esc(opts.emptyNote)}</p>`
        : `<ul class="divide-y divide-white/5 border-y border-white/5">${opts.files.map(fileRow).join('')}</ul>`}
    </section>`;
}

export function musicSection(releases: any[]): string {
  if (!releases?.length) return '';
  const cards = releases.map(r => {
    // A pre-order is listed here from the moment it is paid for — this page is
    // where someone checks that their money did something — but it carries no
    // files and says why. The empty-state branch of itemCard already does the
    // work; it only needs a truthful note instead of "coming soon".
    if (r.preorder) {
      const d = r.unlocks_in_days;
      const when = d == null ? 'on release day' : d <= 1 ? 'within a day' : `in ${d} days`;
      return itemCard({
        artwork: r.artwork,
        kicker: 'Pre-order',
        title: r.title,
        footnote: r.release_date ? `Unlocks ${r.release_date}` : null,
        files: [],
        emptyNote: `Not out yet. The files appear here ${when} — nothing to do, and no second email needed.`,
      });
    }
    return itemCard({
      artwork: r.artwork,
      kicker: r.free_song ? 'Free song' : r.type,
      title: r.title,
      files: r.files || [],
      emptyNote: 'Files coming soon — check back shortly.',
    });
  }).join('');
  return `<div>${sectionHeader('Music', LIFETIME_NOTE)}<div class="space-y-4">${cards}</div></div>`;
}

export function digitalSection(items: any[]): string {
  if (!items?.length) return '';
  // The licence line rides on the item itself — it is the one and only
  // place a limit is ever stated, and it is about usage rights, not
  // downloads, which stay unlimited exactly like music.
  const cards = items.map(d => itemCard({
    artwork: d.artwork,
    kicker: d.kind || 'download',
    title: d.title,
    footnote: d.licence,
    files: d.files || [],
    emptyNote: 'File coming soon — check back shortly.',
  })).join('');
  return `<div>${sectionHeader('Fonts, plugins & downloads', LIFETIME_NOTE)}<div class="space-y-4">${cards}</div></div>`;
}

export function orderHistorySection(purchases: any[]): string {
  if (!purchases?.length) return '';
  const rows = purchases.slice().reverse().map((p: any) => {
    const names = [...(p.music_release_slugs || []), ...(p.digital_slugs || [])]
      .map((s: string) => s.toUpperCase().replace(/-/g, ' '))
      .join(', ');
    return `
      <li class="flex items-center gap-4 py-3">
        <span class="font-mono text-[10px] text-white/40 w-24 shrink-0">${esc(fmtDate(p.purchased_at))}</span>
        <span class="flex-1 font-mono text-[11px] text-white/70">${esc(names || '(merch)')}</span>
        <span class="font-mono text-[11px] text-secondary tabular-nums">$${esc(((p.amount_total || 0) / 100).toFixed(2))}</span>
      </li>`;
  }).join('');
  return `<div>${sectionHeader('Order history')}<ol class="divide-y divide-white/5 border-y border-white/5">${rows}</ol></div>`;
}

export function emptyLibrary(): string {
  return `
    <div class="p-8 border border-white/10 rounded-[var(--radius-lg)] text-center">
      <p class="font-mono text-[11px] text-white/40 leading-relaxed">
        Nothing here yet. Browse the <a href="/store" class="text-secondary underline">store</a> — your library populates the moment you buy something, and stays there for good.
      </p>
    </div>`;
}

/** Does this payload contain anything the fan owns? */
export function hasAnything(data: any): boolean {
  return !!(data?.releases?.length || data?.digital?.length || data?.purchases?.length);
}

/** The whole owned-items view. `withOrderHistory` is off on the profile, where the emphasis is the collection itself. */
export function libraryHtml(data: any, opts: { withOrderHistory?: boolean } = {}): string {
  if (!hasAnything(data)) return emptyLibrary();
  return [
    musicSection(data.releases || []),
    digitalSection(data.digital || []),
    opts.withOrderHistory ? orderHistorySection(data.purchases || []) : '',
  ].filter(Boolean).join('');
}
