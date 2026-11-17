// Turns the pixel-art design ("Agent Office 도트 시안", tools/design/*.png, exported pre-scaled from the canvas)
// into the office's art: an empty room per theme, a people sheet, bubbles, monitor screens and public/art/art.json.
// Run after replacing tools/design/*.png with a new round of the design:  node tools/import-design.js
const fs = require('fs');
const path = require('path');
const { decode, encode } = require('./png');

const IN = path.join(__dirname, 'design');
const OUT = path.join(__dirname, '..', 'public', 'art');
const THEMES = ['day', 'night', 'wood'];
const POSES = ['idle', 'typeA', 'typeB', 'read', 'raise', 'sleep'];
const W = 192, H = 144;
// The design's office (1x). A desk is its partition's top-left; a person's 16x28 cell sits at (desk.x+17, desk.y-15).
const BOSS = { x: 73, y: 37, w: 46 };
const DESKS = [77, 117].flatMap(y => [7, 53, 99, 145].map(x => ({ x, y, w: 34 })));
const CELL = { w: 16, h: 28, dx: 17, dy: -15 };
const SCREEN = { dx: 3, dy: -1, w: 10, h: 6 };
const PLATE = { dx: 2, dy: 13, w: 30, h: 5 };
const OUTLINE = 0x22222cff; // bubbles are drawn with this colour
// what the day theme shows at each desk (to name the bubbles and screens we cut out of it)
const SHOWN = { boss: 'delegate', 0: 'edit', 1: 'read', 3: 'ask', 4: 'run', 6: 'think', 2: 'off' };
const PLATES = { 0: 'EXPLORE', 1: 'PLAN', 3: 'REVIEW', 4: 'TESTER', 5: 'EXPLORE', 6: 'GENERAL' };

// ---- tiny image helpers (RGBA, colours as uint32 0xRRGGBBAA) ----
const img = (w, h) => ({ w, h, px: Buffer.alloc(w * h * 4) });
const get = (im, x, y) => (x < 0 || y < 0 || x >= im.w || y >= im.h ? 0 : im.px.readUInt32BE((y * im.w + x) * 4));
const put = (im, x, y, c) => { if (x >= 0 && y >= 0 && x < im.w && y < im.h) im.px.writeUInt32BE(c >>> 0, (y * im.w + x) * 4); };
const opaque = c => (c & 255) > 0;
const hex = c => '#' + (c >>> 8).toString(16).padStart(6, '0');
const lum = c => (0.3 * (c >>> 24) + 0.59 * ((c >>> 16) & 255) + 0.11 * ((c >>> 8) & 255)) / 255;
function crop(im, x, y, w, h) { const o = img(w, h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(o, i, j, get(im, x + i, y + j)); return o; }
function paste(dst, src, x, y) { for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) { const c = get(src, i, j); if (opaque(c)) put(dst, x + i, y + j, c); } }
function load(name, scale) {
  const big = decode(fs.readFileSync(path.join(IN, name + '.png'))), im = img(big.w / scale, big.h / scale);
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) put(im, x, y, get(big, x * scale, y * scale));
  return im;
}
const save = (name, im) => fs.writeFileSync(path.join(OUT, name), encode(im));
function mode(colors) { const n = new Map(); let best = 0, top = 0; for (const c of colors) { const k = (n.get(c) || 0) + 1; n.set(c, k); if (k > top) { top = k; best = c; } } return best; }

// Make the background transparent: every pixel in a colour found on the border, including gaps it shows through
// (between legs, under an arm), which would otherwise keep the day theme's floor in the night.
let keyedInside = 0;
function keyOut(im) {
  const bg = new Set();
  for (let x = 0; x < im.w; x++) bg.add(get(im, x, 0)).add(get(im, x, im.h - 1));
  for (let y = 0; y < im.h; y++) bg.add(get(im, 0, y)).add(get(im, im.w - 1, y));
  const seen = new Uint8Array(im.w * im.h), stack = [];
  for (let x = 0; x < im.w; x++) stack.push(x, 0, x, im.h - 1);
  for (let y = 0; y < im.h; y++) stack.push(0, y, im.w - 1, y);
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= im.w || y >= im.h || seen[y * im.w + x] || !bg.has(get(im, x, y))) continue;
    seen[y * im.w + x] = 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) if (bg.has(get(im, x, y))) { if (!seen[y * im.w + x]) keyedInside++; put(im, x, y, 0); }
  return im;
}

