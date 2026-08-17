// VENDORED, UNMODIFIED — exported from the owner's Sprite Lab tool
// (/Users/morphics/Downloads/export/colorways.js). Do not "improve" or
// rewrite this file; regenerate it from the source tool instead. See
// ./README.txt for the full contract.
//
// SPRITE LAB — 12 colourways. Any sprite can wear any of these.
// Keys map to the sprite grid characters: 1 darkest, 2 mid, 3 light, 4 accent.
export const COLORWAYS = [
  { id: 'crimson', name: 'CRIMSON', p: ['#3d0f14', '#b32334', '#f08a92', '#ffe36a'] },
  { id: 'ember',   name: 'EMBER',   p: ['#42190a', '#c8541a', '#f5a35a', '#ffe08a'] },
  { id: 'amber',   name: 'AMBER',   p: ['#3f2c07', '#c48a12', '#f5d472', '#fff4b0'] },
  { id: 'citron',  name: 'CITRON',  p: ['#33380a', '#a8bc1e', '#e4ef86', '#fffbc0'] },
  { id: 'leaf',    name: 'LEAF',    p: ['#123312', '#37a83c', '#9ce89e', '#f2ff9c'] },
  { id: 'jade',    name: 'JADE',    p: ['#0d3327', '#1ea877', '#8ce8c4', '#e8fff0'] },
  { id: 'cyan',    name: 'CYAN',    p: ['#0c3038', '#199aad', '#8ae2ee', '#ffffff'] },
  { id: 'azure',   name: 'AZURE',   p: ['#0d2440', '#1f6fc4', '#8cc0f2', '#ffe36a'] },
  { id: 'indigo',  name: 'INDIGO',  p: ['#181c44', '#3a44c4', '#9aa2f0', '#ffd45a'] },
  { id: 'violet',  name: 'VIOLET',  p: ['#28134a', '#7b34cc', '#c39cf2', '#ffe08a'] },
  { id: 'magenta', name: 'MAGENTA', p: ['#3c0f3a', '#b524ab', '#f08ae8', '#ffe8a0'] },
  { id: 'rose',    name: 'ROSE',    p: ['#3d0f24', '#c02463', '#f68ab4', '#ffe8b0'] }
];
export const paletteOf = cw => ({ '.': null, '1': cw.p[0], '2': cw.p[1], '3': cw.p[2], '4': cw.p[3] });
