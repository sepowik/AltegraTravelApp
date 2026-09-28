import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otsuThreshold, findReceiptBox, withMargin } from '../js/crop.js';

// Synthetic greyscale "photos": background value, then shapes painted on top.
function image(w, h, bg, paint) {
  const g = new Uint8Array(w * h).fill(bg);
  paint((x, y, v) => { if (x >= 0 && y >= 0 && x < w && y < h) g[y * w + x] = v; });
  return g;
}
const rect = (set, x0, y0, rw, rh, v) => { for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) set(x, y, v); };
// Dark "text" lines on the paper (they must not break the receipt apart).
const textLines = (set, x0, y0, rw, rh) => { for (let y = y0 + 10; y < y0 + rh - 10; y += 8) rect(set, x0 + 8, y, rw - 30, 2, 40); };

test('otsu separates dark background and bright paper', () => {
  const g = image(100, 100, 60, (set) => rect(set, 30, 20, 40, 60, 230));
  const th = otsuThreshold(g);
  assert.ok(th >= 60 && th < 230, String(th));
});

test('finds an upright receipt on a dark table', () => {
  const g = image(300, 400, 70, (set) => { rect(set, 90, 40, 120, 320, 225); textLines(set, 90, 40, 120, 320); });
  assert.deepEqual(findReceiptBox(g, 300, 400), { x: 90, y: 40, w: 120, h: 320 });
});

test('finds a tilted receipt and ignores a small bright spot', () => {
  const w = 300; const h = 400;
  const g = image(w, h, 90, (set) => {
    rect(set, 5, 5, 20, 20, 250); // small glare in the corner
    const a = (10 * Math.PI) / 180; const cx = 150; const cy = 200;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x - cx; const dy = y - cy;
      const u = dx * Math.cos(a) + dy * Math.sin(a);
      const v = -dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(u) < 60 && Math.abs(v) < 150) set(x, y, 220);
    }
  });
  const box = findReceiptBox(g, w, h);
  assert.ok(box, 'box found');
  // A 120 × 300 rectangle rotated 10° spans about 170 × 316.
  assert.ok(box.x > 50 && box.x < 80 && box.w > 150 && box.w < 190, JSON.stringify(box));
  assert.ok(box.y > 30 && box.y < 60 && box.h > 300 && box.h < 330, JSON.stringify(box));
});

test('keeps the photo when there is no clear receipt', () => {
  // White receipt on a white table: no contrast.
  assert.equal(findReceiptBox(image(200, 200, 235, (set) => rect(set, 50, 50, 100, 100, 240)), 200, 200), null);
  // Receipt already fills the photo.
  assert.equal(findReceiptBox(image(200, 200, 60, (set) => rect(set, 2, 2, 196, 196, 230)), 200, 200), null);
  // Only a tiny bright thing.
  assert.equal(findReceiptBox(image(200, 200, 60, (set) => rect(set, 90, 90, 20, 20, 230)), 200, 200), null);
});

test('margin grows the box but stays inside the image', () => {
  assert.deepEqual(withMargin({ x: 90, y: 40, w: 120, h: 320 }, 300, 400), { x: 80, y: 30, w: 140, h: 340 });
  assert.deepEqual(withMargin({ x: 2, y: 3, w: 100, h: 390 }, 300, 400), { x: 0, y: 0, w: 114, h: 400 });
});

test('textDirection tells horizontal from sideways text', async () => {
  const { textDirection } = await import('../js/crop.js');
  const W = 240; const H = 320;
  // Paper with lines of "words": short dark runs with gaps, lines 14 px apart.
  const upright = image(W, H, 235, (set) => {
    for (let y = 30; y < H - 30; y += 14) {
      for (let x = 20; x < W - 20; x += 11) if ((x * 7 + y) % 5) rect(set, x, y, 8, 7, 30);
    }
  });
  assert.equal(textDirection(upright, W, H), 'horizontal');
  // The same page turned a quarter: transpose.
  const side = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) side[x * H + y] = upright[y * W + x];
  assert.equal(textDirection(side, H, W), 'vertical');
  // Blank paper: no answer.
  assert.equal(textDirection(new Uint8Array(W * H).fill(235), W, H), null);
});
