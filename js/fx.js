// Exchange rates: European Central Bank reference rates via the Frankfurter API
// (free, no account). Only the two currency codes and the date are sent.
// Rates are cached in the settings store, so each date/pair is fetched once.
import * as db from './db.js';
import { isoDate } from './util.js';

const SERVERS = ['https://api.frankfurter.dev/v1/', 'https://api.frankfurter.app/'];
// Pairs the ECB does not publish (e.g. AED), remembered for this session.
const unsupported = new Set();

// → { rate, date } where date is the ECB publication date used (the last one on or
// before the expense date; there are no rates on weekends and holidays).
// Throws an error with .offline or .unsupported set when no rate can be had.
export async function getRate(date, from, to) {
  if (from === to) return { rate: 1, date };
  const today = isoDate(Date.now());
  const day = !date || date > today ? today : date;
  const key = `fx:${day}:${from}:${to}`;
  const cached = await db.getSetting(key, null);
  if (cached) return cached;
  if (unsupported.has(`${from}:${to}`)) throw Object.assign(new Error(`No rate for ${from}/${to}`), { unsupported: true });
  if (!navigator.onLine) throw Object.assign(new Error('offline'), { offline: true });
  let lastError;
  for (const base of SERVERS) {
    try {
      const res = await fetch(`${base}${day}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (res.status === 404 || res.status === 422) throw Object.assign(new Error(`No rate for ${from}/${to}`), { unsupported: true });
      if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
      const json = await res.json();
      const rate = json.rates?.[to];
      if (!Number.isFinite(rate)) throw Object.assign(new Error(`No rate for ${from}/${to}`), { unsupported: true });
      const result = { rate, date: json.date || day };
      await db.setSetting(key, result);
      return result;
    } catch (err) {
      if (err.unsupported) {
        unsupported.add(`${from}:${to}`);
        throw err;
      }
      lastError = err;
    }
  }
  throw Object.assign(lastError || new Error('Rate unavailable'), { offline: !navigator.onLine });
}
