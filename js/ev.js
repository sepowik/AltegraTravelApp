// Cars, electric charging stops, places to eat while charging, and restaurant ratings.
// Views follow app.js conventions: they return { title, html, actions, bind }.
// `nav` is { go, render } from app.js.
import * as db from './db.js';
import * as geo from './geo.js';
import { esc, options, toast, sheet, confirmSheet } from './ui.js';
import { t } from './i18n.js';
import { uid, parseAmount, tripLegs, formatKm } from './util.js';
import {
  CONNECTORS, BAD_RATING, parseChargers, parseFoodPlaces, routeWithKm, routeBoxes, locateOnRoute,
  compatible, planCharging, chargersQuery, foodQuery, directionsUrl,
} from './charging.js';

export const CAR_TRANSPORTS = ['car', 'company_car'];
export const FUELS = ['petrol', 'diesel', 'electric', 'hybrid'];
const fuelIcon = (f) => (f === 'electric' ? '⚡' : f === 'hybrid' ? '🔌' : '⛽');

export async function carsList() {
  const cars = await db.all('cars');
  return cars.sort((a, b) => a.name.localeCompare(b.name));
}

export const carLabel = (car) => (car ? `${car.name}${car.plate ? ` (${car.plate})` : ''}` : '');

const stars = (n) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '');

// ---------- picking a car when a car leg starts ----------

// Second step of the transport sheet. Resolves {} for non-car transport or when no cars are set up,
// otherwise { carId, chargePct?, eat? }.
export async function pickCar(dlg, transport, goLabel) {
  if (!CAR_TRANSPORTS.includes(transport)) return {};
  const cars = await carsList();
  if (!cars.length) return {};
  if (cars.length === 1 && cars[0].fuel !== 'electric') return { carId: cars[0].id };
  const lastCarId = await db.getSetting('lastCarId', '');
  const lastEat = await db.getSetting('lastEatWhileCharging', false);
  const body = dlg.querySelector('.sheet-body');
  body.innerHTML = `
    <p class="muted">${esc(t('whichCar'))}</p>
    <div class="car-list">${cars.map((c) => `<button type="button" class="car-btn${c.id === lastCarId ? ' last' : ''}" data-car="${c.id}"><span class="t-icon">${fuelIcon(c.fuel)}</span><span><b>${esc(c.name)}</b>${c.plate ? `<br><small>${esc(c.plate)}</small>` : ''}</span></button>`).join('')}</div>
    <div class="ev-extra" hidden>
      <label>${esc(t('chargeNow'))}<input name="chargePct" type="number" inputmode="numeric" min="0" max="100" step="1"></label>
      <label class="check"><input type="checkbox" name="eat"${lastEat ? ' checked' : ''}><span>${esc(t('eatWhileCharging'))}</span></label>
      <button type="button" class="btn primary block" data-go>${esc(goLabel)}</button>
    </div>`;
  return new Promise((resolve) => {
    let chosen = null;
    const extra = body.querySelector('.ev-extra');
    body.querySelectorAll('[data-car]').forEach((btn) => {
      btn.onclick = async () => {
        chosen = cars.find((c) => c.id === btn.dataset.car);
        body.querySelectorAll('[data-car]').forEach((b) => b.classList.toggle('on', b === btn));
        if (chosen.fuel !== 'electric') return resolve({ carId: chosen.id });
        extra.hidden = false;
        const pct = body.querySelector('[name=chargePct]');
        pct.value = chosen.lastChargePct ?? '';
        pct.focus();
      };
    });
    body.querySelector('[data-go]').onclick = async () => {
      const n = Math.round(parseAmount(body.querySelector('[name=chargePct]').value));
      if (!(n >= 0 && n <= 100)) return toast(t('invalidPct'));
      const eat = body.querySelector('[name=eat]').checked;
      await db.setSetting('lastEatWhileCharging', eat);
      await db.put('cars', { ...chosen, lastChargePct: n });
      resolve({ carId: chosen.id, chargePct: n, eat });
    };
  });
}

// Applies a pickCar result to a new trip point (and the trip, for the eat preference).
export async function applyCarChoice(trip, point, choice) {
  if (!choice.carId) return;
  point.carId = choice.carId;
  await db.setSetting('lastCarId', choice.carId);
  if (Number.isFinite(choice.chargePct)) {
    point.chargePct = choice.chargePct;
    trip.battery = { pct: choice.chargePct, time: point.time };
    trip.eatWhileCharging = !!choice.eat;
  }
}

