import * as db from './db.js';
import * as geo from './geo.js';
import { saveReceipt, shareReceipts, download } from './receipts.js';
import { readReceipt } from './ocr.js';
import { pickCar, applyCarChoice, currentCar, carLabel, carsView, carView, placesView, chargeView, rateSheet } from './ev.js';
import { esc, options, toast, copyText, sheet, confirmSheet, objectUrl, revokeUrls } from './ui.js';
import { t, setLanguage, getLanguage, LANGUAGES, DEFAULT_LANGUAGE } from './i18n.js';
import {
  TRANSPORTS, CATEGORIES, CURRENCIES, STATUSES, PAYMENTS, transportById, categoryLabel, paymentLabel,
  uid, isoDate, isoTime, dateTime, toLocalInput, formatDuration, parseAmount, formatAmount, formatKm,
  tripLegs, ownCarKm, tripStart, tripEnd, placeLabel, tripTitle, expenseValues, tripValues, renderTemplate,
  expensesCsv, DEFAULT_EXPENSE_TEMPLATE, defaultTripTemplate, EXPENSE_PLACEHOLDERS, TRIP_PLACEHOLDERS,
} from './util.js';

const main = document.getElementById('main');
const titleEl = document.getElementById('title');
let actions = {};
let tickTimer;
let lastHash = null;

// ---------- language ----------

const LANG_CACHE_KEY = 'travel-language';

// The saved language lives in IndexedDB with the other settings; localStorage is only a
// fast copy so the first paint is already in the right language.
function cachedLanguage() {
  try {
    return localStorage.getItem(LANG_CACHE_KEY);
  } catch {
    return null;
  }
}

async function applyLanguage(lang, { save = false } = {}) {
  setLanguage(lang);
  try {
    localStorage.setItem(LANG_CACHE_KEY, getLanguage());
  } catch { /* storage unavailable */ }
  if (save) await db.setSetting('language', getLanguage());
  // Static shell text.
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-label]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nLabel)));
  document.title = t('title.app');
}

// ---------- routing ----------

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

export function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function render() {
  clearInterval(tickTimer);
  revokeUrls();
  const { parts, query } = parseRoute();
  const [section, id, sub] = parts;
  let view;
  try {
    if (!section) view = await homeView();
    else if (section === 'trips') view = await tripsView();
    else if (section === 'trip') view = await tripView(id);
    else if (section === 'expenses') view = await expensesView(query);
    else if (section === 'expense' && id === 'new') view = await expenseFormView(null, query);
    else if (section === 'expense' && sub === 'edit') view = await expenseFormView(id, query);
    else if (section === 'expense') view = await expenseView(id);
    else if (section === 'companies') view = await companiesView();
    else if (section === 'company') view = await companyView(id);
    else if (section === 'settings') view = await settingsView();
    else if (section === 'cars') view = await carsView();
    else if (section === 'car') view = await carView(id, nav);
    else if (section === 'places') view = await placesView(nav);
    else if (section === 'charge') view = await chargeView(id, nav);
    else view = { title: t('title.notFound'), html: `<p class="empty">${esc(t('notFound'))}</p>` };
  } catch (err) {
    console.error(err);
    view = { title: t('title.error'), html: `<p class="empty">${esc(t('error', { msg: err.message }))}</p>` };
  }
  titleEl.textContent = view.title || t('title.app');
  main.innerHTML = view.html;
  actions = view.actions || {};
  view.bind?.(main);
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const tab = a.dataset.tab;
    const active = tab === (section || 'home') || (tab === 'trips' && section === 'trip') || (tab === 'expenses' && section === 'expense') || (tab === 'settings' && ['companies', 'company', 'cars', 'car', 'places'].includes(section)) || (tab === 'home' && section === 'charge');
    a.classList.toggle('active', active);
  });
  if (location.hash !== lastHash) window.scrollTo(0, 0);
  lastHash = location.hash;
}

main.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !main.contains(el)) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});

window.addEventListener('hashchange', render);

const nav = { go: (hash) => go(hash), render: () => render() };

// ---------- shared data helpers ----------

async function companiesById() {
  const list = await db.all('companies');
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { list, byId: Object.fromEntries(list.map((c) => [c.id, c])) };
}

async function tripsById() {
  const list = await db.all('trips');
  list.sort((a, b) => (tripStart(b) || 0) - (tripStart(a) || 0));
  return { list, byId: Object.fromEntries(list.map((x) => [x.id, x])) };
}

function sortExpenses(list) {
  return list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
}

function money(amount, currency) {
  return `${formatAmount(amount, ',')} ${esc(currency || '')}`;
}

function statusBadge(status) {
  const s = STATUSES.find((x) => x.id === status) || STATUSES[0];
  return `<span class="badge status-${s.id}">${esc(s.label)}</span>`;
}

function totalsByCurrency(expenses) {
  const sums = {};
  for (const e of expenses) sums[e.currency] = (sums[e.currency] || 0) + (e.amount || 0);
  return Object.entries(sums).map(([c, a]) => money(a, c)).join(' + ') || '0';
}

function expenseRow(e, companies, trips) {
  const c = companies[e.companyId];
  const trip = trips?.[e.tripId];
  return `<a class="list-item" href="#/expense/${e.id}">
    <div class="li-main">
      <div class="li-title">${esc(e.merchant || categoryLabel(e.category) || t('title.expense'))}${e.receiptIds?.length ? ` <span title="${esc(t('hasReceipt'))}">🧾</span>` : ''}</div>
      <div class="li-sub">${esc(e.date)} · ${esc(categoryLabel(e.category))}${c ? ` · ${esc(c.name)}` : ''}${trip ? ` · ${esc(tripTitle(trip))}` : ''}</div>
    </div>
    <div class="li-end"><div class="amount">${money(e.amount, e.currency)}</div>${statusBadge(e.status)}</div>
  </a>`;
}

function copyRow(label, value, copyLabel) {
  if (value == null || value === '') return '';
  return `<button class="copy-row" data-action="copy" data-value="${esc(value)}" data-label="${esc(copyLabel || label)}">
    <span class="copy-label">${esc(label)}</span><span class="copy-value">${esc(value)}</span><span class="copy-icon" aria-hidden="true">⧉</span>
  </button>`;
}

const copyAction = (el) => copyText(el.dataset.value, t('copied', { what: el.dataset.label }));

// ---------- trip actions: start / change transport / end ----------