// How badly a sprite disagrees with the scene at (x, y): share of its opaque pixels that differ.
function mismatch(scene, sprite, x, y) {
  let n = 0, bad = 0;
  for (let j = 0; j < sprite.h; j++) for (let i = 0; i < sprite.w; i++) { const c = get(sprite, i, j); if (opaque(c)) { n++; if (get(scene, x + i, y + j) !== c) bad++; } }
  return n ? bad / n : 1;
}

// ---- people: 10 rows x 6 poses in the pose sheet (22x28 cells) -> 16x28 sprites ----
const sheet = load('poses', 4);
const people = Array.from({ length: 10 }, (_, r) => POSES.map((_, c) => {
  const cell = keyOut(crop(sheet, c * 22, r * 28, 22, 28));
  for (let y = 0; y < 28; y++) for (const x of [0, 1, 2, 19, 20, 21]) if (opaque(get(cell, x, y))) console.warn(`person ${r} pose ${c}: pixel outside the 16px cell at ${x},${y}`);
  return crop(cell, 3, 0, CELL.w, CELL.h);
}));

// Boss outfits per model: the design draws them idle only. Other poses = the Sonnet boss's pose with the outfit's
// colours swapped in, and its details (tie, logo, hat, trim) pasted where that pose looks like idle.
const sonnet = people[0];
const castAt = (() => { // where the 24x30 cast images sit on our 16x28 cells
  const cast = keyOut(load('boss-sonnet', 6));
  let best = { score: 2 };
  for (let oy = -6; oy <= 6; oy++) for (let ox = -8; ox <= 4; ox++) {
    const s = mismatch(sonnet[0], crop(cast, -ox, -oy, CELL.w, CELL.h), 0, 0) + mismatch(crop(cast, -ox, -oy, CELL.w, CELL.h), sonnet[0], 0, 0);
    if (s < best.score) best = { score: s, ox, oy };
  }
  console.log(`cast images align at ${best.ox},${best.oy} (mismatch ${best.score.toFixed(3)})`);
  return best;
})();
function outfit(name) {
  const idle = crop(keyOut(load('boss-' + name, 6)), -castAt.ox, -castAt.oy, CELL.w, CELL.h), base = sonnet[0];
  const votes = new Map(), decal = [];
  for (let y = 0; y < CELL.h; y++) for (let x = 0; x < CELL.w; x++) {
    const s = get(base, x, y), v = get(idle, x, y);
    if (opaque(s) && opaque(v)) { const k = votes.get(s) || []; k.push(v); votes.set(s, k); }
  }
  const swap = new Map(); // a Sonnet colour that mostly turned into one outfit colour
  for (const [s, vs] of votes) { const m = mode(vs); if (m !== s && vs.filter(v => v === m).length / vs.length >= 0.5) swap.set(s, m); }
  for (let y = 0; y < CELL.h; y++) for (let x = 0; x < CELL.w; x++) {
    const s = get(base, x, y), v = get(idle, x, y);
    if (opaque(v) && v !== (swap.get(s) ?? s)) decal.push([x, y, v]);
  }
  const hairTop = im => { for (let y = 0; y < CELL.h; y++) for (let x = 0; x < CELL.w; x++) if (opaque(get(im, x, y))) return y; return 0; };
  return sonnet.map((pose, p) => {
    const out = crop(pose, 0, 0, CELL.w, CELL.h);
    for (let y = 0; y < CELL.h; y++) for (let x = 0; x < CELL.w; x++) { const c = get(out, x, y); if (swap.has(c)) put(out, x, y, swap.get(c)); }
    const lift = POSES[p] === 'sleep' ? hairTop(pose) - hairTop(base) : 0; // the head goes down to the desk
    for (const [x, y, v] of decal) {
      const hat = y < hairTop(base) + 3;
      if (lift && !hat) continue; // asleep: only the hat follows the head; the chest is on the desk
      if (lift || get(pose, x, y) === get(base, x, y)) put(out, x, y + lift, v);
    }
    return out;
  });
}
const OUTFITS = ['opus', 'haiku', 'fable'];
const sheetRows = [...people, ...OUTFITS.map(outfit)];
const peopleImg = img(CELL.w * POSES.length, CELL.h * sheetRows.length);
sheetRows.forEach((row, r) => row.forEach((s, c) => paste(peopleImg, s, c * CELL.w, r * CELL.h)));

