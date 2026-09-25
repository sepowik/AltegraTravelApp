// Receipt files: photos are downscaled before storing, PDFs are stored as-is.
import * as db from './db.js';
import { uid } from './util.js';

const MAX_SIDE = 2000;

async function downscale(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export async function saveReceipt(file) {
  const blob = await downscale(file);
  const ext = blob.type === 'image/jpeg' ? 'jpg' : (file.name.split('.').pop() || 'bin');
  const base = (file.name || 'receipt').replace(/\.[^.]+$/, '');
  const receipt = { id: uid(), name: `${base}.${ext}`, type: blob.type || file.type, blob, addedAt: Date.now() };
  await db.put('receipts', receipt);
  return receipt;
}

export function receiptFile(receipt, name) {
  return new File([receipt.blob], name || receipt.name, { type: receipt.type });
}

// Opens Android's share sheet with the receipt so it can go straight into another app.
export async function shareReceipts(receipts, title) {
  const files = receipts.map((r) => receiptFile(r));
  if (navigator.canShare?.({ files })) {
    await navigator.share({ files, title });
    return true;
  }
  for (const f of files) download(f, f.name);
  return false;
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