function transportGrid() {
  return `<div class="transport-grid">${TRANSPORTS.map((x) => `<button class="transport-btn" data-transport="${x.id}"><span class="t-icon">${x.icon}</span><span>${esc(x.label)}</span></button>`).join('')}</div>`;
}

// Saves GPS position and address into the given point once they arrive.
async function capturePosition(tripId, pointId, positionPromise) {
  const pos = await positionPromise;
  let trip = await db.get('trips', tripId);
  let point = trip?.points.find((p) => p.id === pointId);
  if (!point) return;
  if (pos.error) {
    point.positionError = pos.error;
    await db.put('trips', trip);
    toast(t('noPosition', { err: pos.error }));
    refreshIfShowing(tripId);
    return;
  }
  Object.assign(point, { lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy, positionError: undefined });
  await db.put('trips', trip);
  refreshIfShowing(tripId);
  const place = await geo.reverseGeocode(pos.lat, pos.lon);
  if (place) {
    trip = await db.get('trips', tripId);
    point = trip?.points.find((p) => p.id === pointId);
    if (point && !point.place) {
      point.place = place;
      await db.put('trips', trip);
      refreshIfShowing(tripId);
    }
  }
}

function refreshIfShowing(tripId) {
  const { parts } = parseRoute();
  if (!parts.length || (parts[0] === 'trip' && parts[1] === tripId)) render();
}

async function startTrip() {
  const time = Date.now();
  const position = geo.getPosition();
  const { list: companies } = await companiesById();
  const lastCompany = await db.getSetting('lastCompanyId', '');
  sheet(t('startTrip'), `
    <p class="muted">${esc(t('departureRecorded', { time: isoTime(time) }))}</p>
    ${transportGrid()}
    <details class="more"><summary>${esc(t('optionalDetails'))}</summary>
      <label>${esc(t('destination'))}<input name="destination" placeholder="${esc(t('destinationPh'))}"></label>
      <label>${esc(t('purpose'))}<input name="purpose" placeholder="${esc(t('purposePh'))}"></label>
      <label>${esc(t('billTo'))}<select name="companyId">${options(companies, lastCompany, { value: (c) => c.id, label: (c) => c.name, empty: '—' })}</select></label>
    </details>`, (dlg, close) => {
    dlg.querySelectorAll('[data-transport]').forEach((btn) => {
      btn.onclick = async () => {
        const val = (n) => dlg.querySelector(`[name=${n}]`).value.trim();
        const details = { destination: val('destination'), purpose: val('purpose'), companyId: val('companyId') };
        const choice = await pickCar(dlg, btn.dataset.transport, t('startTripBtn'));
        const point = { id: uid(), time, transport: btn.dataset.transport };
        const trip = { id: uid(), status: 'active', points: [point], createdAt: time, ...details };
        await applyCarChoice(trip, point, choice);
        await db.put('trips', trip);
        if (trip.companyId) await db.setSetting('lastCompanyId', trip.companyId);
        close();
        navigator.vibrate?.(40);
        toast(t('tripStarted'));
        render();
        capturePosition(trip.id, point.id, position);
      };
    });
  });
}

async function changeTransport(tripId) {
  const time = Date.now();
  const position = geo.getPosition();
  sheet(t('changeTransport'), `<p class="muted">${esc(t('newLegFrom', { time: isoTime(time) }))}</p>${transportGrid()}`, (dlg, close) => {
    dlg.querySelectorAll('[data-transport]').forEach((btn) => {
      btn.onclick = async () => {
        const choice = await pickCar(dlg, btn.dataset.transport, t('changeTransport'));
        const trip = await db.get('trips', tripId);
        const point = { id: uid(), time, transport: btn.dataset.transport };
        await applyCarChoice(trip, point, choice);
        trip.points.push(point);
        await db.put('trips', trip);
        close();
        navigator.vibrate?.(40);
        toast(t('legFrom', { transport: transportById(point.transport).label, time: isoTime(time) }));
        render();
        capturePosition(trip.id, point.id, position);
      };
    });
  });
}

async function endTrip(tripId) {
  const time = Date.now();
  if (!(await confirmSheet(t('endTrip'), t('endTripConfirm', { time: isoTime(time) }), t('endTrip')))) return;
  const trip = await db.get('trips', tripId);
  const point = { id: uid(), time, transport: null };
  trip.points.push(point);
  trip.status = 'done';
  await db.put('trips', trip);
  navigator.vibrate?.([40, 60, 40]);
  go(`#/trip/${trip.id}`);
  await capturePosition(trip.id, point.id, geo.getPosition());
  await calculateCarDistances(trip.id, { onlyMissing: true, quiet: true });
}

// Fills in road distance for own-car and company-car legs that have positions at both ends.
async function calculateCarDistances(tripId, { onlyMissing = false, quiet = false, legIndex } = {}) {
  const trip = await db.get('trips', tripId);
  let done = 0;
  let failed = 0;
  for (const leg of tripLegs(trip)) {
    if (legIndex != null && leg.index !== legIndex) continue;
    if (legIndex == null && !['car', 'company_car', 'rental'].includes(leg.transport)) continue;
    if (!leg.to || !Number.isFinite(leg.from.lat) || !Number.isFinite(leg.to.lat)) { failed++; continue; }
    if (onlyMissing && Number.isFinite(leg.from.distanceKm)) continue;
    const km = await geo.roadDistanceKm(leg.from, leg.to);
    if (km == null) { failed++; continue; }
    trip.points[leg.index].distanceKm = km;
    trip.points[leg.index].distanceSource = 'road';
    done++;
  }
  if (done) await db.put('trips', trip);
  if (!quiet || done) {
    toast(done ? t('distanceDone', { n: done }) : failed ? t('distanceFailed') : t('noCarLegs'));
  }
  if (done) refreshIfShowing(tripId);
}

// ---------- views ----------

