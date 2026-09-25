// Pure helpers with no DOM or storage dependencies (unit tested in tests/).
import { t, label } from './i18n.js';

// Labels are getters so they follow the selected language.
const withLabel = (prefix) => (o) => Object.defineProperty(o, 'label', { get: () => label(prefix, o.id), enumerable: true });

export const TRANSPORTS = [
  { id: 'car', icon: '🚗' },
  { id: 'company_car', icon: '🚙' },
  { id: 'train', icon: '🚆' },
  { id: 'flight', icon: '✈️' },
  { id: 'taxi', icon: '🚕' },
  { id: 'bus', icon: '🚌' },
  { id: 'public', icon: '🚇' },
  { id: 'rental', icon: '🔑' },
  { id: 'boat', icon: '⛴️' },
  { id: 'walk', icon: '🚶' },
].map(withLabel('transport'));

export const CATEGORIES = [
  'Hotel', 'Meal', 'Taxi', 'Train', 'Flight', 'Local transport', 'Parking',
  'Fuel', 'Rental car', 'Mileage', 'Toll', 'Conference', 'Other',
];

export const CURRENCIES = ['SEK', 'EUR', 'USD', 'NOK', 'DKK', 'GBP', 'CHF', 'PLN'];

export const STATUSES = [{ id: 'todo' }, { id: 'reported' }, { id: 'reimbursed' }].map(withLabel('status'));

export const PAYMENTS = ['Private card', 'Company card', 'Cash', 'Invoice'];

export const categoryLabel = (c) => label('cat', c);
export const paymentLabel = (p) => label('pay', p);
export const statusLabel = (s) => label('status', s);

export function transportById(id) {
  return TRANSPORTS.find((x) => x.id === id) || { id, label: id || '—', icon: '•' };
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const pad = (n) => String(n).padStart(2, '0');

// Local date as YYYY-MM-DD.
export function isoDate(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local time as HH:MM.
export function isoTime(d) {
  d = new Date(d);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(d) {
  return d ? `${isoDate(d)} ${isoTime(d)}` : '';
}

// Value for <input type="datetime-local">.
export function toLocalInput(d) {
  return d ? `${isoDate(d)}T${isoTime(d)}` : '';
}

export function formatDuration(ms) {
  if (!(ms >= 0)) return '';
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const [ud, uh, um] = [t('dur.d'), t('dur.h'), t('dur.m')];
  if (days) return `${days}${ud} ${h}${uh} ${m}${um}`;
  if (h) return `${h}${uh} ${m}${um}`;
  return `${m}${um}`;
}

// Parses "123,50" or "1 234.50" into a number.
export function parseAmount(s) {
  if (typeof s === 'number') return s;
  const cleaned = String(s ?? '').replace(/[\s ]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// Amount formatted with a configurable decimal separator (many Swedish systems want a comma).
export function formatAmount(n, decimalSep = ',') {
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2).replace('.', decimalSep);
}

// Distance with one decimal, trailing ",0" dropped: 24,6 / 25.
export function formatKm(n, decimalSep = ',') {
  if (!Number.isFinite(n)) return '';
  return n.toFixed(1).replace(/\.0$/, '').replace('.', decimalSep);
}

// Great-circle distance in km.
export function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Replaces {key} placeholders. Unknown keys are left untouched so typos are visible.
// "\t" and "\n" escapes in the template become real tab/newline characters.
export function renderTemplate(template, values) {
  return String(template ?? '')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key] ?? '') : m));
}

export function csvCell(v, sep = ';') {
  const s = String(v ?? '');
  return /["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, sep = ';') {
  return rows.map((r) => r.map((c) => csvCell(c, sep)).join(sep)).join('\r\n');
}

// Legs are derived from the trip's ordered point list: each point except the last
// starts a leg that ends at the next point.
export function tripLegs(trip) {
  const pts = trip.points || [];
  const legs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    legs.push({ index: i, from: pts[i], to: pts[i + 1], transport: pts[i].transport });
  }
  const last = pts[pts.length - 1];
  if (trip.status === 'active' && last) {
    legs.push({ index: pts.length - 1, from: last, to: null, transport: last.transport });
  }
  return legs;
}

