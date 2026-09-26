// Charging stop planning for electric cars. Pure functions (unit tested); the network
// calls that feed them live in geo.js.

import { haversineKm } from './util.js';

export const CONNECTORS = ['ccs', 'type2', 'chademo', 'tesla'];

// OSM socket tags per connector (https://wiki.openstreetmap.org/wiki/Key:socket).
const SOCKET_TAGS = {
  ccs: ['socket:type2_combo', 'socket:ccs', 'socket:tesla_supercharger_ccs'],
  type2: ['socket:type2', 'socket:type2_cable'],
  chademo: ['socket:chademo'],
  tesla: ['socket:tesla_supercharger', 'socket:tesla_destination'],
};

export const BAD_RATING = 2; // 1–2 stars: never suggest again

const kw = (v) => {
  const m = String(v || '').match(/(\d+(?:[.,]\d+)?)\s*(kw|w)?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return m[2]?.toLowerCase() === 'w' ? n / 1000 : n;
};

const position = (el) => (Number.isFinite(el.lat) ? { lat: el.lat, lon: el.lon } : el.center ? { lat: el.center.lat, lon: el.center.lon } : null);

export const placeId = (el) => `osm:${el.type}/${el.id}`;

// Overpass elements → chargers with connectors and best known power.
export function parseChargers(elements = []) {
  const out = [];
  for (const el of elements) {
    const pos = position(el);
    const tags = el.tags || {};
    if (!pos || tags.amenity !== 'charging_station') continue;
    if (tags.access && /^(private|no|customers)$/.test(tags.access)) continue;
    const connectors = CONNECTORS.filter((c) => SOCKET_TAGS[c].some((k) => tags[k] && tags[k] !== 'no' && tags[k] !== '0'));
    const powers = Object.entries(tags)
      .filter(([k]) => /^socket:.+:output$|^charging_station:output$|^maxpower$/.test(k))
      .map(([, v]) => kw(v))
      .filter((n) => n && n < 1000);
    out.push({
      id: placeId(el),
      ...pos,
      name: tags.name || tags.brand || tags.operator || '',
      operator: tags.operator || tags.brand || tags.network || '',
      connectors,
      powerKw: powers.length ? Math.max(...powers) : null,
      fee: tags.fee || '',
      openingHours: tags.opening_hours || '',
    });
  }
  return out;
}

export function parseFoodPlaces(elements = []) {
  const out = [];
  for (const el of elements) {
    const pos = position(el);
    const tags = el.tags || {};
    if (!pos || !['restaurant', 'fast_food', 'cafe'].includes(tags.amenity) || !tags.name) continue;
    out.push({
      id: placeId(el),
      ...pos,
      name: tags.name,
      kind: tags.amenity,
      cuisine: (tags.cuisine || '').replace(/_/g, ' ').replace(/;/g, ', '),
      openingHours: tags.opening_hours || '',
    });
  }
  return out;
}

// Route points (OSRM GeoJSON [lon, lat]) with cumulative km.
export function routeWithKm(coords) {
  const pts = [];
  let km = 0;
  coords.forEach(([lon, lat], i) => {
    if (i) km += haversineKm(pts[i - 1], { lat, lon });
    pts.push({ lat, lon, km });
  });
  return pts;
}

// Evenly spaced points (every stepKm) for querying along the route; always includes both ends.
export function sampleRoute(pts, stepKm = 2, max = 250) {
  if (!pts.length) return [];
  const total = pts[pts.length - 1].km;
  const step = Math.max(stepKm, total / max);
  const out = [pts[0]];
  let next = step;
  for (const p of pts) {
    if (p.km >= next) {
      out.push(p);
      next = p.km + step;
    }
  }
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

// Where along the route a place lies (km from start) and how far off the route it is.
export function locateOnRoute(place, pts) {
  let best = null;
  for (const p of pts) {
    const d = haversineKm(p, place);
    if (!best || d < best.offKm) best = { alongKm: p.km, offKm: d };
  }
  return best;
}

export function compatible(charger, car) {
  const wanted = car.connectors?.length ? car.connectors : null;
  if (wanted && charger.connectors.length && !charger.connectors.some((c) => wanted.includes(c))) return false;
  if (car.minPowerKw && charger.powerKw != null && charger.powerKw < car.minPowerKw) return false;
  return true;
}

// Food places near each charger, without the ones the user rated badly.
export function foodNear(charger, food, ratings = {}, radiusKm = 0.6) {
  let hidden = 0;
  const list = [];
  for (const f of food) {
    const distKm = haversineKm(charger, f);
    if (distKm > radiusKm) continue;
    const rating = ratings[f.id]?.rating;
    if (rating != null && rating <= BAD_RATING) {
      hidden++;
      continue;
    }
    list.push({ ...f, distM: Math.round(distKm * 1000), rating });
  }
  // Places the user liked first, then the closest.
  list.sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.distM - b.distM);
  return { list, hidden };
}

const pctToKm = (pct, car) => (pct / 100) * car.rangeKm;
const kmToPct = (km, car) => (km / car.rangeKm) * 100;

/*
 * Plans charging stops.
 *  route:    [{lat, lon, km}] from routeWithKm
 *  chargers: parsed chargers (already filtered to the route corridor)
 *  car:      { rangeKm, connectors, minPowerKw, batteryKwh, maxChargeKw }
 *  opts:     { startPct, reservePct (arrive at chargers with at least), destReservePct,
 *              chargeToPct, eat, food, ratings }
 */
export function planCharging(route, chargers, car, opts) {
  const {
    startPct, reservePct = 10, destReservePct = reservePct, chargeToPct = 80,
    eat = false, food = [], ratings = {},
  } = opts;
  const totalKm = route.length ? route[route.length - 1].km : 0;

  const along = chargers
    .map((c) => ({ ...c, ...locateOnRoute(c, route) }))
    .filter((c) => c.offKm <= 3 && compatible(c, car))
    .map((c) => {
      const f = foodNear(c, food, ratings);
      return { ...c, food: f.list, hiddenFood: f.hidden };
    })
    .sort((a, b) => a.alongKm - b.alongKm);

  const arrivalWithout = startPct - kmToPct(totalKm, car);
  const result = { totalKm, along, stops: [], arrivalPct: Math.round(arrivalWithout), needsCharging: arrivalWithout < destReservePct, unreachable: false };
  if (!result.needsCharging) return result;

  let pos = 0;
  let pct = startPct;
  for (let guard = 0; guard < 12; guard++) {
    if (pct - kmToPct(totalKm - pos, car) >= destReservePct) break;
    const reachKm = pos + pctToKm(pct - reservePct, car);
    const candidates = along.filter((c) => c.alongKm > pos + 1 && c.alongKm <= reachKm);
    if (!candidates.length) {
      result.unreachable = true;
      break;
    }
    // Prefer stops late in the reachable stretch (fewer stops), fast chargers, and food if wanted.
    const windowStart = pos + (reachKm - pos) * 0.5;
    const score = (c) => {
      let s = (c.alongKm - pos) / Math.max(1, reachKm - pos); // 0..1
      if (c.alongKm < windowStart) s -= 0.5;
      s += Math.min(c.powerKw || 22, 150) / 300; // up to +0.5
      if (eat) s += c.food.length ? 0.6 + Math.min(c.food.filter((f) => f.rating >= 4).length, 2) * 0.2 : -0.4;
      s -= c.offKm * 0.1;
      return s;
    };
    const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
    const arrivePct = pct - kmToPct(best.alongKm - pos, car);
    const neededPct = kmToPct(totalKm - best.alongKm, car) + destReservePct;
    const departPct = Math.min(chargeToPct, Math.max(arrivePct, neededPct));
    const departFinal = Math.max(departPct, Math.min(chargeToPct, arrivePct + 20));
    const effKw = Math.min(best.powerKw || 50, car.maxChargeKw || 150) * 0.8;
    const minutes = car.batteryKwh ? Math.round((((departFinal - arrivePct) / 100) * car.batteryKwh / effKw) * 60) : null;
    result.stops.push({ charger: best, arrivePct: Math.round(arrivePct), departPct: Math.round(departFinal), minutes });
    pos = best.alongKm;
    pct = departFinal;
  }
  result.arrivalPct = Math.round(pct - kmToPct(totalKm - pos, car));
  return result;
}

// Bounding boxes that cover the route in segments of about segmentKm, padded by padKm.
// Box queries use Overpass's spatial index and are far cheaper than "around" a long
// polyline, which the public servers often time out on (HTTP 504). Chargers are then
// matched to the route precisely with locateOnRoute.
export function routeBoxes(pts, segmentKm = 40, padKm = 3) {
  const boxes = [];
  let seg = [];
  let segStart = 0;
  const flush = () => {
    if (!seg.length) return;
    const lat = seg.map((p) => p.lat);
    const lon = seg.map((p) => p.lon);
    const s = Math.min(...lat); const n = Math.max(...lat);
    const dLat = padKm / 111.2;
    const dLon = padKm / (111.2 * Math.cos(((s + n) / 2) * Math.PI / 180));
    boxes.push({ s: s - dLat, w: Math.min(...lon) - dLon, n: n + dLat, e: Math.max(...lon) + dLon });
  };
  for (const p of pts) {
    seg.push(p);
    if (p.km - segStart >= segmentKm) {
      flush();
      seg = [p];
      segStart = p.km;
    }
  }
  if (seg.length > 1 || !boxes.length) flush();
  return boxes;
}

const bbox = (b) => `${b.s.toFixed(4)},${b.w.toFixed(4)},${b.n.toFixed(4)},${b.e.toFixed(4)}`;

export function chargersQuery(boxes) {
  const parts = boxes.map((b) => `nwr["amenity"="charging_station"](${bbox(b)});`);
  return `[out:json][timeout:25];(${parts.join('')});out center tags;`;
}

// Small boxes (±radius) around each point, e.g. the chargers worth stopping at.
export function foodQuery(points, radiusM = 600) {
  const parts = points.map((p) => {
    const dLat = radiusM / 111200;
    const dLon = radiusM / (111200 * Math.cos(p.lat * Math.PI / 180));
    return `nwr["amenity"~"^(restaurant|fast_food|cafe)$"]["name"](${bbox({ s: p.lat - dLat, w: p.lon - dLon, n: p.lat + dLat, e: p.lon + dLon })});`;
  });
  return `[out:json][timeout:25];(${parts.join('')});out center tags;`;
}

export function directionsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
}