async function homeView() {
  const trip = await db.activeTrip();
  const { byId: companies } = await companiesById();
  const { byId: trips } = await tripsById();
  const expenses = sortExpenses(await db.all('expenses'));
  const todo = expenses.filter((e) => e.status === 'todo');
  let tripHtml;
  if (trip) {
    const legs = tripLegs(trip);
    const current = legs[legs.length - 1];
    const tr = transportById(current?.transport);
    const tripExpenses = expenses.filter((e) => e.tripId === trip.id);
    const car = await currentCar(trip);
    const ev = car?.fuel === 'electric';
    tripHtml = `
      <section class="card active-trip">
        <div class="row between"><span class="badge live">${esc(t('onTrip'))}</span><a href="#/trip/${trip.id}" class="link">${esc(t('details'))}</a></div>
        <h2>${esc(tripTitle(trip))}</h2>
        <p class="muted">${esc(t('leftFrom', { time: dateTime(tripStart(trip)), place: placeLabel(trip.points[0]) }))}</p>
        <div class="big-stat"><span class="t-icon">${tr.icon}</span><div><div class="stat-label">${esc(t('since', { transport: tr.label, time: isoTime(current.from.time) }))}</div><div class="stat-value" id="elapsed">${formatDuration(Date.now() - tripStart(trip))}</div></div></div>
        ${car ? `<p class="muted small">${esc(carLabel(car))}${ev && trip.battery ? ` · 🔋 ${trip.battery.pct}%` : ''}</p>` : ''}
        ${ev ? `<a class="btn block" href="#/charge/${trip.id}">${esc(t('chargingStops'))}</a>` : ''}
        <div class="grid2">
          <a class="btn primary big" href="#/expense/new?trip=${trip.id}">${esc(t('addExpenseBtn'))}</a>
          <button class="btn big" data-action="change" data-id="${trip.id}">${esc(t('changeTransportBtn'))}</button>
        </div>
        <button class="btn danger block" data-action="end" data-id="${trip.id}">${esc(t('endTripBtn'))}</button>
        ${tripExpenses.length ? `<p class="muted small">${t('tripExpenses', { n: tripExpenses.length, total: totalsByCurrency(tripExpenses) })}</p>` : ''}
      </section>`;
  } else {
    tripHtml = `
      <section class="start-wrap">
        <button class="start-btn" data-action="start"><span>▶</span>${esc(t('startTripBtn'))}</button>
        <p class="muted center">${esc(t('startHint'))}</p>
        <a class="btn block" href="#/expense/new">${esc(t('addWithoutTrip'))}</a>
      </section>`;
  }
  return {
    title: t('title.app'),
    html: `${tripHtml}
      <section>
        <div class="row between"><h3>${esc(t('toReport', { n: todo.length }))}</h3>${todo.length ? `<a class="link" href="#/expenses?status=todo">${esc(t('all'))}</a>` : ''}</div>
        ${todo.length ? `<p class="muted small">${totalsByCurrency(todo)}</p><div class="list">${todo.slice(0, 8).map((e) => expenseRow(e, companies, trips)).join('')}</div>` : `<p class="empty">${esc(t('nothingToReport'))}</p>`}
      </section>`,
    actions: {
      start: startTrip,
      change: (el) => changeTransport(el.dataset.id),
      end: (el) => endTrip(el.dataset.id),
    },
    bind() {
      if (trip) {
        tickTimer = setInterval(() => {
          const el = document.getElementById('elapsed');
          if (el) el.textContent = formatDuration(Date.now() - tripStart(trip));
        }, 30000);
      }
    },
  };
}

async function tripsView() {
  const { list } = await tripsById();
  const { byId: companies } = await companiesById();
  const expenses = await db.all('expenses');
  const rows = list.map((trip) => {
    const ex = expenses.filter((e) => e.tripId === trip.id);
    const todo = ex.filter((e) => e.status === 'todo').length;
    const start = tripStart(trip);
    const end = tripEnd(trip);
    const icons = [...new Set(trip.points.filter((p) => p.transport).map((p) => transportById(p.transport).icon))].join(' ');
    return `<a class="list-item" href="#/trip/${trip.id}">
      <div class="li-main"><div class="li-title">${esc(tripTitle(trip))} ${trip.status === 'active' ? `<span class="badge live">${esc(t('active'))}</span>` : ''}</div>
      <div class="li-sub">${start ? isoDate(start) : ''}${end && isoDate(end) !== isoDate(start) ? ` – ${isoDate(end)}` : ''} · ${icons}${companies[trip.companyId] ? ` · ${esc(companies[trip.companyId].name)}` : ''}</div></div>
      <div class="li-end">${ex.length ? `<div class="small">${esc(t('nExp', { n: ex.length }))}</div>` : ''}${todo ? `<span class="badge status-todo">${esc(t('nToReport', { n: todo }))}</span>` : ''}</div>
    </a>`;
  });
  return {
    title: t('nav.trips'),
    html: list.length ? `<div class="list">${rows.join('')}</div>` : `<p class="empty">${esc(t('noTrips'))}</p>`,
  };
}

