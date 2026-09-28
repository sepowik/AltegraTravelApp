// On-device receipt reading with Tesseract.js (bundled in vendor/tesseract).
// The engine (~4 MB) and language data (~7 MB) load on first use only.
import { parseReceiptText } from './receipt-parse.js';
import { rotateImage } from './crop.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;
const LANGS = ['swe', 'eng', 'deu'];

let workerPromise = null;
let onProgress = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { default: Tesseract } = await import('../vendor/tesseract/tesseract.esm.min.js');
      return Tesseract.createWorker(LANGS, Tesseract.OEM.LSTM_ONLY, {
        workerPath: `${BASE}worker.min.js`,
        corePath: `${BASE}core`,
        langPath: `${BASE}lang`,
        // A plain same-origin worker is controlled by the service worker, which caches the files.
        workerBlobURL: false,
        // The service worker already keeps the language files; don't store a second copy.
        cacheMethod: 'none',
        logger: (m) => onProgress?.(m),
      });
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// Below this mean word confidence the photo may be upside down.
const LOW_CONFIDENCE = 60;

// progress(stage, fraction): stage is 'loading' (first-time download/start) or 'reading'.
// With tryFlip, a poorly read photo is also read turned 180°; if that reads clearly better,
// the result has `rotated` (the turned image Blob) and its fields.
export async function readReceipt(blob, progress, { tryFlip = false } = {}) {
  onProgress = (m) => {
    if (typeof m.progress !== 'number') return;
    progress?.(m.status === 'recognizing text' ? 'reading' : 'loading', m.progress);
  };
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(blob);
    const result = { text: data.text, confidence: data.confidence, fields: parseReceiptText(data.text) };
    if (!tryFlip || data.confidence >= LOW_CONFIDENCE) return result;
    // Poorly read: try upside down first (most common), then the two quarter turns, and
    // keep the orientation that reads clearly best.
    let best = null;
    for (const deg of [180, 90, 270]) {
      const turned = await rotateImage(blob, deg);
      const { data: d } = await worker.recognize(turned);
      if (!best || d.confidence > best.confidence) best = { confidence: d.confidence, text: d.text, rotated: turned };
      if (d.confidence >= LOW_CONFIDENCE) break;
    }
    if (best.confidence < data.confidence + 10) return result;
    return { text: best.text, confidence: best.confidence, fields: parseReceiptText(best.text), rotated: best.rotated };
  } finally {
    onProgress = null;
  }
}
