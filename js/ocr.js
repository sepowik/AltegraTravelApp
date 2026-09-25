// On-device receipt reading with Tesseract.js (bundled in vendor/tesseract).
// The engine (~4 MB) and language data (~7 MB) load on first use only.
import { parseReceiptText } from './receipt-parse.js';

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

// progress(stage, fraction): stage is 'loading' (first-time download/start) or 'reading'.
export async function readReceipt(blob, progress) {
  onProgress = (m) => {
    if (typeof m.progress !== 'number') return;
    progress?.(m.status === 'recognizing text' ? 'reading' : 'loading', m.progress);
  };
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(blob);
    return { text: data.text, confidence: data.confidence, fields: parseReceiptText(data.text) };
  } finally {
    onProgress = null;
  }
}
