// Handles are derived from the display name and are the ONLY fan-facing
// identifier — email never leaves the server.

const MAX_HANDLE = 32;
const MIN_NAME = 2;
const MAX_NAME = 40;

// Names that would let someone impersonate the artist or staff, plus every
// path segment used under /community so a handle can never shadow a real
// route. Add to this list rather than inventing a second check elsewhere.
const BLOCKED = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'support', 'staff', 'official',
  'morphics', 'morphicsmusic', 'root', 'system', 'null', 'undefined',
  'me', 'u', 'community', 'login', 'library', 'store', 'music', 'visuals',
  'social', 'download', 'api', 'unlock',
]);

export function slugifyHandle(input: string): string {
  const slug = (input || '')
    .normalize('NFKD')                    // decompose accents into base + mark
    .replace(/[\u0300-\u036f]/g, '')      // strip the combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')       // everything else becomes a separator
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_HANDLE)
    .replace(/-$/, '');                // slicing may have left a trailing dash
  return slug || 'fan';
}

export function isValidDisplayName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME || trimmed.length > MAX_NAME) return false;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  return true;
}

export function isBlockedName(name: string): boolean {
  return BLOCKED.has(slugifyHandle(name));
}

/**
 * First free handle for `base`. `taken` is injected so this stays a pure
 * function over an async predicate and can be tested without a database.
 */
export async function nextAvailableHandle(
  base: string,
  taken: (handle: string) => Promise<boolean>,
): Promise<string> {
  const root = slugifyHandle(base);
  if (!(await taken(root))) return root;
  for (let n = 2; n <= 50; n++) {
    const candidate = `${root}-${n}`.slice(0, MAX_HANDLE);
    if (!(await taken(candidate))) return candidate;
  }
  // Pathological contention. A random suffix ends the loop rather than
  // spinning; collision odds at this point are negligible.
  // padStart(2) matters: base36 of a byte under 36 is a SINGLE char, so an
  // unpadded join can be shorter than 6 and the slice below would silently
  // return a short suffix (~1% of calls). Pad first, then slice.
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 6);
  return `${root}-${rand}`;
}