// The car of the trip's current (last) leg.
export async function currentCar(trip) {
  const legs = tripLegs(trip);
  const leg = legs[legs.length - 1];
  return leg?.from.carId ? db.get('cars', leg.from.carId) : null;
}

// ---------- rating ----------

export function rateSheet(place) {
  return new Promise((resolve) => {
    let done = false;
    db.get('places', place.id).then((saved) => {
      let rating = saved?.rating || 0;
      sheet(t('rateTitle', { name: place.name }), `
        <div class="stars-input" role="radiogroup">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-label="${n}">${n <= rating ? '★' : '☆'}</button>`).join('')}</div>
        <label>${esc(t('notes'))}<input name="note" value="${esc(saved?.note || '')}"></label>
        <p class="muted small">${esc(t('rateHint'))}</p>
        <button type="button" class="btn primary block" data-save>${esc(t('save'))}</button>`, (dlg, close) => {
        const paint = () => dlg.querySelectorAll('[data-star]').forEach((b) => { b.textContent = Number(b.dataset.star) <= rating ? '★' : '☆'; });
        dlg.querySelectorAll('[data-star]').forEach((b) => { b.onclick = () => { rating = Number(b.dataset.star); paint(); }; });
        dlg.querySelector('[data-save]').onclick = async () => {
          if (!rating) return;
          const row = { ...saved, ...place, rating, note: dlg.querySelector('[name=note]').value.trim(), ratedAt: Date.now() };
          delete row.distM;
          await db.put('places', row);
          toast(t('ratingSaved'));
          done = true;
          close();
          resolve(row);
        };
        dlg.addEventListener('close', () => { if (!done) resolve(null); });
      });
    });
  });
}

// ---------- cars ----------

export async function carsView() {
  const cars = await carsList();
  return {
    title: t('myCars'),
    html: `
      <p class="muted">${esc(t('carsIntro'))}</p>
      ${cars.length ? `<div class="list">${cars.map((c) => `<a class="list-item" href="#/car/${c.id}"><span class="t-icon">${fuelIcon(c.fuel)}</span><div class="li-main"><div class="li-title">${esc(c.name)}</div><div class="li-sub">${esc([c.plate, t(`fuel.${c.fuel}`), c.fuel === 'electric' && c.rangeKm ? `${c.rangeKm} km` : ''].filter(Boolean).join(' · '))}</div></div><div class="li-end">›</div></a>`).join('')}</div>` : `<p class="empty">${esc(t('noCars'))}</p>`}
      <a class="btn primary block" href="#/car/new">${esc(t('addCar'))}</a>`,
  };
}

export async function carView(id, nav) {
  const isNew = id === 'new';
  const c = isNew ? { id: uid(), name: '', plate: '', fuel: 'electric', rangeKm: '', batteryKwh: '', connectors: ['ccs', 'type2'], minPowerKw: 50 } : await db.get('cars', id);
  if (!c) return { title: t('myCars'), html: `<p class="empty">${esc(t('carNotFound'))}</p>` };
  return {
    title: isNew ? t('newCar') : c.name,
    html: `
      <form id="car-form" class="card">
        <label>${esc(t('carName'))}<input name="name" required value="${esc(c.name)}" placeholder="${esc(t('carNamePh'))}"></label>
        <label>${esc(t('plate'))}<input name="plate" value="${esc(c.plate || '')}" autocapitalize="characters"></label>
        <label>${esc(t('fuel'))}<select name="fuel">${options(FUELS, c.fuel, { label: (f) => t(`fuel.${f}`) })}</select></label>
        <div class="ev-fields"${c.fuel === 'electric' ? '' : ' hidden'}>
          <label>${esc(t('rangeKm'))}<input name="rangeKm" type="number" inputmode="numeric" min="50" max="1500" value="${esc(c.rangeKm ?? '')}"></label>
          <p class="muted small">${esc(t('rangeHint'))}</p>
          <label>${esc(t('batteryKwh'))}<input name="batteryKwh" type="number" inputmode="decimal" min="5" max="250" step="0.1" value="${esc(c.batteryKwh ?? '')}"></label>
          <label>${esc(t('connectors'))}</label>
          <div class="chips">${CONNECTORS.map((k) => `<label class="chip check-chip"><input type="checkbox" name="connectors" value="${k}"${c.connectors?.includes(k) ? ' checked' : ''}>${esc(t(`conn.${k}`))}</label>`).join('')}</div>
          <label>${esc(t('minPowerKw'))}<input name="minPowerKw" type="number" inputmode="numeric" min="0" max="400" value="${esc(c.minPowerKw ?? '')}"></label>
        </div>
        <button class="btn primary block" type="submit">${esc(t('save'))}</button>
      </form>
      ${isNew ? '' : `<button class="btn danger block subtle" data-action="delete">${esc(t('deleteCar'))}</button>`}`,
    actions: {
      delete: async () => {
        if (!(await confirmSheet(t('deleteCar'), t('deleteCarText', { name: c.name }), t('delete'), true))) return;
        await db.remove('cars', c.id);
        nav.go('#/cars');
      },
    },
    bind(root) {
      const form = root.querySelector('#car-form');
      form.fuel.onchange = () => { root.querySelector('.ev-fields').hidden = form.fuel.value !== 'electric'; };
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const num = (n) => { const v = parseAmount(form[n].value); return Number.isFinite(v) ? v : null; };
        const car = {
          ...c,
          name: form.name.value.trim(),
          plate: form.plate.value.trim().toUpperCase(),
          fuel: form.fuel.value,
          rangeKm: num('rangeKm'),
          batteryKwh: num('batteryKwh'),
          minPowerKw: num('minPowerKw'),
          connectors: [...form.querySelectorAll('[name=connectors]:checked')].map((i) => i.value),
        };
        if (car.fuel === 'electric' && !car.rangeKm) return toast(t('rangeRequired'));
        await db.put('cars', car);
        toast(t('saved'));
        nav.go('#/cars');
      };
    },
  };
}

// ---------- rated places ----------

export async function placesView(nav) {
  const places = (await db.all('places')).filter((p) => p.rating).sort((a, b) => b.ratedAt - a.ratedAt);
  return {
    title: t('ratedPlaces'),
    html: `
      <p class="muted">${esc(t('rateHint'))}</p>
      ${places.length ? `<div class="list">${places.map((p) => `<div class="list-item">
        <div class="li-main"><div class="li-title">${esc(p.name)}</div><div class="li-sub"><span class="stars">${stars(p.rating)}</span>${p.rating <= BAD_RATING ? ` · ${esc(t('hiddenFromSuggestions'))}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</div></div>
        <div class="li-end"><button class="link small" data-action="rate" data-id="${esc(p.id)}">${esc(t('rate'))}</button><button class="link small" data-action="unrate" data-id="${esc(p.id)}">${esc(t('removeRating'))}</button></div>
      </div>`).join('')}</div>` : `<p class="empty">${esc(t('noRatedPlaces'))}</p>`}`,
    actions: {
      rate: async (el) => {
        const p = places.find((x) => x.id === el.dataset.id);
        if (await rateSheet(p)) nav.render();
      },
      unrate: async (el) => {
        await db.remove('places', el.dataset.id);
        nav.render();
      },
    },
  };
}

// ---------- charging stops ----------

export async function chargeView(tripId, nav) {
  const trip = await db.get('trips', tripId);
  if (!trip) return { title: t('chargePlanner'), html: `<p class="empty">${esc(t('tripNotFound'))}</p>` };
  const cars = await carsList();
  const legCar = await currentCar(trip);
  const car = legCar?.fuel === 'electric' ? legCar : cars.find((c) => c.fuel === 'electric');
  if (!car) {
    return {
      title: t('chargePlanner'),
      html: `<p class="empty">${esc(t('noElectricCar'))}</p><a class="btn primary block" href="#/car/new">${esc(t('addCar'))}</a>`,
    };
  }
  const pct = trip.battery?.pct ?? car.lastChargePct ?? '';
  const reserve = await db.getSetting('evReservePct', 10);
  const chargeTo = await db.getSetting('evChargeToPct', 80);
  const evCars = cars.filter((c) => c.fuel === 'electric');
  let cache = null; // route, chargers and food from the last search, for re-planning after a rating
  let renderPlan = () => {};

  return {
    title: t('chargePlanner'),
    html: `
      <form id="plan-form" class="card">
        ${evCars.length > 1 ? `<label>${esc(t('car'))}<select name="carId">${options(evCars, car.id, { value: (c) => c.id, label: carLabel })}</select></label>` : `<p class="muted">⚡ ${esc(carLabel(car))} · ${esc(t('rangeShort', { km: car.rangeKm }))}</p>`}
        <div class="grid2">
          <label>${esc(t('chargeNow'))}<input name="pct" type="number" inputmode="numeric" min="0" max="100" required value="${esc(pct)}"></label>
          <label>${esc(t('destination'))}<input name="destination" required value="${esc(trip.destination || '')}" placeholder="${esc(t('destinationPh'))}"></label>
        </div>
        <label class="check"><input type="checkbox" name="eat"${trip.eatWhileCharging ? ' checked' : ''}><span>${esc(t('eatWhileCharging'))}</span></label>
        <details class="more"><summary>${esc(t('chargeSettings'))}</summary>
          <div class="grid2">
            <label>${esc(t('reservePct'))}<input name="reserve" type="number" inputmode="numeric" min="0" max="50" value="${reserve}"></label>
            <label>${esc(t('chargeToPct'))}<input name="chargeTo" type="number" inputmode="numeric" min="30" max="100" value="${chargeTo}"></label>
          </div>
        </details>
        <button class="btn primary block" type="submit">${esc(t('planRoute'))}</button>
      </form>
      <div id="plan-result"></div>`,
    actions: {
      rate: async (el) => {
        const place = cache?.foodById[el.dataset.id];
        if (!place || !(await rateSheet(place))) return;
        cache.ratings = await ratingsMap();
        renderPlan();
      },
    },
    bind(root) {
      const form = root.querySelector('#plan-form');
      const out = root.querySelector('#plan-result');
      const status = (msg, cls = 'muted') => { out.innerHTML = `<p class="${cls} center">${esc(msg)}</p>`; };
      const settings = () => ({
        car: evCars.find((c) => c.id === form.carId?.value) || car,
        pct: Math.round(parseAmount(form.pct.value)),
        dest: form.destination.value.trim(),
        eat: form.eat.checked,
        reserve: Math.round(parseAmount(form.reserve.value)) || 0,
        chargeTo: Math.round(parseAmount(form.chargeTo.value)) || 80,
      });

      renderPlan = () => {
        const s = settings();
        const plan = planCharging(cache.route, cache.chargers, s.car, {
          startPct: s.pct, reservePct: s.reserve, chargeToPct: s.chargeTo, eat: s.eat, food: cache.food, ratings: cache.ratings,
        });
        out.innerHTML = planHtml(plan, s, trip, cache.destName);
      };

      const search = async () => {
        const s = settings();
        if (!(s.pct >= 0 && s.pct <= 100)) return toast(t('invalidPct'));
        if (!s.dest) return status(t('destinationNeeded'));
        const fresh = await db.get('trips', trip.id);
        Object.assign(fresh, { destination: s.dest, eatWhileCharging: s.eat, battery: { pct: s.pct, time: Date.now() } });
        await db.put('trips', fresh);
        await db.put('cars', { ...s.car, lastChargePct: s.pct });
        await db.setSetting('evReservePct', s.reserve);
        await db.setSetting('evChargeToPct', s.chargeTo);
        if (!navigator.onLine) return status(t('offlinePlanner'), 'warn');
        try {
          status(t('planning'));
          const from = await startPosition(fresh);
          if (!from) return status(t('noStartPosition'), 'warn');
          let to = fresh.destinationGeo?.query === s.dest ? fresh.destinationGeo : null;
          if (!to) {
            const found = await geo.geocode(s.dest);
            if (!found) return status(t('destinationNotFound', { dest: s.dest }), 'warn');
            to = { ...found, query: s.dest };
            await db.put('trips', { ...(await db.get('trips', trip.id)), destinationGeo: to });
          }
          const { coords } = await geo.drivingRoute(from, to);
          const route = routeWithKm(coords);
          status(t('findingChargers'));
          const chargers = parseChargers(await geo.overpass(chargersQuery(routeBoxes(route))));
          let food = [];
          if (s.eat && chargers.length) {
            status(t('findingFood'));
            // Look for food only around the chargers worth stopping at, to keep the query small.
            const near = chargers
              .map((c) => ({ ...c, ...locateOnRoute(c, route) }))
              .filter((c) => c.offKm <= 3 && compatible(c, s.car))
              .sort((a, b) => (b.powerKw || 0) - (a.powerKw || 0))
              .slice(0, 40);
            if (near.length) food = parseFoodPlaces(await geo.overpass(foodQuery(near)));
          }
          cache = { route, chargers, food, foodById: Object.fromEntries(food.map((f) => [f.id, f])), ratings: await ratingsMap(), destName: to.name || s.dest };
          renderPlan();
        } catch (err) {
          console.error(err);
          const msg = err?.busy ? t('mapServiceBusy') : t('routeFailed', { msg: err?.message || String(err) });
          out.innerHTML = `<p class="warn center">${esc(msg)}</p><button type="button" class="btn block" data-retry>${esc(t('tryAgain'))}</button>`;
          out.querySelector('[data-retry]').onclick = () => search();
        }
      };

      form.onsubmit = (ev) => { ev.preventDefault(); search(); };
      // Changing only the eat/reserve/charge-to options re-plans without a new search.
      ['eat', 'reserve', 'chargeTo'].forEach((n) => form[n].addEventListener('change', () => { if (cache) renderPlan(); }));
      if (form.destination.value && form.pct.value !== '') search();
    },
  };
}

async function ratingsMap() {
  return Object.fromEntries((await db.all('places')).map((p) => [p.id, p]));
}

async function startPosition(trip) {
  const pos = await geo.getPosition({ timeout: 10000 });
  if (!pos.error) return pos;
  const known = [...trip.points].reverse().find((p) => Number.isFinite(p.lat));
  return known ? { lat: known.lat, lon: known.lon } : null;
}

function planHtml(plan, s, trip, destName) {
  const summary = [`<strong>${esc(t('routeSummary', { km: formatKm(plan.totalKm), dest: destName }))}</strong>`];
  if (!plan.needsCharging) summary.push(`<p>${esc(t('noChargeNeeded', { pct: plan.arrivalPct }))}</p>`);
  else {
    summary.push(`<p>${esc(t('stopsNeeded', { n: plan.stops.length }))} ${esc(t('arriveWith', { pct: plan.arrivalPct }))}</p>`);
    if (plan.unreachable) summary.push(`<p class="warn">${esc(plan.along.length ? t('noChargersInRange') : t('noChargersFound'))}</p>`);
  }
  const stopsHtml = plan.stops.map((st, i) => stopCard(st, i + 1, s, trip)).join('');
  const all = plan.along.map((c) => `<div class="list-item">
      <div class="li-main"><div class="li-title">${esc(c.name || t('charger'))}</div><div class="li-sub">${esc(chargerFacts(c))}</div></div>
      <div class="li-end"><div class="small">${formatKm(c.alongKm)} km</div><a class="link small" href="${directionsUrl(c)}" target="_blank" rel="noopener">${esc(t('navigate'))}</a></div>
    </div>`).join('');
  return `
    <section class="card">${summary.join('')}</section>
    ${stopsHtml}
    ${plan.along.length ? `<details class="more"><summary>${esc(t('allChargers', { n: plan.along.length }))}</summary><div class="list">${all}</div></details>` : ''}
    <p class="muted small center">${esc(t('osmCredit'))}</p>`;
}

function chargerFacts(c) {
  return [
    c.operator && c.operator !== c.name ? c.operator : '',
    c.powerKw ? t('power', { kw: Math.round(c.powerKw) }) : t('unknownPower'),
    c.connectors.map((k) => t(`conn.${k}`)).join('/'),
    c.offKm > 0.3 ? t('detour', { km: formatKm(c.offKm) }) : '',
  ].filter(Boolean).join(' · ');
}

function stopCard(st, n, s, trip) {
  const c = st.charger;
  const foodHtml = s.eat ? `
    <h4>${esc(t('food'))}</h4>
    ${c.food.length ? `<div class="list">${c.food.slice(0, 6).map((f) => `<div class="list-item food">
      <div class="li-main"><div class="li-title">${esc(f.name)} ${f.rating ? `<span class="stars">${stars(f.rating)}</span>` : ''}</div>
        <div class="li-sub">${esc([f.cuisine, t('meters', { m: f.distM }), f.openingHours].filter(Boolean).join(' · '))}</div></div>
      <div class="li-end">
        <button class="link small" data-action="rate" data-id="${esc(f.id)}">${esc(f.rating ? t('rated') : t('rate'))}</button>
        <a class="link small" href="#/expense/new?trip=${trip.id}&category=Meal&merchant=${encodeURIComponent(f.name)}&place=${encodeURIComponent(f.id)}">${esc(t('addMealExpense'))}</a>
      </div></div>`).join('')}</div>` : `<p class="muted small">${esc(t('noFood'))}</p>`}
    ${c.hiddenFood ? `<p class="muted small">${esc(t('hiddenBad', { n: c.hiddenFood }))}</p>` : ''}` : '';
  return `<section class="card stop">
    <div class="row between"><h3>⚡ ${n}. ${esc(c.name || t('charger'))}</h3><a class="btn small primary" href="${directionsUrl(c)}" target="_blank" rel="noopener">${esc(t('navigate'))}</a></div>
    <p class="muted small">${esc(chargerFacts(c))}</p>
    <p>${esc(t('stopLine', { km: formatKm(c.alongKm), arrive: st.arrivePct, depart: st.departPct }))}${st.minutes ? ` ${esc(t('chargeTime', { min: st.minutes }))}` : ''}</p>
    ${foodHtml}
  </section>`;
}