export function legDistanceKm(leg) {
  if (Number.isFinite(leg.from.distanceKm)) return leg.from.distanceKm;
  return null;
}

// Total km driven in own car, used for mileage allowance.
export function ownCarKm(trip) {
  return tripLegs(trip)
    .filter((l) => l.transport === 'car' && l.to)
    .reduce((sum, l) => sum + (legDistanceKm(l) || 0), 0);
}

export function tripStart(trip) {
  return trip.points?.[0]?.time ?? null;
}

export function tripEnd(trip) {
  return trip.status === 'done' ? trip.points?.[trip.points.length - 1]?.time ?? null : null;
}

export function placeLabel(p) {
  if (!p) return '';
  if (p.place) return p.place;
  if (Number.isFinite(p.lat)) return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  return t('unknownPlace');
}

export function tripTitle(trip) {
  if (trip.title) return trip.title;
  if (trip.destination) return trip.destination;
  const start = tripStart(trip);
  return start ? t('tripOn', { date: isoDate(start) }) : t('title.trip');
}

// Placeholder values for an expense, optionally with its trip and company.
export function expenseValues(expense, { trip, company } = {}) {
  const sep = company?.decimalSep ?? ',';
  const mapped = company?.categoryMap?.[expense.category];
  return {
    date: expense.date || '',
    amount: formatAmount(expense.amount, sep),
    currency: expense.currency || '',
    category: mapped || categoryLabel(expense.category),
    my_category: categoryLabel(expense.category),
    merchant: expense.merchant || '',
    description: expense.description || '',
    vat: Number.isFinite(expense.vat) ? formatAmount(expense.vat, sep) : '',
    payment: paymentLabel(expense.payment),
    company: company?.name || '',
    ...(trip ? tripValues(trip, company) : {}),
  };
}

export function tripValues(trip, company) {
  const start = tripStart(trip);
  const end = tripEnd(trip);
  const pts = trip.points || [];
  const km = ownCarKm(trip);
  const transports = [...new Set(pts.slice(0, trip.status === 'done' ? -1 : undefined).map((p) => transportById(p.transport).label))];
  return {
    trip: tripTitle(trip),
    purpose: trip.purpose || '',
    destination: trip.destination || '',
    start_date: start ? isoDate(start) : '',
    start_time: start ? isoTime(start) : '',
    start_place: placeLabel(pts[0]),
    end_date: end ? isoDate(end) : '',
    end_time: end ? isoTime(end) : '',
    end_place: end ? placeLabel(pts[pts.length - 1]) : '',
    transport: transports.join(', '),
    company: company?.name || '',
    car_km: km ? formatKm(km, company?.decimalSep ?? ',') : '',
  };
}

export const DEFAULT_EXPENSE_TEMPLATE = '{date}\\t{amount}\\t{currency}\\t{category}\\t{merchant}\\t{description}';
// The default trip template has labels, so it follows the selected language.
export const defaultTripTemplate = () => t('tripTemplate');

export const EXPENSE_PLACEHOLDERS = ['date', 'amount', 'currency', 'category', 'my_category', 'merchant', 'description', 'vat', 'payment', 'company', 'trip', 'purpose', 'destination'];
export const TRIP_PLACEHOLDERS = ['trip', 'purpose', 'destination', 'start_date', 'start_time', 'start_place', 'end_date', 'end_time', 'end_place', 'transport', 'car_km', 'company'];

// Builds CSV rows for a company export.
export function expensesCsv(expenses, { tripsById = {}, company } = {}) {
  const header = t('csvHeader').split(';');
  const rows = expenses.map((e) => {
    const v = expenseValues(e, { trip: tripsById[e.tripId], company });
    return [v.date, v.amount, v.currency, v.category, v.merchant, v.description, v.vat, v.trip || '', v.purpose || '', statusLabel(e.status)];
  });
  return toCsv([header, ...rows], company?.csvSep || ';');
}