async function tripView(id) {
  const trip = await db.get('trips', id);
  if (!trip) return { title: t('title.trip'), html: `<p class="empty">${esc(t('tripNotFound'))}</p>` };
  const { list: companyList, byId: companies } = await companiesById();
  const company = companies[trip.companyId];
  const expenses = sortExpenses(await db.byIndex('expenses', 'tripId', id));
  const legs = tripLegs(trip);
  const start = tripStart(trip);
  const end = tripEnd(trip);
  const km = ownCarKm(trip);
  const values = tripValues(trip, company);
  const mileageRate = await db.getSetting('mileageRate', 25);
  const carsById = Object.fromEntries((await db.all('cars')).map((c) => [c.id, c]));
  const curCar = trip.status === 'active' ? await currentCar(trip) : null;

  const pointHtml = (p, i) => {
    const isEnd = trip.status === 'done' && i === trip.points.length - 1;
    const label = i === 0 ? t('departure') : isEnd ? t('return') : t('change');
    const leg = !isEnd ? legs.find((l) => l.index === i) : null;
    const isCar = ['car', 'company_car', 'rental'].includes(p.transport);
    return `<li class="tl-point">
      <div class="tl-head"><strong>${esc(label)}</strong>
        <input type="datetime-local" class="inline" value="${toLocalInput(p.time)}" data-point="${p.id}" data-field="time"></div>
      <div class="tl-place">
        <input class="inline wide" value="${esc(p.place || '')}" placeholder="${esc(placeLabel(p))}" data-point="${p.id}" data-field="place">
        ${Number.isFinite(p.lat) ? `<a class="link small" href="${geo.mapUrl(p)}" target="_blank" rel="noopener">${esc(t('map'))}</a>` : `<button class="link small" data-action="relocate" data-point="${p.id}">${esc(p.positionError ? t('retryGps') : t('locating'))}</button>`}
      </div>
      ${carsById[p.carId] ? `<div class="muted small">${esc(carLabel(carsById[p.carId]))}${Number.isFinite(p.chargePct) ? ` · 🔋 ${p.chargePct}%` : ''}</div>` : ''}
      ${leg ? `<div class="tl-leg">
        <select class="inline" data-point="${p.id}" data-field="transport">${options(TRANSPORTS, p.transport, { value: (x) => x.id, label: (x) => `${x.icon} ${x.label}` })}</select>
        ${leg.to ? `<span class="muted small">${formatDuration(leg.to.time - p.time)}</span>` : `<span class="badge live">${esc(t('now'))}</span>`}
        ${isCar && leg.to ? `<span class="km"><input class="inline num" inputmode="decimal" value="${Number.isFinite(p.distanceKm) ? String(p.distanceKm).replace('.', ',') : ''}" placeholder="km" data-point="${p.id}" data-field="distanceKm"> km
          <button class="link small" data-action="roadkm" data-index="${i}">${esc(t('byRoad'))}</button></span>` : ''}
      </div>` : ''}
    </li>`;
  };

  return {
    title: tripTitle(trip),
    html: `
      ${trip.status === 'active' ? `<div class="grid2"><button class="btn" data-action="change">${esc(t('changeTransportBtn'))}</button><button class="btn danger" data-action="end">${esc(t('endTripBtn'))}</button></div>` : ''}
      ${curCar?.fuel === 'electric' ? `<a class="btn block" href="#/charge/${trip.id}">${esc(t('chargingStops'))}</a>` : ''}
      <section class="card">
        <label>${esc(t('destination'))}<input name="destination" value="${esc(trip.destination || '')}" placeholder="${esc(t('destinationPh'))}"></label>
        <label>${esc(t('purpose'))}<input name="purpose" value="${esc(trip.purpose || '')}" placeholder="${esc(t('purposePh'))}"></label>
        <label>${esc(t('billTo'))}<select name="companyId">${options(companyList, trip.companyId, { value: (c) => c.id, label: (c) => c.name, empty: '—' })}</select></label>
        <label>${esc(t('notes'))}<textarea name="notes" rows="2">${esc(trip.notes || '')}</textarea></label>
      </section>
      <section>
        <h3>${esc(t('timeline'))}</h3>
        <ol class="timeline">${trip.points.map(pointHtml).join('')}</ol>
        <p class="muted small">${esc(t('durationLine', { duration: formatDuration((end || Date.now()) - start) }))}${km ? ` · ${esc(t('ownCarKmLine', { km: formatKm(km) }))}` : ''}</p>
      </section>
      <section>
        <div class="row between"><h3>${esc(t('copy'))}</h3><button class="btn small primary" data-action="copytrip">${esc(t('copySummary'))}</button></div>
        <div class="copy-list">
          ${copyRow(t('departureDate'), values.start_date)}
          ${copyRow(t('departureTime'), values.start_time)}
          ${copyRow(t('from'), values.start_place)}
          ${copyRow(t('returnDate'), values.end_date)}
          ${copyRow(t('returnTime'), values.end_time)}
          ${copyRow(t('backAt'), values.end_place)}
          ${copyRow(t('destination'), values.destination)}
          ${copyRow(t('purpose'), values.purpose)}
          ${copyRow(t('transport'), values.transport)}
          ${copyRow(t('ownCarKm'), values.car_km)}
        </div>
      </section>
      <section>
        <div class="row between"><h3>${esc(t('expensesN', { n: expenses.length }))}</h3><a class="btn small primary" href="#/expense/new?trip=${trip.id}">${esc(t('add'))}</a></div>
        ${expenses.length ? `<p class="muted small">${totalsByCurrency(expenses)}</p><div class="list">${expenses.map((e) => expenseRow(e, companies)).join('')}</div>` : `<p class="empty">${esc(t('noTripExpenses'))}</p>`}
        ${km && trip.status === 'done' && !expenses.some((e) => e.category === 'Mileage') ? `<button class="btn block" data-action="mileage">${esc(t('addMileage', { km: formatKm(km), rate: formatAmount(mileageRate) }))}</button>` : ''}
      </section>
      <button class="btn danger block subtle" data-action="delete">${esc(t('deleteTrip'))}</button>`,
    actions: {
      copy: copyAction,
      change: () => changeTransport(trip.id),
      end: () => endTrip(trip.id),
      roadkm: (el) => calculateCarDistances(trip.id, { legIndex: Number(el.dataset.index) }),
      relocate: async (el) => {
        toast(t('gettingPosition'));
        const fresh = await db.get('trips', trip.id);
        const p = fresh.points.find((x) => x.id === el.dataset.point);
        p.positionError = undefined;
        await db.put('trips', fresh);
        await capturePosition(trip.id, p.id, geo.getPosition());
      },
      copytrip: () => copyText(renderTemplate(company?.tripTemplate || defaultTripTemplate(), values), t('tripSummaryCopied')),
      mileage: async () => {
        const e = {
          id: uid(), tripId: trip.id, companyId: trip.companyId || '', date: isoDate(start), createdAt: Date.now(),
          amount: Math.round((km / 10) * mileageRate * 100) / 100, currency: 'SEK', category: 'Mileage',
          merchant: '', description: t('mileageDesc', { km: formatKm(km), mil: formatAmount(km / 10), rate: formatAmount(mileageRate) }),
          status: 'todo', receiptIds: [],
        };
        await db.put('expenses', e);
        go(`#/expense/${e.id}`);
      },
      delete: async () => {
        if (!(await confirmSheet(t('deleteTrip'), t('deleteTripText'), t('delete'), true))) return;
        for (const e of expenses) await db.put('expenses', { ...e, tripId: '' });
        await db.remove('trips', trip.id);
        go('#/trips');
      },
    },
    bind(root) {
      root.querySelectorAll('.card [name]').forEach((input) => {
        input.addEventListener('change', async () => {
          const fresh = await db.get('trips', trip.id);
          fresh[input.name] = input.value.trim();
          await db.put('trips', fresh);
          if (input.name === 'companyId') {
            if (fresh.companyId) await db.setSetting('lastCompanyId', fresh.companyId);
            render();
          } else {
            titleEl.textContent = tripTitle(fresh);
          }
        });
      });
      root.querySelectorAll('[data-point]').forEach((input) => {
        if (input.tagName === 'BUTTON') return;
        input.addEventListener('change', async () => {
          const fresh = await db.get('trips', trip.id);
          const p = fresh.points.find((x) => x.id === input.dataset.point);
          const f = input.dataset.field;
          if (f === 'time') {
            const d = new Date(input.value).getTime();
            if (Number.isFinite(d)) p.time = d;
          } else if (f === 'distanceKm') {
            const n = parseAmount(input.value);
            p.distanceKm = Number.isFinite(n) ? n : undefined;
            p.distanceSource = 'manual';
          } else {
            p[f] = input.value.trim();
          }
          await db.put('trips', fresh);
          render();
        });
      });
    },
  };
}