const standing = keyOut(load('temp-standing', 6));
// each person's clothing colour (the roster's dot): the commonest colour of the idle chest
const clothes = sheetRows.map(row => { const cs = []; for (let y = 17; y < 23; y++) for (let x = 3; x < 13; x++) { const c = get(row[0], x, y); if (opaque(c)) cs.push(c); } return hex(mode(cs)); });

// ---- rooms: the design's office with every person, bubble, Zz, plate letter and lit screen taken out ----
fs.mkdirSync(OUT, { recursive: true });
const art = {
  size: [W, H], cell: [CELL.w, CELL.h], poses: POSES,
  people: { file: 'people.png', rows: { boss: 0, staff: [1, 2, 3, 4, 5, 6, 7, 8], temp: 9, opus: 10, haiku: 11, fable: 12 }, clothes },
  standing: { file: 'standing.png', w: standing.w, h: standing.h },
  themes: {}, bubbles: { file: 'bubbles.png', items: {} }, screens: { file: 'screens.png', w: SCREEN.w, h: SCREEN.h, items: [] },
  glyphs: {},
};
save('standing.png', standing);
save('people.png', peopleImg);

// Everything that moves is found once, on the day theme: the themes share one layout and differ only in colour.
const day = load('theme-day', 3);
const marks = new Map(); // pixel index -> how to repaint it
const mark = (x, y, rule) => { if (x >= 0 && y >= 0 && x < W && y < H) marks.set(y * W + x, rule); };
const seated = [{ desk: BOSS, row: people[0], key: 'boss' }, ...DESKS.map((desk, i) => ({ desk, row: people[i + 1], key: i }))];
const poseAt = {};
{
  const room = day;
  // people at desks: find the pose the design shows, then take out exactly its pixels
  for (const { desk, row, key } of seated) {
    const sx = desk.x + CELL.dx, sy = desk.y + CELL.dy;
    const scored = row.map((s, p) => [mismatch(room, s, sx, sy), p]).sort((a, b) => a[0] - b[0]);
    const [score, p] = scored[0];
    poseAt[key] = p;
    if (score > 0.02) console.warn(`desk ${key}: best pose ${POSES[p]} still differs by ${(score * 100).toFixed(1)}%`);
    for (let j = 0; j < CELL.h; j++) for (let i = 0; i < CELL.w; i++) if (opaque(get(row[p], i, j))) mark(sx + i, sy + j, { desk });
  }

  // the temp standing by the boss
  let best = { score: 2 };
  for (let y = 10; y < 60; y++) for (let x = 120; x < 170; x++) { const s = mismatch(room, standing, x, y); if (s < best.score) best = { score: s, x, y }; }
  art.standing.at = [best.x, best.y];
  console.log(`temp stands at ${best.x},${best.y} (mismatch ${best.score.toFixed(3)})`);
  // the design draws this temp's shoes differently from the sprite: clear everything in its box that isn't floor/wall
  for (let j = 0; j < standing.h; j++) {
    const y = best.y + j, row = mode(Array.from({ length: W }, (_, x) => get(room, x, y)));
    for (let i = 0; i < standing.w; i++) if (opaque(get(standing, i, j)) || get(room, best.x + i, y) !== row) mark(best.x + i, y, 'local');
  }

  // bubbles: outline pieces joined corner to corner (rounded corners), big enough not to be eyes
  const seen = new Uint8Array(W * H);
  for (let y0 = 0; y0 < H; y0++) for (let x0 = 0; x0 < W; x0++) {
    if (seen[y0 * W + x0] || get(room, x0, y0) !== OUTLINE) continue;
    const comp = [], stack = [x0, y0];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (x < 0 || y < 0 || x >= W || y >= H || seen[y * W + x] || get(room, x, y) !== OUTLINE) continue;
      seen[y * W + x] = 1; comp.push([x, y]);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) stack.push(x + dx, y + dy);
    }
    if (comp.length < 16) continue;
    const xs = comp.map(p => p[0]), ys = comp.map(p => p[1]);
    const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx + 1, bh = Math.max(...ys) - by + 1;
    // inside the outline = not reachable from the box's border without crossing it
    const box = crop(room, bx, by, bw, bh), inside = img(bw, bh);
    const out = new Uint8Array(bw * bh), st = [];
    for (let x = 0; x < bw; x++) st.push(x, 0, x, bh - 1);
    for (let y = 0; y < bh; y++) st.push(0, y, bw - 1, y);
    while (st.length) {
      const y = st.pop(), x = st.pop();
      if (x < 0 || y < 0 || x >= bw || y >= bh || out[y * bw + x] || get(box, x, y) === OUTLINE) continue;
      out[y * bw + x] = 1;
      st.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (!out[y * bw + x]) { put(inside, x, y, get(box, x, y)); mark(bx + x, by + y, 'local'); }
    // name it after the desk (or the temp) it floats over
    const cx = bx + bw / 2, owners = [...seated.map(s => ({ key: s.key, x: s.desk.x + CELL.dx + 8, y: s.desk.y + CELL.dy })), { key: 'temp', x: best.x + standing.w / 2, y: best.y }];
    const owner = owners.sort((a, b) => Math.hypot(a.x - cx, a.y - by) - Math.hypot(b.x - cx, b.y - by))[0];
    const name = owner.key === 'temp' ? 'wake' : SHOWN[owner.key];
    // an icon drawn in the outline colour (the terminal) is a component of its own inside the bubble: keep the bubble
    if (name && !(art.bubbles.items[name]?.w >= bw)) art.bubbles.items[name] = { img: inside, w: bw, h: bh };
  }

  // Zz floating over sleepers: light pixels in the air above-right of their heads
  for (const { desk, key } of seated) {
    if (POSES[poseAt[key]] !== 'sleep') continue;
    const sx = desk.x + CELL.dx, sy = desk.y + CELL.dy;
    for (let y = sy - 4; y < desk.y; y++) for (let x = sx + 8; x < sx + 28; x++) if (lum(get(room, x, y)) > 0.84 && !marks.has(y * W + x)) mark(x, y, 'local'); // floor is ~0.75
  }

  // learn the plate font from what the design spells (the boss's CLAUDE plate stays as drawn)
  for (const [i, word] of Object.entries(PLATES)) {
    const d = DESKS[i], cols = [];
    const bg = mode(Array.from({ length: PLATE.w * PLATE.h }, (_, k) => get(room, d.x + PLATE.dx + (k % PLATE.w), d.y + PLATE.dy + ((k / PLATE.w) | 0))));
    for (let x = 0; x < PLATE.w; x++) cols.push(Array.from({ length: PLATE.h }, (_, y) => (get(room, d.x + PLATE.dx + x, d.y + PLATE.dy + y) !== bg ? '1' : '0')).join(''));
    const letters = [];
    let cur = [];
    for (const c of [...cols, '00000']) { if (c === '00000') { if (cur.length) letters.push(cur); cur = []; } else cur.push(c); }
    if (letters.length !== word.length) { console.warn(`plate ${word}: found ${letters.length} letters`); continue; }
    letters.forEach((l, k) => { art.glyphs[word[k]] = Array.from({ length: PLATE.h }, (_, y) => l.map(col => col[y]).join('')); });
  }

  // lit screens, one per state the design shows
  for (const [key, name] of Object.entries(SHOWN)) { const d = key === 'boss' ? BOSS : DESKS[key]; art.screens.items.push({ name, img: crop(room, d.x + SCREEN.dx, d.y + SCREEN.dy, SCREEN.w, SCREEN.h) }); }
  console.log('desks show', Object.entries(poseAt).map(([k, p]) => `${k}:${POSES[p]}`).join(' '));
}

