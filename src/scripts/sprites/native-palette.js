// The sentinel colourway value meaning "render this sprite in its own
// authored palette" (sprite.palette, per vendor/README.txt's SPRITE FORMAT)
// instead of one of the 12 named colourways from vendor/colorways.js.
//
// Deliberately a distinct explicit string, never NULL: NULL already means
// "this fan has never chosen a colourway" (falls back to their
// deterministically assigned one — see functions/_lib/community/sprites.ts's
// assignColourway). This is a different state — an explicit opt-in choice —
// so it gets its own value rather than overloading NULL to mean two things.
//
// This one file is imported by BOTH the client (renderer.js, creature-avatar
// picker in me.astro) and the Workers-side validator
// (functions/_lib/community/sprites.ts's isValidColourway), so the two can
// never drift apart the way two separately hand-typed 'native' literals
// eventually would.
export const NATIVE_COLOURWAY = 'native';