async function expensesView(query) {
  const status = query.get('status') ?? 'todo';
  const companyId = query.get('company') ?? '';
  const { list: companyList, byId: companies } = await companiesById();
  const { byId: trips } = await tripsById();
  let list = sortExpenses(await db.all('expenses'));
  if (status) list = list.filter((e) => e.status === status);
  if (companyId) list = list.filter((e) => (companyId === 'none' ? !e.companyId : e.companyId === companyId));
  const link = (s, c) => `#/expenses?status=${s}&company=${c}`;
  return {
    title: t('nav.expenses'),
    html: `
      <div class="chips">${[{ id: '', label: t('allFilter') }, ...STATUSES].map((s) => `<a class="chip${s.id === status ? ' on' : ''}" href="${link(s.id, companyId)}">${esc(s.label)}</a>`).join('')}</div>
      <select id="company-filter">${options([{ id: '', name: t('allCompanies') }, ...companyList, { id: 'none', name: t('noCompany') }], companyId, { value: (c) => c.id, label: (c) => c.name })}</select>
      <div class="row between"><p class="muted small">${esc(t('nExpenses', { n: list.length }))} · ${totalsByCurrency(list)}</p><a class="btn small primary" href="#/expense/new">${esc(t('add'))}</a></div>
      ${list.length ? `<div class="list">${list.map((e) => expenseRow(e, companies, trips)).join('')}</div>` : `<p class="empty">${esc(t('noExpensesHere'))}</p>`}
      ${list.length ? `<div class="bulk">
        <button class="btn" data-action="csv">${esc(t('exportCsv'))}</button>
        <button class="btn" data-action="receipts">${esc(t('shareReceipts'))}</button>
        ${status === 'todo' ? `<button class="btn" data-action="markall">${esc(t('markAllReported'))}</button>` : ''}
      </div>` : ''}`,
    actions: {
      csv: async () => {
        const company = companies[companyId];
        const csv = expensesCsv(list, { tripsById: trips, company });
        download(new Blob(['﻿' + csv], { type: 'text/csv' }), `expenses-${company ? company.name.replace(/\W+/g, '_') : 'all'}-${isoDate(Date.now())}.csv`);
      },
      receipts: async () => {
        const recs = [];
        for (const e of list) for (const rid of e.receiptIds || []) {
          const r = await db.get('receipts', rid);
          if (r) recs.push(r);
        }
        if (!recs.length) return toast(t('noReceiptsInList'));
        try { await shareReceipts(recs, t('receipt', { n: recs.length })); } catch { /* share cancelled */ }
      },
      markall: async () => {
        if (!(await confirmSheet(t('markReportedTitle'), t('markReportedText', { n: list.length }), t('markReportedBtn')))) return;
        for (const e of list) await db.put('expenses', { ...e, status: 'reported' });
        render();
      },
    },
    bind(root) {
      root.querySelector('#company-filter').onchange = (e) => go(link(status, e.target.value));
    },
  };
}

