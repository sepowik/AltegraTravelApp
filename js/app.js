import * as db from './db.js';
import * as geo from './geo.js';
import { saveReceipt, shareReceipts, download } from './receipts.js';
import { esc, options, toast, copyText, sheet, confirmSheet, objectUrl, revokeUrls } from './ui.js';
import {
  TRANSPORTS, CATEGORIES, CURRENCIES, STATUSES, transportById, uid, isoDate, isoTime, dateTime,
  toLocalInput, formatDuration, parseAmount, formatAmount, formatKm, tripLegs, ownCarKm, tripStart, tripEnd,
  placeLabel, tripTitle, expenseValues, tripValues, renderTemplate, expensesCsv,
  DEFAULT_EXPENSE_TEMPLATE, DEFAULT_TRIP_TEMPLATE, EXPENSE_PLACEHOLDERS, TRIP_PLACEHOLDERS,
} from './util.js';

const main = document.getElementById('main');
const titleEl = document.getElementById('title');
let actions = {};
let tickTimer;
let lastHash = null;

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
    else view = { title: 'Not found', html: '<p class="empty">Page not found.</p>' };
  } catch (err) {
    console.error(err);
    view = { title: 'Error', html: `<p class="empty">Something went wrong: ${esc(err.message)}</p>` };
  }
  titleEl.textContent = view.title || 'Travel';
  main.innerHTML = view.html;
  actions = view.actions || {};
  view.bind?.(main);
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const tab = a.dataset.tab;
    const active = tab === (section || 'home') || (tab === 'trips' && section === 'trip') || (tab === 'expenses' && section === 'expense') || (tab === 'settings' && (section === 'companies' || section === 'company'));
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

// ---------- shared data helpers ----------

async function companiesById() {
  const list = await db.all('companies');
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { list, byId: Object.fromEntries(list.map((c) => [c.id, c])) };
}

async function tripsById() {
  const list = await db.all('trips');
  list.sort((a, b) => (tripStart(b) || 0) - (tripStart(a) || 0));
  return { list, byId: Object.fromEntries(list.map((t) => [t.id, t])) };
}

function sortExpenses(list) {
  return list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
}

function money(amount, currency) {
  return `${formatAmount(amount, ',')} ${esc(currency || '')}`;
}

function statusBadge(status) {
  const s = STATUSES.find((x) => x.id === status) || STATUSES[0];
  return `<span class="badge status-${s.id}">${s.label}</span>`;
}

function totalsByCurrency(expenses) {
  const t = {};
  for (const e of expenses) t[e.currency] = (t[e.currency] || 0) + (e.amount || 0);
  return Object.entries(t).map(([c, a]) => money(a, c)).join(' + ') || '0';
}

