import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChargers, parseFoodPlaces, routeWithKm, sampleRoute, locateOnRoute, planCharging, foodNear,
  chargersQuery, compatible,
} from '../js/charging.js';

// A straight route due north from 57°N: 1° latitude ≈ 111.2 km.
const KM_PER_DEG = 111.195;
const coords = Array.from({ length: 401 }, (_, i) => [12, 57 + i * 0.01]); // ~445 km
const route = routeWithKm(coords);
const at = (km, offKm = 0.3) => ({ lat: 57 + km / KM_PER_DEG, lon: 12 + offKm / 60 });

const charger = (id, km, tags = {}) => ({
  type: 'node', id, ...at(km),
  tags: { amenity: 'charging_station', name: `C${id}`, 'socket:type2_combo': '2', 'socket:type2_combo:output': '150 kW', ...tags },
});
const food = (id, km, name = `R${id}`) => ({ type: 'node', id, ...at(km, 0.5), tags: { amenity: 'restaurant', name, cuisine: 'pizza;italian' } });

const car = { rangeKm: 300, connectors: ['ccs'], minPowerKw: 50, batteryKwh: 75 };

test('parseChargers reads connectors, power and skips private stations', () => {
  const list = parseChargers([
    charger(1, 10),
    charger(2, 20, { 'socket:type2_combo': undefined, 'socket:type2': '4', 'socket:type2:output': '22 kW', 'socket:type2_combo:output': undefined }),
    charger(3, 30, { access: 'private' }),
    { type: 'way', id: 4, center: at(40), tags: { amenity: 'charging_station', operator: 'Ionity', 'socket:type2_combo': '4', 'socket:type2_combo:output': '350000 W' } },
  ]);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0].connectors, ['ccs']);
  assert.equal(list[0].powerKw, 150);
  assert.deepEqual(list[1].connectors, ['type2']);
  assert.equal(list[1].powerKw, 22);
  assert.equal(list[2].id, 'osm:way/4');
  assert.equal(list[2].name, 'Ionity');
  assert.equal(list[2].powerKw, 350);
});

test('parseFoodPlaces keeps named restaurants, cafés and fast food', () => {
  const list = parseFoodPlaces([food(1, 5), { type: 'node', id: 2, ...at(5), tags: { amenity: 'restaurant' } }, { type: 'node', id: 3, ...at(5), tags: { amenity: 'bank', name: 'Bank' } }]);
  assert.deepEqual(list.map((f) => f.name), ['R1']);
  assert.equal(list[0].cuisine, 'pizza, italian');
});

test('route km, sampling and projection', () => {
  assert.ok(Math.abs(route.at(-1).km - 444.8) < 1);
  const s = sampleRoute(route, 2);
  assert.equal(s[0], route[0]);
  assert.equal(s.at(-1), route.at(-1));
  assert.ok(s.length > 150 && s.length <= 252);
  const loc = locateOnRoute(at(100, 1), route);
  assert.ok(Math.abs(loc.alongKm - 100) < 1.2 && Math.abs(loc.offKm - 1) < 0.1);
  assert.match(chargersQuery(s.slice(0, 2)), /^\[out:json\].*charging_station.*around:2000,57\.00000,12\.00000,/);
});

test('compatible checks connectors and minimum power', () => {
  const [ccs, t2] = parseChargers([charger(1, 1), charger(2, 2, { 'socket:type2_combo': undefined, 'socket:type2': '2', 'socket:type2_combo:output': '11 kW' })]);
  assert.equal(compatible(ccs, car), true);
  assert.equal(compatible(t2, car), false);
  assert.equal(compatible(t2, { rangeKm: 300, connectors: ['type2'] }), true);
});

test('no stop when the battery is enough', () => {
  const plan = planCharging(route, parseChargers([charger(1, 200)]), { ...car, rangeKm: 600 }, { startPct: 90 });
  assert.equal(plan.needsCharging, false);
  assert.equal(plan.stops.length, 0);
  assert.equal(plan.arrivalPct, 16);
});

test('one stop, late in the reachable stretch, and enough charge to arrive', () => {
  const chargers = parseChargers([charger(1, 60), charger(2, 150), charger(3, 220), charger(4, 260)]);
  const plan = planCharging(route, chargers, car, { startPct: 90, reservePct: 10, chargeToPct: 90 });
  // 80 % usable of 300 km = 240 km reachable; 260 is out of reach, 220 is the best.
  assert.equal(plan.stops.length, 1);
  assert.equal(plan.stops[0].charger.name, 'C3');
  assert.ok(Math.abs(plan.stops[0].arrivePct - 17) <= 1);
  assert.ok(plan.stops[0].departPct <= 90 && plan.arrivalPct >= 10);
  assert.ok(plan.stops[0].minutes > 0);
});

test('two stops on a low battery', () => {
  const chargers = parseChargers([50, 90, 130, 180, 240, 300, 350].map((km, i) => charger(i + 1, km)));
  const plan = planCharging(route, chargers, car, { startPct: 50, reservePct: 10, chargeToPct: 80 });
  assert.equal(plan.stops.length, 2);
  assert.ok(plan.stops.every((s) => s.arrivePct >= 10));
  assert.ok(plan.arrivalPct >= 10);
});

test('unreachable when no charger is in range', () => {
  const plan = planCharging(route, parseChargers([charger(1, 400)]), car, { startPct: 40 });
  assert.equal(plan.unreachable, true);
});

test('wanting to eat prefers a charger with food, badly rated places are hidden', () => {
  const chargers = parseChargers([charger(1, 200), charger(2, 225)]);
  const foodList = parseFoodPlaces([food(10, 200, 'Good Pizza'), food(11, 225, 'Awful Burger')]);
  const ratings = { 'osm:node/11': { rating: 1 } };
  const withoutEat = planCharging(route, chargers, car, { startPct: 90, food: foodList, ratings });
  assert.equal(withoutEat.stops[0].charger.name, 'C2');
  const withEat = planCharging(route, chargers, car, { startPct: 90, eat: true, food: foodList, ratings });
  assert.equal(withEat.stops[0].charger.name, 'C1');
  assert.deepEqual(withEat.stops[0].charger.food.map((f) => f.name), ['Good Pizza']);
  const c2 = withEat.along.find((c) => c.name === 'C2');
  assert.equal(c2.food.length, 0);
  assert.equal(c2.hiddenFood, 1);
});

test('foodNear lists liked places first', () => {
  const [c] = parseChargers([charger(1, 100)]);
  const f = parseFoodPlaces([food(1, 100, 'Near'), { ...food(2, 100.3, 'Liked') }]);
  const { list } = foodNear(c, f, { 'osm:node/2': { rating: 5 } });
  assert.deepEqual(list.map((x) => x.name), ['Liked', 'Near']);
});