async function expenseFormView(id, query) {
  const existing = id ? await db.get('expenses', id) : null;
  if (id && !existing) return { title: t('title.expense'), html: `<p class="empty">${esc(t('expenseNotFound'))}</p>` };
  const { list: companyList } = await companiesById();
  const { list: tripList, byId: trips } = await tripsById();
  const active = await db.activeTrip();
  const tripId = existing ? existing.tripId : query.get('trip') ?? active?.id ?? '';
  const trip = trips[tripId];
  const e = existing || {
    id: uid(), tripId, date: isoDate(Date.now()), currency: await db.getSetting('lastCurrency', 'SEK'),
    category: '', companyId: trip?.companyId || (await db.getSetting('lastCompanyId', '')),
    status: 'todo', receiptIds: [], payment: await db.getSetting('lastPayment', ''),
    // Prefilled when adding a meal from a charging stop's restaurant list.
    merchant: query.get('merchant') || '', category: CATEGORIES.includes(query.get('category')) ? query.get('category') : '',
    placeId: query.get('place') || undefined,
  };
  const receipts = [];
  for (const rid of e.receiptIds || []) {
    const r = await db.get('receipts', rid);
    if (r) receipts.push(r);
  }
  const newReceipts = [];
  const removed = new Set();
  const ocrEnabled = await db.getSetting('receiptOcr', true);
  const thumb = (r) => `<div class="thumb" data-rid="${r.id}">${r.type.startsWith('image/') ? `<img src="${objectUrl(r.blob)}" alt="">` : `<span class="pdf">PDF</span>`}<button type="button" class="thumb-x" data-remove="${r.id}" aria-label="${esc(t('remove'))}">✕</button></div>`;

  return {
    title: existing ? t('editExpense') : t('newExpense'),
    html: `
      <form id="expense-form" class="card" autocomplete="off">
        <div class="receipt-btns">
          <label class="btn primary">${esc(t('photo'))}<input type="file" accept="image/*" capture="environment" hidden data-add></label>
          <label class="btn">${esc(t('file'))}<input type="file" accept="image/*,application/pdf" multiple hidden data-add></label>
        </div>
        <div class="thumbs" id="thumbs">${receipts.map(thumb).join('')}</div>
        <div class="ocr-status" id="ocr-status" role="status" hidden></div>
        <div class="grid2">
          <label>${esc(t('amount'))}<input name="amount" inputmode="decimal" required value="${Number.isFinite(e.amount) ? formatAmount(e.amount) : ''}" placeholder="0,00"></label>
          <label>${esc(t('currency'))}<input name="currency" list="currencies" value="${esc(e.currency)}" maxlength="3" required></label>
        </div>
        <datalist id="currencies">${CURRENCIES.map((c) => `<option value="${c}">`).join('')}</datalist>
        <div class="grid2">
          <label>${esc(t('date'))}<input name="date" type="date" required value="${esc(e.date)}"></label>
          <label>${esc(t('category'))}<select name="category" required>${options(CATEGORIES, e.category, { label: categoryLabel, empty: t('choose') })}</select></label>
        </div>
        <label>${esc(t('merchant'))}<input name="merchant" value="${esc(e.merchant || '')}" placeholder="${esc(t('merchantPh'))}"></label>
        <label>${esc(t('description'))}<input name="description" value="${esc(e.description || '')}" placeholder="${esc(t('descriptionPh'))}"></label>
        <div class="grid2">
          <label>${esc(t('vatOptional'))}<input name="vat" inputmode="decimal" value="${Number.isFinite(e.vat) ? formatAmount(e.vat) : ''}"></label>
          <label>${esc(t('paidWith'))}<select name="payment">${options(PAYMENTS, e.payment, { label: paymentLabel, empty: '—' })}</select></label>
        </div>
        <label>${esc(t('company'))}<select name="companyId">${options(companyList, e.companyId, { value: (c) => c.id, label: (c) => c.name, empty: '—' })}</select></label>
        ${!companyList.length ? `<p class="muted small">${esc(t('addCompaniesHint'))}</p>` : ''}
        <label>${esc(t('trip'))}<select name="tripId">${options(tripList.slice(0, 30), e.tripId, { value: (x) => x.id, label: (x) => (x.title || x.destination) && tripStart(x) ? `${isoDate(tripStart(x))} ${tripTitle(x)}` : tripTitle(x), empty: t('noTrip') })}</select></label>
        <label>${esc(t('status'))}<select name="status">${options(STATUSES, e.status, { value: (s) => s.id, label: (s) => s.label })}</select></label>
        <div class="grid2"><a class="btn" href="${existing ? `#/expense/${e.id}` : 'javascript:history.back()'}">${esc(t('cancel'))}</a><button class="btn primary" type="submit">${esc(t('save'))}</button></div>
      </form>`,
    bind(root) {
      const form = root.querySelector('#expense-form');
      const thumbs = root.querySelector('#thumbs');
      const status = root.querySelector('#ocr-status');
      // Fields the user has edited are never overwritten by receipt reading.
      const touched = new Set();
      form.addEventListener('input', (ev) => {
        if (!ev.target.name) return;
        touched.add(ev.target.name);
        ev.target.classList.remove('autofilled');
      });
      const showStatus = (msg, kind) => {
        status.hidden = false;
        status.className = `ocr-status ${kind}`;
        status.textContent = msg;
      };
      const fillFromReceipt = (fields) => {
        const map = {
          amount: [(v) => formatAmount(v), 'amount'],
          vat: [(v) => formatAmount(v), 'vat'],
          date: [(v) => v, 'date'],
          currency: [(v) => v, 'currency'],
          merchant: [(v) => v, 'merchant'],
          category: [(v) => v, 'category'],
        };
        const filled = [];
        for (const [name, [fmt, labelKey]] of Object.entries(map)) {
          if (fields[name] == null) continue;
          const el = form[name];
          // Date and currency start with defaults on a new expense; those may be replaced.
          const replaceable = el.value === '' || (!existing && (name === 'date' || name === 'currency'));
          if (touched.has(name) || !replaceable) continue;
          const value = fmt(fields[name]);
          if (el.value !== value) el.value = value;
          el.classList.add('autofilled');
          filled.push(t(labelKey));
        }
        return filled;
      };
      let ocrRun = 0;
      const runOcr = async (blob) => {
        const run = ++ocrRun;
        showStatus(t('ocrLoading', { pct: 0 }), 'busy');
        try {
          const { fields } = await readReceipt(blob, (stage, f) => {
            if (run === ocrRun) showStatus(t(stage === 'reading' ? 'ocrReading' : 'ocrLoading', { pct: Math.round(f * 100) }), 'busy');
          });
          if (run !== ocrRun || !form.isConnected) return;
          const filled = fillFromReceipt(fields);
          showStatus(filled.length ? t('ocrFilled', { fields: filled.join(', ') }) : t('ocrNothing'), filled.length ? 'ok' : 'warn');
        } catch (err) {
          console.error(err);
          if (run === ocrRun) showStatus(t('ocrFailed', { msg: err?.message || String(err) }), 'warn');
        }
      };
      root.querySelectorAll('[data-add]').forEach((input) => {
        input.onchange = async () => {
          const added = [];
          for (const f of input.files) {
            const r = await saveReceipt(f);
            newReceipts.push(r);
            added.push(r);
            thumbs.insertAdjacentHTML('beforeend', thumb(r));
          }
          input.value = '';
          if (!ocrEnabled || !added.length) return;
          const image = added.find((r) => r.type.startsWith('image/'));
          if (image) runOcr(image.blob);
          else showStatus(t('ocrPdf'), 'warn');
        };
      });
      thumbs.onclick = (ev) => {
        const rid = ev.target.closest('[data-remove]')?.dataset.remove;
        if (!rid) return;
        removed.add(rid);
        thumbs.querySelector(`[data-rid="${rid}"]`).remove();
      };
      form.tripId.onchange = () => {
        const x = trips[form.tripId.value];
        if (x?.companyId && !form.companyId.value) form.companyId.value = x.companyId;
      };
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const fd = Object.fromEntries(new FormData(form));
        const amount = parseAmount(fd.amount);
        if (!Number.isFinite(amount)) return toast(t('invalidAmount'));
        const vat = parseAmount(fd.vat);
        const receiptIds = [...(e.receiptIds || []), ...newReceipts.map((r) => r.id)].filter((rid) => !removed.has(rid));
        for (const rid of removed) await db.remove('receipts', rid);
        const saved = {
          ...e, ...fd, amount, vat: Number.isFinite(vat) ? vat : undefined,
          currency: fd.currency.trim().toUpperCase(), merchant: fd.merchant.trim(), description: fd.description.trim(),
          receiptIds, createdAt: e.createdAt || Date.now(), updatedAt: Date.now(),
        };
        await db.put('expenses', saved);
        await db.setSetting('lastCurrency', saved.currency);
        if (saved.companyId) await db.setSetting('lastCompanyId', saved.companyId);
        if (saved.payment) await db.setSetting('lastPayment', saved.payment);
        toast(t('saved'));
        if (existing) go(`#/expense/${saved.id}`);
        else location.replace(`#/expense/${saved.id}`);
      };
      if (!existing) form.amount.focus();
    },
  };
}

