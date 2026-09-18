// Fetches the latest track/album from Morphics Bandcamp at build time
// and writes the embed data to src/data/bandcamp-latest.json

const BANDCAMP_URL = 'https://morphics.bandcamp.com/music';
const BAND_ID = 682291013;

// Bandcamp is scraped, not an API — when its markup shifts, keep the committed
// bandcamp-latest.json rather than failing the whole Pages build (2026-09-18:
// links moved into escaped JSON and every deploy failed here).
function keepCommitted() {
  console.log('• Bandcamp fetch failed — leaving src/data/bandcamp-latest.json as committed');
}

async function fetchLatest() {
  try {
    const res = await fetch(BANDCAMP_URL);
    const html = await res.text();

    // Find the first track or album link (latest release)
    const trackMatch = html.match(/\/track\/([a-z0-9-]+)/);
    const albumMatch = html.match(/\/album\/([a-z0-9-]+)/);

    // Try latest track first
    let type = 'track';
    let slug = trackMatch?.[1];

    // If no track, try album
    if (!slug && albumMatch) {
      type = 'album';
      slug = albumMatch[1];
    }

    if (!slug) {
      console.error('No tracks or albums found on Bandcamp page');
      return keepCommitted();
    }

    // Fetch the track/album page to get the numeric ID
    const itemUrl = `https://morphics.bandcamp.com/${type}/${slug}`;
    const itemRes = await fetch(itemUrl);
    const itemHtml = await itemRes.text();

    const idMatch = itemHtml.match(new RegExp(`${type}=(\\d+)`));
    const numericId = idMatch?.[1];

    if (!numericId) {
      console.error(`Could not find numeric ID for ${type}/${slug}`);
      return keepCommitted();
    }

    // Extract title
    const titleMatch = itemHtml.match(/<title>\s*([^|<]+)/);
    const title = titleMatch?.[1]?.trim() || slug;

    const data = {
      type,
      slug,
      numericId,
      title,
      embedUrl: `https://bandcamp.com/EmbeddedPlayer/${type}=${numericId}/size=large/bgcol=131313/linkcol=00f0ff/tracklist=false/artwork=small/transparent=true/`,
      pageUrl: itemUrl,
      fetchedAt: new Date().toISOString(),
    };

    const fs = await import('fs');
    const path = await import('path');
    const outPath = path.join(import.meta.dirname, '..', 'src', 'data', 'bandcamp-latest.json');
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`Fetched latest ${type}: "${title}" (ID: ${numericId})`);
    console.log(`Saved to ${outPath}`);
  } catch (err) {
    console.error('Failed to fetch Bandcamp data:', err.message);
    return keepCommitted();
  }
}

fetchLatest();