function expenseRow(e, companies, trips) {
  const c = companies[e.companyId];
  const t = trips?.[e.tripId];
  return `<a class="list-item" href="#/expense/${e.id}">
    <div class="li-main">
      <div class="li-title">${esc(e.merchant || e.category || 'Expense')}${e.receiptIds?.length ? ' <span title="Has receipt">🧾</span>' : ''}</div>
      <div class="li-sub">${esc(e.date)} · ${esc(e.category)}${c ? ` · ${esc(c.name)}` : ''}${t ? ` · ${esc(tripTitle(t))}` : ''}</div>
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

const copyAction = (el) => copyText(el.dataset.value, `${el.dataset.label} copied`);

// ---------- trip actions: start / change transport / end ----------

function transportGrid() {
  return `<div class="transport-grid">${TRANSPORTS.map((t) => `<button class="transport-btn" data-transport="${t.id}"><span class="t-icon">${t.icon}</span><span>${esc(t.label)}</span></button>`).join('')}</div>`;
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
    toast(`No position: ${pos.error}`);
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
  sheet('Start trip', `
    <p class="muted">Departure ${isoTime(time)} recorded. Pick how you are travelling:</p>
    ${transportGrid()}
    <details class="more"><summary>Destination, purpose &amp; company (optional)</summary>
      <label>Destination<input name="destination" placeholder="e.g. Stockholm, Customer X"></label>
      <label>Purpose<input name="purpose" placeholder="e.g. Project meeting"></label>
      <label>Bill to company<select name="companyId">${options(companies, lastCompany, { value: (c) => c.id, label: (c) => c.name, empty: '—' })}</select></label>
    </details>`, (dlg, close) => {
    dlg.querySelectorAll('[data-transport]').forEach((btn) => {
      btn.onclick = async () => {
        const val = (n) => dlg.querySelector(`[name=${n}]`).value.trim();
        const point = { id: uid(), time, transport: btn.dataset.transport };
        const trip = {
          id: uid(), status: 'active', points: [point], createdAt: time,
          destination: val('destination'), purpose: val('purpose'), companyId: val('companyId'),
        };
        await db.put('trips', trip);
        if (trip.companyId) await db.setSetting('lastCompanyId', trip.companyId);
        close();
        navigator.vibrate?.(40);
        toast('Trip started');
        render();
        capturePosition(trip.id, point.id, position);
      };
    });
  });
}

async function changeTransport(tripId) {
  const time = Date.now();
  const position = geo.getPosition();
  sheet('Change transport', `<p class="muted">New leg from ${isoTime(time)}. Now travelling by:</p>${transportGrid()}`, (dlg, close) => {
    dlg.querySelectorAll('[data-transport]').forEach((btn) => {
      btn.onclick = async () => {
        const trip = await db.get('trips', tripId);
        const point = { id: uid(), time, transport: btn.dataset.transport };
        trip.points.push(point);
        await db.put('trips', trip);
        close();
        navigator.vibrate?.(40);
        toast(`${transportById(point.transport).label} from ${isoTime(time)}`);
        render();
        capturePosition(trip.id, point.id, position);
      };
    });
  });
}

async function endTrip(tripId) {
  const time = Date.now();
  if (!(await confirmSheet('End trip', `Record arrival at ${isoTime(time)} and your current position?`, 'End trip'))) return;
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
    toast(done ? `Distance calculated for ${done} leg${done > 1 ? 's' : ''}` : failed ? 'Could not calculate distance (offline or missing position)' : 'No car legs to calculate');
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
    const t = transportById(current?.transport);
    const tripExpenses = expenses.filter((e) => e.tripId === trip.id);
    tripHtml = `
      <section class="card active-trip">
        <div class="row between"><span class="badge live">● On trip</span><a href="#/trip/${trip.id}" class="link">Details ›</a></div>
        <h2>${esc(tripTitle(trip))}</h2>
        <p class="muted">Left ${dateTime(tripStart(trip))} from ${esc(placeLabel(trip.points[0]))}</p>
        <div class="big-stat"><span class="t-icon">${t.icon}</span><div><div class="stat-label">${esc(t.label)} since ${isoTime(current.from.time)}</div><div class="stat-value" id="elapsed">${formatDuration(Date.now() - tripStart(trip))}</div></div></div>
        <div class="grid2">
          <a class="btn primary big" href="#/expense/new?trip=${trip.id}">＋ Expense</a>
          <button class="btn big" data-action="change" data-id="${trip.id}">⇄ Change transport</button>
        </div>
        <button class="btn danger block" data-action="end" data-id="${trip.id}">■ End trip</button>
        ${tripExpenses.length ? `<p class="muted small">${tripExpenses.length} expense${tripExpenses.length > 1 ? 's' : ''} on this trip: ${totalsByCurrency(tripExpenses)}</p>` : ''}
      </section>`;
  } else {
    tripHtml = `
      <section class="start-wrap">
        <button class="start-btn" data-action="start"><span>▶</span>Start trip</button>
        <p class="muted center">Records time, place and transport in one tap.</p>
        <a class="btn block" href="#/expense/new">＋ Add expense without trip</a>
      </section>`;
  }
  return {
    title: 'Travel expenses',
    html: `${tripHtml}
      <section>
        <div class="row between"><h3>To report (${todo.length})</h3>${todo.length ? `<a class="link" href="#/expenses?status=todo">All ›</a>` : ''}</div>
        ${todo.length ? `<p class="muted small">${totalsByCurrency(todo)}</p><div class="list">${todo.slice(0, 8).map((e) => expenseRow(e, companies, trips)).join('')}</div>` : '<p class="empty">Nothing waiting to be reported 🎉</p>'}
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
  const rows = list.map((t) => {
    const ex = expenses.filter((e) => e.tripId === t.id);
    const todo = ex.filter((e) => e.status === 'todo').length;
    const start = tripStart(t);
    const end = tripEnd(t);
    const icons = [...new Set(t.points.filter((p) => p.transport).map((p) => transportById(p.transport).icon))].join(' ');
    return `<a class="list-item" href="#/trip/${t.id}">
      <div class="li-main"><div class="li-title">${esc(tripTitle(t))} ${t.status === 'active' ? '<span class="badge live">● Active</span>' : ''}</div>
      <div class="li-sub">${start ? isoDate(start) : ''}${end && isoDate(end) !== isoDate(start) ? ` – ${isoDate(end)}` : ''} · ${icons}${companies[t.companyId] ? ` · ${esc(companies[t.companyId].name)}` : ''}</div></div>
      <div class="li-end">${ex.length ? `<div class="small">${ex.length} exp.</div>` : ''}${todo ? `<span class="badge status-todo">${todo} to report</span>` : ''}</div>
    </a>`;
  });
  return {
    title: 'Trips',
    html: list.length ? `<div class="list">${rows.join('')}</div>` : '<p class="empty">No trips yet. Start one from the home screen.</p>',
  };
}