async function expenseView(id) {
  const e = await db.get('expenses', id);
  if (!e) return { title: t('title.expense'), html: `<p class="empty">${esc(t('expenseNotFound'))}</p>` };
  const { byId: companies } = await companiesById();
  const company = companies[e.companyId];
  const trip = await db.get('trips', e.tripId);
  const v = expenseValues(e, { trip, company });
  const receipts = [];
  for (const rid of e.receiptIds || []) {
    const r = await db.get('receipts', rid);
    if (r) receipts.push(r);
  }
  // "Next" walks through the remaining expenses to report for the same company.
  const place = e.placeId ? await db.get('places', e.placeId) : null;
  const queue = sortExpenses(await db.all('expenses')).filter((x) => x.status === 'todo' && x.companyId === e.companyId && x.id !== e.id);
  return {
    title: e.merchant || categoryLabel(e.category) || t('title.expense'),
    html: `
      <section class="card center">
        <div class="hero-amount">${money(e.amount, e.currency)}</div>
        <div class="muted">${esc(e.date)} · ${esc(categoryLabel(e.category))}${company ? ` · ${esc(company.name)}` : ''}</div>
        <div class="seg" role="group" aria-label="${esc(t('status'))}">${STATUSES.map((s) => `<button class="${s.id === e.status ? 'on' : ''}" data-action="status" data-status="${s.id}">${esc(s.label)}</button>`).join('')}</div>
      </section>
      <button class="btn primary block" data-action="copyall">${esc(company ? t('copyAllFormat', { company: company.name }) : t('copyAll'))}</button>
      <p class="muted small center">${esc(t('tapToCopy'))}</p>
      <div class="copy-list">
        ${copyRow(t('date'), v.date)}
        ${copyRow(t('amount'), v.amount)}
        ${copyRow(t('currency'), v.currency)}
        ${copyRow(company?.categoryMap?.[e.category] ? t('categoryFor', { company: company.name }) : t('category'), v.category, t('category'))}
        ${copyRow(t('merchant'), v.merchant)}
        ${copyRow(t('description'), v.description)}
        ${copyRow(t('vat'), v.vat)}
        ${copyRow(t('paidWith'), v.payment)}
        ${trip ? copyRow(t('trip'), v.trip) : ''}
        ${trip ? copyRow(t('purpose'), v.purpose) : ''}
      </div>
      ${receipts.length ? `<section><div class="row between"><h3>${esc(t('receipt', { n: receipts.length }))}</h3><button class="btn small primary" data-action="share">${esc(t('share'))}</button></div>
        <div class="thumbs large">${receipts.map((r) => r.type.startsWith('image/')
          ? `<a href="${objectUrl(r.blob)}" target="_blank" class="thumb"><img src="${objectUrl(r.blob)}" alt="${esc(t('receipt', { n: 1 }))}"></a>`
          : `<a href="${objectUrl(r.blob)}" target="_blank" class="thumb"><span class="pdf">PDF</span></a>`).join('')}</div>
        <button class="link small" data-action="save">${esc(t('saveReceipt'))}</button></section>` : `<p class="muted small center">${esc(t('noReceipt'))}</p>`}
      ${e.placeId ? `<button class="btn block" data-action="rateplace">${place?.rating ? `${'★'.repeat(place.rating)}${'☆'.repeat(5 - place.rating)} · ` : ''}${esc(t('rateTitle', { name: e.merchant || place?.name || '' }))}</button>` : ''}
      ${trip ? `<p class="center"><a class="link" href="#/trip/${trip.id}">${esc(t('tripLink', { trip: tripTitle(trip) }))}</a></p>` : ''}
      <div class="grid2"><a class="btn" href="#/expense/${e.id}/edit">${esc(t('edit'))}</a><button class="btn danger" data-action="delete">${esc(t('delete'))}</button></div>
      ${queue.length ? `<a class="btn block" href="#/expense/${queue[0].id}">${esc(t('nextToReport', { n: queue.length }))}</a>` : ''}`,
    actions: {
      copy: copyAction,
      rateplace: async () => {
        if (await rateSheet({ ...place, id: e.placeId, name: place?.name || e.merchant })) render();
      },
      copyall: () => copyText(renderTemplate(company?.expenseTemplate || DEFAULT_EXPENSE_TEMPLATE, v), t('expenseCopied')),
      status: async (el) => {
        await db.put('expenses', { ...e, status: el.dataset.status, updatedAt: Date.now() });
        render();
      },
      share: async () => {
        try { await shareReceipts(receipts, e.merchant || t('receipt', { n: 1 })); } catch { /* share cancelled */ }
      },
      save: () => receipts.forEach((r) => download(r.blob, `${e.date}_${(e.merchant || e.category || 'receipt').replace(/\W+/g, '_')}.${r.name.split('.').pop()}`)),
      delete: async () => {
        if (!(await confirmSheet(t('deleteExpense'), t('deleteExpenseText'), t('delete'), true))) return;
        await db.deleteExpense(e);
        history.back();
      },
    },
  };
}

async function companiesView() {
  const { list } = await companiesById();
  return {
    title: t('companies'),
    html: `
      <p class="muted">${esc(t('companiesIntro'))}</p>
      ${list.length ? `<div class="list">${list.map((c) => `<a class="list-item" href="#/company/${c.id}"><div class="li-main"><div class="li-title">${esc(c.name)}</div><div class="li-sub">${esc(c.system || '')}</div></div><div class="li-end">›</div></a>`).join('')}</div>` : `<p class="empty">${esc(t('noCompanies'))}</p>`}
      <a class="btn primary block" href="#/company/new">${esc(t('addCompany'))}</a>`,
  };
}

