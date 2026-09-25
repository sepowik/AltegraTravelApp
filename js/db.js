// IndexedDB storage. Everything stays on the device; use Settings → Backup to export.

const DB_NAME = 'altegra-travel';
const DB_VERSION = 1;
export const STORES = ['trips', 'expenses', 'companies', 'receipts', 'settings'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('trips')) {
          db.createObjectStore('trips', { keyPath: 'id' }).createIndex('status', 'status');
        }
        if (!db.objectStoreNames.contains('expenses')) {
          const s = db.createObjectStore('expenses', { keyPath: 'id' });
          s.createIndex('tripId', 'tripId');
          s.createIndex('companyId', 'companyId');
        }
        if (!db.objectStoreNames.contains('companies')) db.createObjectStore('companies', { keyPath: 'id' });
        // Receipt files are stored separately so expense lists stay light.
        if (!db.objectStoreNames.contains('receipts')) db.createObjectStore('receipts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, id) {
  if (id == null) return undefined;
  return wrap((await store(name)).get(id));
}

export async function all(name) {
  return wrap((await store(name)).getAll());
}

export async function byIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

export async function put(name, value) {
  await wrap((await store(name, 'readwrite')).put(value));
  return value;
}

export async function remove(name, id) {
  return wrap((await store(name, 'readwrite')).delete(id));
}

export async function clear(name) {
  return wrap((await store(name, 'readwrite')).clear());
}

export async function getSetting(key, fallback) {
  const row = await get('settings', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  return put('settings', { key, value });
}

export async function activeTrip() {
  const active = await byIndex('trips', 'status', 'active');
  return active[0] || null;
}

export async function deleteExpense(expense) {
  for (const rid of expense.receiptIds || []) await remove('receipts', rid);
  await remove('expenses', expense.id);
}

// Asks the browser not to evict our data under storage pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
  } catch {
    /* not supported */
  }
  return false;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(url) {
  return (await fetch(url)).blob();
}

export async function exportBackup() {
  const data = { app: 'altegra-travel', version: 1, exportedAt: new Date().toISOString() };
  for (const name of STORES) {
    const rows = await all(name);
    if (name === 'receipts') {
      data.receipts = [];
      for (const r of rows) data.receipts.push({ ...r, blob: undefined, dataUrl: await blobToDataUrl(r.blob) });
    } else {
      data[name] = rows;
    }
  }
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

// Merges a backup into the current data; rows with the same id are overwritten.
export async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'altegra-travel') throw new Error('Not a backup file from this app');
  let count = 0;
  for (const name of STORES) {
    for (const row of data[name] || []) {
      if (name === 'receipts') {
        const { dataUrl, ...rest } = row;
        await put('receipts', { ...rest, blob: await dataUrlToBlob(dataUrl) });
      } else {
        await put(name, row);
      }
      count++;
    }
  }
  return count;
}
