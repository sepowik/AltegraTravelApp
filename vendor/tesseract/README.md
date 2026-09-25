# Bundled OCR engine

Used by `js/ocr.js` to read receipt photos on the device. Nothing is sent anywhere.

| Files | Source | Version | License |
| --- | --- | --- | --- |
| `tesseract.esm.min.js`, `worker.min.js` | npm `tesseract.js` (`dist/`) | 7.0.0 | Apache-2.0 (`LICENSE-tesseract.js.md`) |
| `core/*.wasm.js` | npm `tesseract.js-core` (LSTM builds only) | 7.0.0 | Apache-2.0 (`LICENSE-tesseract.js-core`) |
| `lang/*.traineddata.gz` | npm `@tesseract.js-data/{eng,swe,deu}` (`4.0.0_best_int`) | 1.0.0 | Apache-2.0 (tesseract-ocr/tessdata) |

The browser downloads only the core build it supports (relaxed SIMD, SIMD or plain), plus the three language files, the first time a receipt is read. The service worker then keeps them for offline use.
