// Stage plot, drawn rather than photographed.
//
// The 2022 rider ended on a stock-photo collage of gear with coloured cable
// lines drawn over it. A production manager cannot work from that: it does
// not say where anything sits, how wide the booth needs to be, or what the
// house is actually being asked to patch. This is a plan view with the
// dimensions and the signal path stated.
//
// One diagram covers all three formats because the booth is the same
// footprint each time — only what sits on it changes, which is what the
// annotations carry.

export function stagePlot(accent = '#3df082') {
  const W = 168, H = 100;                      // mm, inside the page margins
  const t = (x, y, s, opts = {}) =>
    `<text x="${x}" y="${y}" fill="${opts.fill || '#cfcfcf'}" font-size="${opts.size || 2.6}"
       font-family="Rubik, sans-serif" font-weight="${opts.weight || 400}"
       letter-spacing="${opts.ls || 0}" text-anchor="${opts.anchor || 'start'}">${s}</text>`;

  // Booth: 2500mm of table is the real-world ask for this layout —
  //   3 x CDJ (453) + turntable (453) + DJM (332) + laptop (350) = 2494.
  // The far-right position is a TURNTABLE, and the laptop now sits ON the
  // table rather than floating beside it, which is what pushed the ask up
  // from the old 2200. Both numbers are stated in rider.json's notes too;
  // they have to move together.
  const bx = 24, by = 46, bw = 124, bh = 26;
  const deckW = 18.4, deckH = 18, gap = 2.2, lapW = 15;
  const decks = [];
  let dx = bx + 3;
  let mixerCx = 0;
  for (const label of ['CDJ', 'CDJ', 'DJM', 'CDJ', 'TT']) {
    const isMixer = label === 'DJM';
    const isDeck  = label === 'TT';
    if (isMixer) mixerCx = dx + deckW / 2;
    decks.push(`
      <rect x="${dx}" y="${by + 4}" width="${deckW}" height="${deckH}" rx="1"
            fill="${isMixer ? accent : 'none'}" fill-opacity="${isMixer ? .16 : 0}"
            stroke="${isMixer ? accent : '#7d7d7d'}" stroke-width=".4"/>`);

    if (isDeck) {
      // Drawn as a turntable, not just labelled as one: in a plan view a
      // production manager reads the platter and tonearm before the caption,
      // and the whole point of this position is that it is NOT another CDJ.
      const cx = dx + deckW / 2, cy = by + 14.5;
      decks.push(`
      <circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="#7d7d7d" stroke-width=".4"/>
      <circle cx="${cx}" cy="${cy}" r=".6" fill="#7d7d7d"/>
      <line x1="${dx + deckW - 2.6}" y1="${by + 7.4}" x2="${cx + 3.4}" y2="${cy - 2.6}"
            stroke="#7d7d7d" stroke-width=".4" stroke-linecap="round"/>
      ${t(cx, by + 7.6, 'TT', { anchor: 'middle', size: 2.6, weight: 700, fill: '#e8e8e8' })}`);
    } else {
      decks.push(t(dx + deckW / 2, by + 14.5, label, { anchor: 'middle', size: 2.9,
          weight: 700, fill: isMixer ? accent : '#e8e8e8' }));
    }
    dx += deckW + gap;
  }

  // Laptop: the last position on the table, and the reason the table grew.
  const lapX = dx;
  decks.push(`
      <rect x="${lapX}" y="${by + 4}" width="${lapW}" height="${deckH}" rx="1"
            fill="none" stroke="${accent}" stroke-width=".45" stroke-dasharray="1.6 1.2"/>
      ${t(lapX + lapW / 2, by + 11, 'LAPTOP', { anchor: 'middle', size: 2.4, fill: accent, weight: 700 })}
      ${t(lapX + lapW / 2, by + 14.6, '+ CTRL', { anchor: 'middle', size: 2.4, fill: accent, weight: 700 })}
      ${t(lapX + lapW / 2, by + 18.6, 'artist', { anchor: 'middle', size: 2.1, fill: '#7d7d7d' })}`);

  const monitor = (x, flip) => `
    <g transform="translate(${x},${by - 28}) ${flip ? 'scale(-1,1)' : ''}">
      <path d="M0 0 L9 -4 L9 10 L0 6 Z" fill="none" stroke="${accent}" stroke-width=".45"/>
      <line x1="4.5" y1="10" x2="4.5" y2="17" stroke="#6d6d6d" stroke-width=".4"/>
      <line x1="1" y1="17" x2="8" y2="17" stroke="#6d6d6d" stroke-width=".4"/>
    </g>`;

  return `
  <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
    <!-- stage edge -->
    <line x1="4" y1="${by + bh + 14}" x2="${W - 4}" y2="${by + bh + 14}"
          stroke="#3a3a3a" stroke-width=".5" stroke-dasharray="2 1.6"/>
    ${t(6, by + bh + 18, 'FRONT OF STAGE / AUDIENCE', { size: 2.3, ls: .5, fill: '#6d6d6d' })}

    <!-- booth -->
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="1"
          fill="#0e0e0e" stroke="#fff" stroke-width=".5"/>
    ${decks.join('')}
    ${t(bx + bw / 2, by - 3, 'BOOTH TABLE — 2500 × 700 mm MIN · 90–100 cm HIGH · STABLE', {
        anchor: 'middle', size: 2.4, ls: .4, fill: '#8d8d8d' })}

    <!-- monitors -->
    ${monitor(bx - 13, false)}
    ${monitor(bx + bw + 13, true)}
    ${t(bx - 8.5, by - 32, 'MONITOR', { anchor: 'middle', size: 2.3, ls: .3, fill: accent })}
    ${t(bx + bw + 8.5, by - 32, 'MONITOR', { anchor: 'middle', size: 2.3, ls: .3, fill: accent })}
    ${t(bx - 8.5, by - 7.5, '≤ 1 m, not on floor', { anchor: 'middle', size: 2.1, fill: '#8d8d8d' })}
    ${t(bx + bw + 8.5, by - 7.5, '≤ 1 m, not on floor', { anchor: 'middle', size: 2.1, fill: '#8d8d8d' })}

    <!-- signal path -->
    <path d="M${mixerCx} ${by + bh} L${mixerCx} ${by + bh + 9} L${W - 26} ${by + bh + 9}"
          fill="none" stroke="${accent}" stroke-width=".5"/>
    <polygon points="${W - 26},${by + bh + 9} ${W - 29},${by + bh + 7.6} ${W - 29},${by + bh + 10.4}"
             fill="${accent}"/>
    ${t(W - 24, by + bh + 10, 'TO FOH', { size: 2.5, weight: 700, fill: accent })}
    ${t(mixerCx + 2, by + bh + 7.4, 'balanced stereo out', { size: 2.3, fill: '#8d8d8d' })}

    <!-- power + fan -->
    <rect x="${bx + 2}" y="${by + bh + 4}" width="13" height="5" rx=".8"
          fill="none" stroke="#6d6d6d" stroke-width=".4"/>
    ${t(bx + 8.5, by + bh + 7.6, 'POWER ×4', { anchor: 'middle', size: 2.2, fill: '#9d9d9d' })}
    <circle cx="${bx + 21}" cy="${by + bh + 6.5}" r="3.2" fill="none"
            stroke="#6d6d6d" stroke-width=".4"/>
    ${t(bx + 21, by + bh + 7.4, 'FAN', { anchor: 'middle', size: 2.1, fill: '#9d9d9d' })}
  </svg>`;
}
