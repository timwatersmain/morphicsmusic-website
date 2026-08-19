// One place every variant reads from, so comparing them is a comparison of
// DESIGN rather than of who happened to load which field.
import { read } from './build.mjs';

const events = read('src/data/events.json');
const epk = read('src/data/epk.json');
const catalog = read('src/data/music-catalog.json');

export const past = events.past || [];
export const releases = catalog.releases || [];
export const mgmt = epk.management || {};
export const bills = epk.notable_bills || [];
export const photos = epk.press_photos || [];

const years = past.map(e => Number(e.date.slice(0, 4)));
export const stats = {
  shows: past.length,
  span: `${Math.min(...years)}–${String(Math.max(...years)).slice(2)}`,
  states: new Set(past.map(e => (e.city || '').split(',').pop()?.trim()).filter(s => s?.length === 2)).size,
  festivals: past.filter(e => (e.date_display || '').includes('–')).length,
  releases: releases.length,
  headlines: past.filter(e => /headliner/i.test(e.role || '')).length,
  venues: new Set(past.map(e => e.venue).filter(Boolean)).size,
};

export const latest = releases[0] || {};
export const venues = [...new Set(past.map(e => e.venue).filter(Boolean))];

/** Album art by slug, captioned from the catalogue — never paired by index. */
export function plate(slug) {
  const rel = releases.find(r => r.slug === slug) || {};
  return { slug, src: `public/images/albums/${slug}.jpg`, title: rel.title || slug.replace(/-/g, ' '),
           type: (rel.type || '').toUpperCase(), year: String(rel.release_date || '').slice(0, 4) };
}

export const ACCENT = '#b9ff4a';   // sampled from SWAMP LOGIC
export const VIOLET = '#8f7ad6';   // sampled from PERCEPTION

export const PITCH = 'A style that is ever evolving, driven by the dramatic changes in life.';
export const SUB = 'Fusing elements from every genre into a listening or live experience built '
  + 'fresh each time — deep, and pitched at an esoteric niche rather than a format.';