let nightTone; // night dims people too (bubbles stay bright): a per-channel gain learned from the person pixels
for (const theme of THEMES) {
  const room = load('theme-' + theme, 3);
  if (theme === 'night') {
    const sum = [0, 0, 0, 0, 0, 0];
    for (const [k, rule] of marks) if (rule.desk) {
      const a = day.px.readUInt32BE(k * 4), b = room.px.readUInt32BE(k * 4);
      for (let ch = 0; ch < 3; ch++) { const da = (a >>> (24 - 8 * ch)) & 255, db = (b >>> (24 - 8 * ch)) & 255; sum[ch] += da * db; sum[ch + 3] += da * da; }
    }
    nightTone = [0, 1, 2].map(ch => sum[ch] / sum[ch + 3]);
  }
  const plateInk = (() => { const d = DESKS[0]; const cs = []; for (let k = 0; k < PLATE.w * PLATE.h; k++) cs.push(get(room, d.x + PLATE.dx + (k % PLATE.w), d.y + PLATE.dy + ((k / PLATE.w) | 0))); const bg = mode(cs); return mode(cs.filter(c => c !== bg)); })();
  const off = crop(room, DESKS[2].x + SCREEN.dx, DESKS[2].y + SCREEN.dy, SCREEN.w, SCREEN.h); // a sleeper's screen is off
  for (const d of DESKS) {
    const cs = [];
    for (let y = 0; y < PLATE.h; y++) for (let x = 0; x < PLATE.w; x++) cs.push(get(room, d.x + PLATE.dx + x, d.y + PLATE.dy + y));
    const bg = mode(cs);
    for (let y = 0; y < PLATE.h; y++) for (let x = 0; x < PLATE.w; x++) put(room, d.x + PLATE.dx + x, d.y + PLATE.dy + y, bg);
  }
  for (const d of [BOSS, ...DESKS]) paste(room, off, d.x + SCREEN.dx, d.y + SCREEN.dy);

  // repaint: a seated person's pixels with the partition/desk behind them, the rest with the row's own colour nearby
  const kept = (x, y) => !marks.has(y * W + x);
  for (const [k, rule] of marks) {
    const x = k % W, y = (k / W) | 0;
    let c;
    if (rule.desk && y >= rule.desk.y) c = get(room, rule.desk.x + rule.desk.w - (y > rule.desk.y + 8 ? 4 : 1), y);
    else if (rule.desk) { // behind a head: the row's own floor/wall colour (nearby, the monitor would win)
      const row = [];
      for (let xx = 0; xx < W; xx++) if (kept(xx, y)) row.push(get(room, xx, y));
      c = mode(row);
    } else {
      const near = [];
      for (let dx = -12; dx <= 12; dx++) if (kept(x + dx, y) && x + dx >= 0 && x + dx < W) near.push(get(room, x + dx, y));
      c = near.length ? mode(near) : get(room, x, y);
    }
    put(room, x, y, c);
  }
  save(`room-${theme}.png`, room);
  art.themes[theme] = { room: `room-${theme}.png`, plateInk: hex(plateInk) };
  if (theme === 'night') {
    const dim = src => { const o = crop(src, 0, 0, src.w, src.h); for (let i = 0; i < o.w * o.h; i++) { const c = o.px.readUInt32BE(i * 4); if (!opaque(c)) continue; const ch = [0, 1, 2].map(n => Math.min(255, Math.round(((c >>> (24 - 8 * n)) & 255) * nightTone[n]))); o.px.writeUInt32BE(((ch[0] << 24) | (ch[1] << 16) | (ch[2] << 8) | (c & 255)) >>> 0, i * 4); } return o; };
    save('people-night.png', dim(peopleImg));
    save('standing-night.png', dim(standing));
    Object.assign(art.themes.night, { people: 'people-night.png', standing: 'standing-night.png' });
    console.log('night tone (r,g,b gain):', nightTone.map(g => g.toFixed(3)).join(', '));
  }
}

// pack bubbles side by side, screens in a row
const bubbles = Object.entries(art.bubbles.items);
const sheetW = bubbles.reduce((s, [, b]) => s + b.w + 1, 0), sheetH = Math.max(...bubbles.map(([, b]) => b.h));
const bubbleImg = img(sheetW, sheetH);
let bx = 0;
for (const [name, b] of bubbles) { paste(bubbleImg, b.img, bx, 0); art.bubbles.items[name] = { x: bx, y: 0, w: b.w, h: b.h }; bx += b.w + 1; }
save('bubbles.png', bubbleImg);
const screenImg = img(SCREEN.w * art.screens.items.length, SCREEN.h);
art.screens.items = art.screens.items.map((s, i) => { paste(screenImg, s.img, i * SCREEN.w, 0); return s.name; });
save('screens.png', screenImg);
fs.writeFileSync(path.join(OUT, 'art.json'), JSON.stringify(art, null, 2) + '\n');
console.log(`sprites: ${keyedInside} enclosed background pixels made transparent`);
console.log('bubbles:', Object.keys(art.bubbles.items).join(', '), '| screens:', art.screens.items.join(', '), '| glyphs:', Object.keys(art.glyphs).sort().join(''));