async function companyView(id) {
  const isNew = id === 'new';
  const c = isNew ? { id: uid(), name: '', system: '', expenseTemplate: DEFAULT_EXPENSE_TEMPLATE, tripTemplate: defaultTripTemplate(), decimalSep: ',', csvSep: ';', categoryMap: {} } : await db.get('companies', id);
  if (!c) return { title: t('title.company'), html: `<p class="empty">${esc(t('companyNotFound'))}</p>` };
  const chips = (list, target) => list.map((p) => `<button type="button" class="chip" data-insert="{${p}}" data-target="${target}">{${p}}</button>`).join('');
  return {
    title: isNew ? t('newCompany') : c.name,
    html: `
      <form id="company-form" class="card">
        <label>${esc(t('name'))}<input name="name" required value="${esc(c.name)}" placeholder="${esc(t('namePh'))}"></label>
        <label>${esc(t('system'))}<input name="system" value="${esc(c.system || '')}" placeholder="${esc(t('systemPh'))}"></label>
        <label>${esc(t('expenseFormat'))}<textarea name="expenseTemplate" rows="3" class="mono">${esc(c.expenseTemplate)}</textarea></label>
        <div class="chips small">${chips(EXPENSE_PLACEHOLDERS, 'expenseTemplate')}</div>
        <label>${esc(t('tripFormat'))}<textarea name="tripTemplate" rows="5" class="mono">${esc(c.tripTemplate)}</textarea></label>
        <div class="chips small">${chips(TRIP_PLACEHOLDERS, 'tripTemplate')}</div>
        <p class="muted small">${t('templateHelp')}</p>
        <div class="grid2">
          <label>${esc(t('decimalSep'))}<select name="decimalSep">${options([',', '.'], c.decimalSep, { label: (x) => (x === ',' ? t('comma') : t('point')) })}</select></label>
          <label>${esc(t('csvSep'))}<select name="csvSep">${options([';', ',', '\t'], c.csvSep, { label: (x) => ({ ';': t('semicolon'), ',': t('commaSep'), '\t': t('tab') })[x] })}</select></label>
        </div>
        <h3>${esc(t('categoryNames'))}</h3>
        <p class="muted small">${esc(t('categoryNamesHint'))}</p>
        <div class="map-grid">${CATEGORIES.map((cat) => `<span>${esc(categoryLabel(cat))}</span><input data-cat="${esc(cat)}" value="${esc(c.categoryMap?.[cat] || '')}" placeholder="${esc(categoryLabel(cat))}">`).join('')}</div>
        <button class="btn primary block" type="submit">${esc(t('save'))}</button>
      </form>
      ${isNew ? '' : `<button class="btn danger block subtle" data-action="delete">${esc(t('deleteCompany'))}</button>`}`,
    actions: {
      delete: async () => {
        if (!(await confirmSheet(t('deleteCompany'), t('deleteCompanyText', { name: c.name }), t('delete'), true))) return;
        await db.remove('companies', c.id);
        go('#/companies');
      },
    },
    bind(root) {
      const form = root.querySelector('#company-form');
      root.querySelectorAll('[data-insert]').forEach((chip) => {
        chip.onclick = () => {
          const ta = form[chip.dataset.target];
          const pos = ta.selectionStart ?? ta.value.length;
          ta.value = ta.value.slice(0, pos) + chip.dataset.insert + ta.value.slice(ta.selectionEnd ?? pos);
          ta.focus();
          ta.selectionStart = ta.selectionEnd = pos + chip.dataset.insert.length;
        };
      });
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const fd = Object.fromEntries(new FormData(form));
        const categoryMap = {};
        form.querySelectorAll('[data-cat]').forEach((i) => { if (i.value.trim()) categoryMap[i.dataset.cat] = i.value.trim(); });
        await db.put('companies', { ...c, ...fd, name: fd.name.trim(), categoryMap });
        toast(t('saved'));
        go('#/companies');
      };
    },
  };
}

async function settingsView() {
  const rate = await db.getSetting('mileageRate', 25);
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  const counts = {};
  for (const s of ['trips', 'expenses', 'receipts']) counts[s] = (await db.all(s)).length;
  const lastBackup = await db.getSetting('lastBackup', null);
  const ocr = await db.getSetting('receiptOcr', true);
  return {
    title: t('nav.settings'),
    html: `
      <section class="card">
        <label>${esc(t('language'))}<select id="language">${options(LANGUAGES, getLanguage(), { value: (l) => l.id, label: (l) => l.label })}</select></label>
      </section>
      <a class="list-item card" href="#/cars"><div class="li-main"><div class="li-title">${esc(t('carsLink'))}</div><div class="li-sub">${esc(t('carsLinkSub'))}</div></div><div class="li-end">›</div></a>
      <a class="list-item card" href="#/places"><div class="li-main"><div class="li-title">${esc(t('ratedPlacesLink'))}</div><div class="li-sub">${esc(t('ratedPlacesSub'))}</div></div><div class="li-end">›</div></a>
      <a class="list-item card" href="#/companies"><div class="li-main"><div class="li-title">${esc(t('companiesLink'))}</div><div class="li-sub">${esc(t('companiesLinkSub'))}</div></div><div class="li-end">›</div></a>
      <section class="card">
        <label class="check"><input type="checkbox" id="ocr"${ocr ? ' checked' : ''}><span>${esc(t('receiptReading'))}</span></label>
        <p class="muted small">${esc(t('receiptReadingHint'))}</p>
      </section>
      <section class="card">
        <label>${esc(t('mileageRate'))}<input id="rate" inputmode="decimal" value="${formatAmount(rate)}"></label>
        <p class="muted small">${esc(t('mileageRateHint'))}</p>
      </section>
      <section class="card">
        <h3>${esc(t('backup'))}</h3>
        <p class="muted small">${esc(t('backupInfo', { ...counts, size: est ? ` (${(est.usage / 1048576).toFixed(1)} MB)` : '' }))} ${esc(persisted ? t('persisted') : t('notPersisted'))}</p>
        <p class="muted small">${esc(t('lastBackup', { when: lastBackup ? dateTime(lastBackup) : t('never') }))}</p>
        <div class="grid2">
          <button class="btn primary" data-action="backup">${esc(t('exportBackup'))}</button>
          <label class="btn">${esc(t('restore'))}<input type="file" accept="application/json,.json" hidden id="restore"></label>
        </div>
      </section>
      <section class="card">
        <h3>${esc(t('about'))}</h3>
        <p class="muted small">${esc(t('aboutText'))}</p>
      </section>`,
    actions: {
      backup: async () => {
        download(await db.exportBackup(), `travel-backup-${isoDate(Date.now())}.json`);
        await db.setSetting('lastBackup', Date.now());
        render();
      },
    },
    bind(root) {
      root.querySelector('#language').onchange = async (ev) => {
        await applyLanguage(ev.target.value, { save: true });
        render();
      };
      root.querySelector('#ocr').onchange = async (ev) => {
        await db.setSetting('receiptOcr', ev.target.checked);
        toast(t('saved'));
      };
      root.querySelector('#rate').onchange = async (ev) => {
        const n = parseAmount(ev.target.value);
        if (Number.isFinite(n)) { await db.setSetting('mileageRate', n); toast(t('saved')); }
      };
      root.querySelector('#restore').onchange = async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        if (!(await confirmSheet(t('restoreTitle'), t('restoreText'), t('restore')))) return;
        try {
          const n = await db.importBackup(file);
          await applyLanguage(await db.getSetting('language', getLanguage()));
          toast(t('restored', { n }));
          render();
        } catch (err) {
          toast(t('restoreFailed', { msg: err.message }));
        }
      };
    },
  };
}

// ---------- startup ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
}
db.requestPersistence();
db.removeOrphanReceipts().catch(() => {});

(async () => {
  await applyLanguage(cachedLanguage() || DEFAULT_LANGUAGE);
  try {
    const saved = await db.getSetting('language', null);
    if (saved && saved !== getLanguage()) await applyLanguage(saved);
  } catch { /* first run or storage unavailable: keep default */ }
  render();
})();
