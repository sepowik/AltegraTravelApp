// Automatic cropping of receipt photos to the paper plus a small margin. Runs on the
// phone. findReceiptBox is pure (unit tested); cropReceipt does the canvas work.

// Otsu's method: the grey level that best separates dark background from bright paper.
export function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0; let wB = 0; let best = 0; let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/*
 * Finds the receipt in a small greyscale image (Uint8Array, row-major, w × h): the largest
 * connected bright region. Returns {x, y, w, h} in the same pixel units, or null when there
 * is no clear receipt (too small, almost the whole image, or too little contrast), in
 * which case the photo should be kept as it is.
 */
export function findReceiptBox(gray, w, h) {
  const t = otsuThreshold(gray);
  // Paper and background must differ clearly.
  let bright = 0; let dark = 0; let nb = 0; let nd = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] > t) { bright += gray[i]; nb++; } else { dark += gray[i]; nd++; }
  }
  if (!nb || !nd || bright / nb - dark / nd < 40) return null;

  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = gray[i] > t ? 1 : 0;
  // Largest 4-connected bright component (iterative flood fill).
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best = null;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0; stack[top++] = start; seen[start] = 1;
    let count = 0; let minX = w; let minY = h; let maxX = 0; let maxY = 0;
    while (top) {
      const p = stack[--top];
      count++;
      const x = p % w; const y = (p - x) / w;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[top++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[top++] = p + w; }
    }
    if (!best || count > best.count) best = { count, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  if (!best) return null;
  const boxArea = best.w * best.h;
  const imgArea = w * h;
  // Too small to be the receipt, or nothing to cut away.
  if (boxArea < imgArea * 0.06 || boxArea > imgArea * 0.92) return null;
  // The paper should fill a fair part of its box (a tilted receipt fills about half).
  if (best.count < boxArea * 0.35) return null;
  return { x: best.x, y: best.y, w: best.w, h: best.h };
}

// Box grown by a margin (a share of its larger side, at least minPx), kept inside the image.
export function withMargin(box, imgW, imgH, share = 0.03, minPx = 6) {
  const m = Math.max(minPx, Math.round(Math.max(box.w, box.h) * share));
  const x = Math.max(0, box.x - m);
  const y = Math.max(0, box.y - m);
  return { x, y, w: Math.min(imgW, box.x + box.w + m) - x, h: Math.min(imgH, box.y + box.h + m) - y };
}

const ANALYSIS_SIDE = 360;

// Crops a photo File/Blob to the receipt. Resolves { blob, box } or null when the photo
// should be kept as it is (no clear receipt, not an image, or the browser can't decode it).
export async function cropReceipt(file) {
  if (!file.type?.startsWith('image/') || file.type === 'image/gif') return null;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  const scale = Math.min(1, ANALYSIS_SIDE / Math.max(bmp.width, bmp.height));
  const sw = Math.max(1, Math.round(bmp.width * scale));
  const sh = Math.max(1, Math.round(bmp.height * scale));
  const small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(bmp, 0, 0, sw, sh);
  const { data } = sctx.getImageData(0, 0, sw, sh);
  const gray = new Uint8Array(sw * sh);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  const found = findReceiptBox(gray, sw, sh);
  if (!found) return null;
  const m = withMargin(found, sw, sh);
  const box = {
    x: Math.round(m.x / scale), y: Math.round(m.y / scale),
    w: Math.min(bmp.width, Math.round(m.w / scale)), h: Math.min(bmp.height, Math.round(m.h / scale)),
  };
  const out = document.createElement('canvas');
  out.width = box.w; out.height = box.h;
  out.getContext('2d').drawImage(bmp, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.9));
  return blob ? { blob, box, width: bmp.width, height: bmp.height } : null;
}

/*
 * Which way the lines of text run in a greyscale image of a (cropped) receipt:
 * 'horizontal' (readable or upside down), 'vertical' (photo is sideways) or null when
 * unclear. Lines of text leave blank rows between them, so the profile of dark pixels
 * per row is far more uneven than per column; for sideways text it is the other way round.
 * Only the inner part is used so the margin around the paper does not count.
 */
export function textDirection(gray, w, h) {
  const x0 = Math.round(w * 0.1); const x1 = Math.round(w * 0.9);
  const y0 = Math.round(h * 0.1); const y1 = Math.round(h * 0.9);
  const iw = x1 - x0; const ih = y1 - y0;
  if (iw < 20 || ih < 20) return null;
  const inner = new Uint8Array(iw * ih);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) inner[y * iw + x] = gray[(y + y0) * w + x + x0];
  const t = otsuThreshold(inner);
  const xs = []; const ys = [];
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) if (inner[y * iw + x] <= t) { xs.push(x); ys.push(y); }
  const dark = xs.length;
  // Text covers only a few percent of the paper; much more means it is not paper with text.
  if (dark < iw * ih * 0.005 || dark > iw * ih * 0.5) return null;
  // Peakiness of the dark-pixel profile projected across direction `a` (radians): sum of
  // squares relative to an even spread. Receipts are rarely perfectly straight in a photo,
  // so the best value over small tilts (±10°) is used for both directions.
  const cx = iw / 2; const cy = ih / 2;
  const peakAt = (a) => {
    const c = Math.cos(a); const s = Math.sin(a);
    const bins = new Map();
    for (let k = 0; k < dark; k++) {
      const p = Math.round((ys[k] - cy) * c - (xs[k] - cx) * s);
      bins.set(p, (bins.get(p) || 0) + 1);
    }
    let sq = 0; let lo = Infinity; let hi = -Infinity;
    for (const [p, v] of bins) { sq += v * v; if (p < lo) lo = p; if (p > hi) hi = p; }
    return (sq * (hi - lo + 1)) / (dark * dark);
  };
  let rows = 0; let cols = 0;
  for (let deg = -10; deg <= 10; deg += 2) {
    const a = (deg * Math.PI) / 180;
    rows = Math.max(rows, peakAt(a));
    cols = Math.max(cols, peakAt(a + Math.PI / 2));
  }
  const r = rows / cols;
  if (r > 1.2) return 'horizontal';
  if (r < 0.83) return 'vertical';
  return null;
}

// Rotates an image Blob clockwise by 90, 180 or 270 degrees; resolves a JPEG Blob.
export async function rotateImage(blob, degrees) {
  const bmp = await createImageBitmap(blob);
  const quarter = degrees % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = quarter ? bmp.height : bmp.width;
  c.height = quarter ? bmp.width : bmp.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
}

// Greyscale copy of an image Blob, scaled so its longer side is at most `side` px.
export async function grayscale(blob, side = ANALYSIS_SIDE) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return { gray, w, h };
}

// Turns a receipt photo a quarter turn when its text runs up and down. Resolves the
// rotated Blob, or null when it already looks right or the direction is unclear.
// (Upside-down text is caught later by comparing OCR confidence, see ocr.js.)
export async function uprightQuarter(blob) {
  try {
    const { gray, w, h } = await grayscale(blob, 480);
    return textDirection(gray, w, h) === 'vertical' ? await rotateImage(blob, 90) : null;
  } catch {
    return null;
  }
}