async function tripView(id) {
  const trip = await db.get('trips', id);
  if (!trip) return { title: 'Trip', html: '<p class="empty">Trip not found.</p>' };
  const { list: companyList, byId: companies } = await companiesById();
  const company = companies[trip.companyId];
  const expenses = sortExpenses(await db.byIndex('expenses', 'tripId', id));
  const legs = tripLegs(trip);
  const start = tripStart(trip);
  const end = tripEnd(trip);
  const km = ownCarKm(trip);
  const values = tripValues(trip, company);
  const mileageRate = await db.getSetting('mileageRate', 25);

  const pointHtml = (p, i) => {
    const isEnd = trip.status === 'done' && i === trip.points.length - 1;
    const label = i === 0 ? 'Departure' : isEnd ? 'Return' : 'Change';
    const leg = !isEnd ? legs.find((l) => l.index === i) : null;
    const isCar = ['car', 'company_car', 'rental'].includes(p.transport);
    return `<li class="tl-point">
      <div class="tl-head"><strong>${label}</strong>
        <input type="datetime-local" class="inline" value="${toLocalInput(p.time)}" data-point="${p.id}" data-field="time"></div>
      <div class="tl-place">
        <input class="inline wide" value="${esc(p.place || '')}" placeholder="${esc(placeLabel(p))}" data-point="${p.id}" data-field="place">
        ${Number.isFinite(p.lat) ? `<a class="link small" href="${geo.mapUrl(p)}" target="_blank" rel="noopener">map</a>` : `<button class="link small" data-action="relocate" data-point="${p.id}">${p.positionError ? 'retry GPS' : 'locating…'}</button>`}
      </div>
      ${leg ? `<div class="tl-leg">
        <select class="inline" data-point="${p.id}" data-field="transport">${options(TRANSPORTS, p.transport, { value: (x) => x.id, label: (x) => `${x.icon} ${x.label}` })}</select>
        ${leg.to ? `<span class="muted small">${formatDuration(leg.to.time - p.time)}</span>` : `<span class="badge live">● now</span>`}
        ${isCar && leg.to ? `<span class="km"><input class="inline num" inputmode="decimal" value="${Number.isFinite(p.distanceKm) ? String(p.distanceKm).replace('.', ',') : ''}" placeholder="km" data-point="${p.id}" data-field="distanceKm"> km
          <button class="link small" data-action="roadkm" data-index="${i}">by road</button></span>` : ''}
      </div>` : ''}
    </li>`;
  };

  return {
    title: tripTitle(trip),
    html: `
      ${trip.status === 'active' ? `<div class="grid2"><button class="btn" data-action="change">⇄ Change transport</button><button class="btn danger" data-action="end">■ End trip</button></div>` : ''}
      <section class="card">
        <label>Destination<input name="destination" value="${esc(trip.destination || '')}" placeholder="e.g. Stockholm"></label>
        <label>Purpose<input name="purpose" value="${esc(trip.purpose || '')}" placeholder="e.g. Customer meeting"></label>
        <label>Bill to company<select name="companyId">${options(companyList, trip.companyId, { value: (c) => c.id, label: (c) => c.name, empty: '—' })}</select></label>
        <label>Notes<textarea name="notes" rows="2">${esc(trip.notes || '')}</textarea></label>
      </section>
      <section>
        <h3>Timeline</h3>
        <ol class="timeline">${trip.points.map(pointHtml).join('')}</ol>
        <p class="muted small">Duration ${formatDuration((end || Date.now()) - start)}${km ? ` · Own car ${formatKm(km)} km` : ''}</p>
      </section>
      <section>
        <div class="row between"><h3>Copy</h3><button class="btn small primary" data-action="copytrip">Copy summary</button></div>
        <div class="copy-list">
          ${copyRow('Departure date', values.start_date)}
          ${copyRow('Departure time', values.start_time)}
          ${copyRow('From', values.start_place)}
          ${copyRow('Return date', values.end_date)}
          ${copyRow('Return time', values.end_time)}
          ${copyRow('Back at', values.end_place)}
          ${copyRow('Destination', values.destination)}
          ${copyRow('Purpose', values.purpose)}
          ${copyRow('Transport', values.transport)}
          ${copyRow('Own car km', values.car_km)}
        </div>
      </section>
      <section>
        <div class="row between"><h3>Expenses (${expenses.length})</h3><a class="btn small primary" href="#/expense/new?trip=${trip.id}">＋ Add</a></div>
        ${expenses.length ? `<p class="muted small">${totalsByCurrency(expenses)}</p><div class="list">${expenses.map((e) => expenseRow(e, companies)).join('')}</div>` : '<p class="empty">No expenses on this trip yet.</p>'}
        ${km && trip.status === 'done' && !expenses.some((e) => e.category === 'Mileage') ? `<button class="btn block" data-action="mileage">🚗 Add mileage expense (${formatKm(km)} km × ${formatAmount(mileageRate)} SEK/mil)</button>` : ''}
      </section>
      <button class="btn danger block subtle" data-action="delete">Delete trip</button>`,
    actions: {
      copy: copyAction,
      change: () => changeTransport(trip.id),
      end: () => endTrip(trip.id),
      roadkm: (el) => calculateCarDistances(trip.id, { legIndex: Number(el.dataset.index) }),
      relocate: async (el) => {
        toast('Getting position…');
        const t = await db.get('trips', trip.id);
        const p = t.points.find((x) => x.id === el.dataset.point);
        p.positionError = undefined;
        await db.put('trips', t);
        await capturePosition(trip.id, p.id, geo.getPosition());
      },
      copytrip: () => copyText(renderTemplate(company?.tripTemplate || DEFAULT_TRIP_TEMPLATE, values), 'Trip summary copied'),
      mileage: async () => {
        const e = {
          id: uid(), tripId: trip.id, companyId: trip.companyId || '', date: isoDate(start), createdAt: Date.now(),
          amount: Math.round((km / 10) * mileageRate * 100) / 100, currency: 'SEK', category: 'Mileage',
          merchant: '', description: `Own car ${formatKm(km)} km (${formatAmount(km / 10)} mil × ${formatAmount(mileageRate)} SEK)`,
          status: 'todo', receiptIds: [],
        };
        await db.put('expenses', e);
        go(`#/expense/${e.id}`);
      },
      delete: async () => {
        if (!(await confirmSheet('Delete trip', 'The trip is deleted. Its expenses are kept but no longer linked to a trip.', 'Delete', true))) return;
        for (const e of expenses) await db.put('expenses', { ...e, tripId: '' });
        await db.remove('trips', trip.id);
        go('#/trips');
      },
    },
    bind(root) {
      root.querySelectorAll('.card [name]').forEach((input) => {
        input.addEventListener('change', async () => {
          const t = await db.get('trips', trip.id);
          t[input.name] = input.value.trim();
          await db.put('trips', t);
          if (input.name === 'companyId') {
            if (t.companyId) await db.setSetting('lastCompanyId', t.companyId);
            render();
          } else {
            titleEl.textContent = tripTitle(t);
          }
        });
      });
      root.querySelectorAll('[data-point]').forEach((input) => {
        if (input.tagName === 'BUTTON') return;
        input.addEventListener('change', async () => {
          const t = await db.get('trips', trip.id);
          const p = t.points.find((x) => x.id === input.dataset.point);
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
          await db.put('trips', t);
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
    title: 'Expenses',
    html: `
      <div class="chips">${[{ id: '', label: 'All' }, ...STATUSES].map((s) => `<a class="chip${s.id === status ? ' on' : ''}" href="${link(s.id, companyId)}">${s.label}</a>`).join('')}</div>
      <select id="company-filter">${options([{ id: '', name: 'All companies' }, ...companyList, { id: 'none', name: 'No company' }], companyId, { value: (c) => c.id, label: (c) => c.name })}</select>
      <div class="row between"><p class="muted small">${list.length} expense${list.length === 1 ? '' : 's'} · ${totalsByCurrency(list)}</p><a class="btn small primary" href="#/expense/new">＋ Add</a></div>
      ${list.length ? `<div class="list">${list.map((e) => expenseRow(e, companies, trips)).join('')}</div>` : '<p class="empty">No expenses here.</p>'}
      ${list.length ? `<div class="bulk">
        <button class="btn" data-action="csv">⬇ Export CSV</button>
        <button class="btn" data-action="receipts">🧾 Share receipts</button>
        ${status === 'todo' ? '<button class="btn" data-action="markall">✓ Mark all reported</button>' : ''}
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
        if (!recs.length) return toast('No receipts in this list');
        try { await shareReceipts(recs, 'Receipts'); } catch { /* share cancelled */ }
      },
      markall: async () => {
        if (!(await confirmSheet('Mark as reported', `Mark ${list.length} expenses as reported?`, 'Mark reported'))) return;
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
  if (id && !existing) return { title: 'Expense', html: '<p class="empty">Expense not found.</p>' };
  const { list: companyList, byId: companies } = await companiesById();
  const { list: tripList, byId: trips } = await tripsById();
  const active = await db.activeTrip();
  const tripId = existing ? existing.tripId : query.get('trip') ?? active?.id ?? '';
  const trip = trips[tripId];
  const e = existing || {
    id: uid(), tripId, date: isoDate(Date.now()), currency: await db.getSetting('lastCurrency', 'SEK'),
    category: '', companyId: trip?.companyId || (await db.getSetting('lastCompanyId', '')),
    status: 'todo', receiptIds: [], payment: await db.getSetting('lastPayment', ''),
  };
  const receipts = [];
  for (const rid of e.receiptIds || []) {
    const r = await db.get('receipts', rid);
    if (r) receipts.push(r);
  }
  const newReceipts = [];
  const removed = new Set();
  const thumb = (r) => `<div class="thumb" data-rid="${r.id}">${r.type.startsWith('image/') ? `<img src="${objectUrl(r.blob)}" alt="">` : `<span class="pdf">PDF</span>`}<button type="button" class="thumb-x" data-remove="${r.id}" aria-label="Remove">✕</button></div>`;

  return {
    title: existing ? 'Edit expense' : 'New expense',
    html: `
      <form id="expense-form" class="card" autocomplete="off">
        <div class="receipt-btns">
          <label class="btn primary">📷 Photo<input type="file" accept="image/*" capture="environment" hidden data-add></label>
          <label class="btn">📎 File<input type="file" accept="image/*,application/pdf" multiple hidden data-add></label>
        </div>
        <div class="thumbs" id="thumbs">${receipts.map(thumb).join('')}</div>
        <div class="grid2">
          <label>Amount<input name="amount" inputmode="decimal" required value="${Number.isFinite(e.amount) ? formatAmount(e.amount) : ''}" placeholder="0,00"></label>
          <label>Currency<input name="currency" list="currencies" value="${esc(e.currency)}" maxlength="3" required></label>
        </div>
        <datalist id="currencies">${CURRENCIES.map((c) => `<option value="${c}">`).join('')}</datalist>
        <div class="grid2">
          <label>Date<input name="date" type="date" required value="${esc(e.date)}"></label>
          <label>Category<select name="category" required>${options(CATEGORIES, e.category, { empty: 'Choose…' })}</select></label>
        </div>
        <label>Merchant<input name="merchant" value="${esc(e.merchant || '')}" placeholder="e.g. Scandic, SJ, Taxi Göteborg"></label>
        <label>Description<input name="description" value="${esc(e.description || '')}" placeholder="e.g. Dinner with customer"></label>
        <div class="grid2">
          <label>VAT (optional)<input name="vat" inputmode="decimal" value="${Number.isFinite(e.vat) ? formatAmount(e.vat) : ''}"></label>
          <label>Paid with<select name="payment">${options(['Private card', 'Company card', 'Cash', 'Invoice'], e.payment, { empty: '—' })}</select></label>
        </div>
        <label>Company<select name="companyId">${options(companyList, e.companyId, { value: (c) => c.id, label: (c) => c.name, empty: '—' })}</select></label>
        ${!companyList.length ? '<p class="muted small">Add companies under Settings to get per-company copy templates.</p>' : ''}
        <label>Trip<select name="tripId">${options(tripList.slice(0, 30), e.tripId, { value: (t) => t.id, label: (t) => `${tripStart(t) ? isoDate(tripStart(t)) : ''} ${tripTitle(t)}`, empty: 'No trip' })}</select></label>
        <label>Status<select name="status">${options(STATUSES, e.status, { value: (s) => s.id, label: (s) => s.label })}</select></label>
        <div class="grid2"><a class="btn" href="${existing ? `#/expense/${e.id}` : 'javascript:history.back()'}">Cancel</a><button class="btn primary" type="submit">Save</button></div>
      </form>`,
    bind(root) {
      const form = root.querySelector('#expense-form');
      const thumbs = root.querySelector('#thumbs');
      root.querySelectorAll('[data-add]').forEach((input) => {
        input.onchange = async () => {
          for (const f of input.files) {
            const r = await saveReceipt(f);
            newReceipts.push(r);
            thumbs.insertAdjacentHTML('beforeend', thumb(r));
          }
          input.value = '';
        };
      });
      thumbs.onclick = (ev) => {
        const rid = ev.target.closest('[data-remove]')?.dataset.remove;
        if (!rid) return;
        removed.add(rid);
        thumbs.querySelector(`[data-rid="${rid}"]`).remove();
      };
      form.tripId.onchange = () => {
        const t = trips[form.tripId.value];
        if (t?.companyId && !form.companyId.value) form.companyId.value = t.companyId;
      };
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const fd = Object.fromEntries(new FormData(form));
        const amount = parseAmount(fd.amount);
        if (!Number.isFinite(amount)) return toast('Enter a valid amount');
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
        toast('Saved');
        if (existing) go(`#/expense/${saved.id}`);
        else location.replace(`#/expense/${saved.id}`);
      };
      if (!existing) form.amount.focus();
    },
  };
}

async function expenseView(id) {
  const e = await db.get('expenses', id);
  if (!e) return { title: 'Expense', html: '<p class="empty">Expense not found.</p>' };
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
  const queue = sortExpenses(await db.all('expenses')).filter((x) => x.status === 'todo' && x.companyId === e.companyId && x.id !== e.id);
  return {
    title: e.merchant || e.category || 'Expense',
    html: `
      <section class="card center">
        <div class="hero-amount">${money(e.amount, e.currency)}</div>
        <div class="muted">${esc(e.date)} · ${esc(e.category)}${company ? ` · ${esc(company.name)}` : ''}</div>
        <div class="seg" role="group" aria-label="Status">${STATUSES.map((s) => `<button class="${s.id === e.status ? 'on' : ''}" data-action="status" data-status="${s.id}">${s.label}</button>`).join('')}</div>
      </section>
      <button class="btn primary block" data-action="copyall">⧉ Copy all${company ? ` (${esc(company.name)} format)` : ''}</button>
      <p class="muted small center">Tap a row to copy that field</p>
      <div class="copy-list">
        ${copyRow('Date', v.date)}
        ${copyRow('Amount', v.amount)}
        ${copyRow('Currency', v.currency)}
        ${copyRow(company?.categoryMap?.[e.category] ? `Category (${company.name})` : 'Category', v.category, 'Category')}
        ${copyRow('Merchant', v.merchant)}
        ${copyRow('Description', v.description)}
        ${copyRow('VAT', v.vat)}
        ${copyRow('Paid with', v.payment)}
        ${trip ? copyRow('Trip', v.trip) : ''}
        ${trip ? copyRow('Purpose', v.purpose) : ''}
      </div>
      ${receipts.length ? `<section><div class="row between"><h3>Receipt${receipts.length > 1 ? 's' : ''}</h3><button class="btn small primary" data-action="share">Share ↗</button></div>
        <div class="thumbs large">${receipts.map((r) => r.type.startsWith('image/')
          ? `<a href="${objectUrl(r.blob)}" target="_blank" class="thumb"><img src="${objectUrl(r.blob)}" alt="Receipt"></a>`
          : `<a href="${objectUrl(r.blob)}" target="_blank" class="thumb"><span class="pdf">PDF</span></a>`).join('')}</div>
        <button class="link small" data-action="save">Save receipt to device</button></section>` : '<p class="muted small center">No receipt attached.</p>'}
      ${trip ? `<p class="center"><a class="link" href="#/trip/${trip.id}">Trip: ${esc(tripTitle(trip))} ›</a></p>` : ''}
      <div class="grid2"><a class="btn" href="#/expense/${e.id}/edit">✎ Edit</a><button class="btn danger" data-action="delete">Delete</button></div>
      ${queue.length ? `<a class="btn block" href="#/expense/${queue[0].id}">Next to report (${queue.length} left) ›</a>` : ''}`,
    actions: {
      copy: copyAction,
      copyall: () => copyText(renderTemplate(company?.expenseTemplate || DEFAULT_EXPENSE_TEMPLATE, v), 'Expense copied'),
      status: async (el) => {
        await db.put('expenses', { ...e, status: el.dataset.status, updatedAt: Date.now() });
        render();
      },
      share: async () => {
        try { await shareReceipts(receipts, e.merchant || 'Receipt'); } catch { /* share cancelled */ }
      },
      save: () => receipts.forEach((r) => download(r.blob, `${e.date}_${(e.merchant || e.category || 'receipt').replace(/\W+/g, '_')}.${r.name.split('.').pop()}`)),
      delete: async () => {
        if (!(await confirmSheet('Delete expense', 'Delete this expense and its receipts?', 'Delete', true))) return;
        await db.deleteExpense(e);
        history.back();
      },
    },
  };
}

async function companiesView() {
  const { list } = await companiesById();
  return {
    title: 'Companies',
    html: `
      <p class="muted">Each company you bill can have its own copy format and names for categories.</p>
      ${list.length ? `<div class="list">${list.map((c) => `<a class="list-item" href="#/company/${c.id}"><div class="li-main"><div class="li-title">${esc(c.name)}</div><div class="li-sub">${esc(c.system || '')}</div></div><div class="li-end">›</div></a>`).join('')}</div>` : '<p class="empty">No companies yet.</p>'}
      <a class="btn primary block" href="#/company/new">＋ Add company</a>`,
  };
}

async function companyView(id) {
  const isNew = id === 'new';
  const c = isNew ? { id: uid(), name: '', system: '', expenseTemplate: DEFAULT_EXPENSE_TEMPLATE, tripTemplate: DEFAULT_TRIP_TEMPLATE, decimalSep: ',', csvSep: ';', categoryMap: {} } : await db.get('companies', id);
  if (!c) return { title: 'Company', html: '<p class="empty">Company not found.</p>' };
  const chips = (list, target) => list.map((p) => `<button type="button" class="chip" data-insert="{${p}}" data-target="${target}">{${p}}</button>`).join('');
  return {
    title: isNew ? 'New company' : c.name,
    html: `
      <form id="company-form" class="card">
        <label>Name<input name="name" required value="${esc(c.name)}" placeholder="e.g. Altegra"></label>
        <label>Expense system (note)<input name="system" value="${esc(c.system || '')}" placeholder="e.g. Concur, Visma, Medius"></label>
        <label>Expense copy format<textarea name="expenseTemplate" rows="3" class="mono">${esc(c.expenseTemplate)}</textarea></label>
        <div class="chips small">${chips(EXPENSE_PLACEHOLDERS, 'expenseTemplate')}</div>
        <label>Trip copy format<textarea name="tripTemplate" rows="5" class="mono">${esc(c.tripTemplate)}</textarea></label>
        <div class="chips small">${chips(TRIP_PLACEHOLDERS, 'tripTemplate')}</div>
        <p class="muted small">Write <code>\\t</code> for tab (jumps to the next cell when pasting into a table) and <code>\\n</code> for a new line.</p>
        <div class="grid2">
          <label>Decimal separator<select name="decimalSep">${options([',', '.'], c.decimalSep, { label: (x) => (x === ',' ? 'Comma 12,50' : 'Point 12.50') })}</select></label>
          <label>CSV separator<select name="csvSep">${options([';', ',', '\t'], c.csvSep, { label: (x) => ({ ';': 'Semicolon', ',': 'Comma', '\t': 'Tab' })[x] })}</select></label>
        </div>
        <h3>Category names in this company's system</h3>
        <p class="muted small">Leave empty to use your own name.</p>
        <div class="map-grid">${CATEGORIES.map((cat) => `<span>${esc(cat)}</span><input data-cat="${esc(cat)}" value="${esc(c.categoryMap?.[cat] || '')}" placeholder="${esc(cat)}">`).join('')}</div>
        <button class="btn primary block" type="submit">Save</button>
      </form>
      ${isNew ? '' : '<button class="btn danger block subtle" data-action="delete">Delete company</button>'}`,
    actions: {
      delete: async () => {
        if (!(await confirmSheet('Delete company', `Delete ${c.name}? Expenses keep their data but lose the company link.`, 'Delete', true))) return;
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
        toast('Saved');
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
  return {
    title: 'Settings',
    html: `
      <a class="list-item card" href="#/companies"><div class="li-main"><div class="li-title">🏢 Companies &amp; copy formats</div><div class="li-sub">Templates and category names per company</div></div><div class="li-end">›</div></a>
      <section class="card">
        <label>Mileage rate, own car (SEK per mil = 10 km)<input id="rate" inputmode="decimal" value="${formatAmount(rate)}"></label>
        <p class="muted small">Skatteverket's tax-free rate for own car is 25 SEK/mil. Your employer may pay more.</p>
      </section>
      <section class="card">
        <h3>Backup</h3>
        <p class="muted small">Your data lives only on this phone: ${counts.trips} trips, ${counts.expenses} expenses, ${counts.receipts} receipts${est ? ` (${(est.usage / 1048576).toFixed(1)} MB)` : ''}. ${persisted ? 'Storage is marked persistent.' : 'Install the app to the home screen so Android keeps the data.'}</p>
        <p class="muted small">Last backup: ${lastBackup ? dateTime(lastBackup) : 'never'}</p>
        <div class="grid2">
          <button class="btn primary" data-action="backup">⬇ Export backup</button>
          <label class="btn">⬆ Restore<input type="file" accept="application/json,.json" hidden id="restore"></label>
        </div>
      </section>
      <section class="card">
        <h3>About</h3>
        <p class="muted small">Positions are recorded when you tap start, change transport or end. Addresses come from OpenStreetMap and road distances from OSRM, only when online. Nothing else leaves the phone.</p>
      </section>`,
    actions: {
      backup: async () => {
        download(await db.exportBackup(), `travel-backup-${isoDate(Date.now())}.json`);
        await db.setSetting('lastBackup', Date.now());
        render();
      },
    },
    bind(root) {
      root.querySelector('#rate').onchange = async (ev) => {
        const n = parseAmount(ev.target.value);
        if (Number.isFinite(n)) { await db.setSetting('mileageRate', n); toast('Saved'); }
      };
      root.querySelector('#restore').onchange = async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        if (!(await confirmSheet('Restore backup', 'Items in the backup are merged into your current data. Items with the same id are overwritten.', 'Restore'))) return;
        try {
          const n = await db.importBackup(file);
          toast(`Restored ${n} items`);
          render();
        } catch (err) {
          toast(`Restore failed: ${err.message}`);
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
render();
