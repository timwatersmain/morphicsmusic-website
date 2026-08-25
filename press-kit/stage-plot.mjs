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

  // Booth: 2200mm of table is the real-world ask for a four-deck layout.
  const bx = 30, by = 46, bw = 108, bh = 26;
  const deckW = 18.4, deckH = 18, gap = 2.2;
  const decks = [];
  let dx = bx + 4;
  for (const label of ['CDJ', 'CDJ', 'DJM', 'CDJ', 'CDJ']) {
    const isMixer = label === 'DJM';
    decks.push(`
      <rect x="${dx}" y="${by + 4}" width="${deckW}" height="${deckH}" rx="1"
            fill="${isMixer ? accent : 'none'}" fill-opacity="${isMixer ? .16 : 0}"
            stroke="${isMixer ? accent : '#7d7d7d'}" stroke-width=".4"/>
      ${t(dx + deckW / 2, by + 14.5, label, { anchor: 'middle', size: 2.9,
          weight: 700, fill: isMixer ? accent : '#e8e8e8' })}`);
    dx += deckW + gap;
  }

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
    ${t(bx + bw / 2, by - 3, 'BOOTH TABLE — 2200 × 700 mm MIN · 90–100 cm HIGH · STABLE', {
        anchor: 'middle', size: 2.4, ls: .4, fill: '#8d8d8d' })}

    <!-- laptop + controller, the Ableton / A-V position -->
    <rect x="${bx + bw + 5}" y="${by + 4}" width="20" height="13" rx="1"
          fill="none" stroke="${accent}" stroke-width=".45" stroke-dasharray="1.6 1.2"/>
    ${t(bx + bw + 15, by + 11.5, 'LAPTOP +', { anchor: 'middle', size: 2.4, fill: accent, weight: 700 })}
    ${t(bx + bw + 15, by + 14.6, 'CONTROLLERS', { anchor: 'middle', size: 2.4, fill: accent, weight: 700 })}
    ${t(bx + bw + 15, by + 21, 'artist provides', { anchor: 'middle', size: 2.2, fill: '#7d7d7d' })}

    <!-- monitors -->
    ${monitor(bx - 14, false)}
    ${monitor(bx + bw + 14, true)}
    ${t(bx - 9.5, by - 32, 'MONITOR', { anchor: 'middle', size: 2.3, ls: .3, fill: accent })}
    ${t(bx + bw + 9.5, by - 32, 'MONITOR', { anchor: 'middle', size: 2.3, ls: .3, fill: accent })}
    ${t(bx - 9.5, by - 7.5, '≤ 1 m, not on floor', { anchor: 'middle', size: 2.1, fill: '#8d8d8d' })}
    ${t(bx + bw + 9.5, by - 7.5, '≤ 1 m, not on floor', { anchor: 'middle', size: 2.1, fill: '#8d8d8d' })}

    <!-- signal path -->
    <path d="M${bx + bw / 2 + 8} ${by + bh} L${bx + bw / 2 + 8} ${by + bh + 9} L${W - 26} ${by + bh + 9}"
          fill="none" stroke="${accent}" stroke-width=".5"/>
    <polygon points="${W - 26},${by + bh + 9} ${W - 29},${by + bh + 7.6} ${W - 29},${by + bh + 10.4}"
             fill="${accent}"/>
    ${t(W - 24, by + bh + 10, 'TO FOH', { size: 2.5, weight: 700, fill: accent })}
    ${t(bx + bw / 2 + 10, by + bh + 7.4, 'balanced stereo out', { size: 2.3, fill: '#8d8d8d' })}

    <!-- power + fan -->
    <rect x="${bx + 2}" y="${by + bh + 4}" width="13" height="5" rx=".8"
          fill="none" stroke="#6d6d6d" stroke-width=".4"/>
    ${t(bx + 8.5, by + bh + 7.6, 'POWER ×4', { anchor: 'middle', size: 2.2, fill: '#9d9d9d' })}
    <circle cx="${bx + 21}" cy="${by + bh + 6.5}" r="3.2" fill="none"
            stroke="#6d6d6d" stroke-width=".4"/>
    ${t(bx + 21, by + bh + 7.4, 'FAN', { anchor: 'middle', size: 2.1, fill: '#9d9d9d' })}
  </svg>`;
}
