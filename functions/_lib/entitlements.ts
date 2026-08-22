import { digitalDeliverable } from './preorder.mjs';

// What a customer OWNS, derived from their purchase history.
//
// The rule this module encodes: ownership is permanent and uncapped. A
// purchase puts a slug in the customer record forever, and every surface
// that asks "can they have this file" answers from that record — never
// from a token, a counter or an expiry. The 7-day / 5-use limit that still
// exists on emailed download links is a bearer-token security control (an
// email link is a credential anyone holding it can use); it is not, and
// must not be presented as, a limit on ownership.
//
// The ONE thing that is genuinely limited on some products is the LICENCE —
// the usage rights on digital products (typefaces, plugins, packs), e.g.
// "commercial licence, up to 5 users". That's a rights term, not a
// download term, and it only ever comes from digital.json.

export interface PurchaseLike {
  music_release_slugs?: string[];
  digital_slugs?: string[];
}

export interface RecordLike {
  purchases?: PurchaseLike[];
}

export interface DigitalProduct {
  slug: string;
  name: string;
  kind?: string;
  thumbnail?: string;
  details?: string[];
  file?: { r2_key?: string; filename?: string };
  /** Optional. Present only on products that can be pre-ordered; absent
   *  means the ordinary case — delivered the moment it is bought. */
  release_date?: string;
}

export interface OwnedDigital {
  slug: string;
  title: string;
  kind: string;
  artwork: string;
  /** The licence terms for this product — the only limit we ever show. */
  licence: string | null;
  /** Bought, but not yet deliverable — a pre-order awaiting its date. */
  preorder?: boolean;
  release_date?: string;
  files: Array<{ key: string; filename: string; ext: string }>;
}

/** Every slug the customer has ever bought under `field`, deduped. */
export function ownedSlugs(record: RecordLike | null | undefined, field: keyof PurchaseLike): Set<string> {
  const out = new Set<string>();
  for (const p of record?.purchases || []) {
    for (const slug of (p[field] || [])) {
      if (typeof slug === 'string' && slug) out.add(slug);
    }
  }
  return out;
}

/**
 * Pull the licence line out of a product's own `details` list rather than
 * hard-coding it here, so digital.json stays the single source of truth for
 * what a buyer is actually allowed to do. Returns null when a product
 * simply has no licence term to state.
 */
export function licenceTerms(product: DigitalProduct): string | null {
  const line = (product.details || []).find(d => typeof d === 'string' && /licen[cs]e/i.test(d));
  return line ? line.trim() : null;
}

/** The digital products a customer owns, ready to render. */
export function ownedDigital(record: RecordLike | null | undefined, catalogue: DigitalProduct[]): OwnedDigital[] {
  const owned = ownedSlugs(record, 'digital_slugs');
  return (catalogue || [])
    .filter(p => p && owned.has(p.slug))
    .map(p => {
      const key = p.file?.r2_key || '';
      const filename = p.file?.filename || '';
      // Owned but not out yet: listed, with no files. Same reasoning as the
      // music side — download.ts refuses an undelivered key regardless, so
      // publishing it could only produce a button that 403s.
      const deliverable = digitalDeliverable(p);
      return {
        slug: p.slug,
        title: p.name,
        kind: p.kind || 'download',
        artwork: p.thumbnail || '',
        licence: licenceTerms(p),
        preorder: !deliverable,
        release_date: p.release_date || '',
        files: key && deliverable
          ? [{ key, filename, ext: (filename.split('.').pop() || '').toLowerCase() }]
          : [],
      };
    });
}
