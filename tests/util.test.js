import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount, formatAmount, renderTemplate, toCsv, haversineKm, formatDuration,
  tripLegs, ownCarKm, expenseValues, tripValues, expensesCsv, DEFAULT_EXPENSE_TEMPLATE,
} from '../js/util.js';

const t0 = new Date(2026, 8, 21, 7, 5).getTime();
const trip = {
  id: 't1', status: 'done', destination: 'Stockholm', purpose: 'Customer meeting', companyId: 'c1',
  points: [
    { id: 'a', time: t0, transport: 'car', place: 'Home, Göteborg', lat: 57.7, lon: 11.97, distanceKm: 12.4 },
    { id: 'b', time: t0 + 30 * 60000, transport: 'flight', place: 'Landvetter' },
    { id: 'c', time: t0 + 10 * 3600000, transport: 'car', place: 'Landvetter', distanceKm: 12.6 },
    { id: 'd', time: t0 + 10.5 * 3600000, transport: null, place: 'Home, Göteborg' },
  ],
};
const company = { name: 'Altegra', decimalSep: ',', categoryMap: { Taxi: 'Local transport' } };

test('parseAmount handles Swedish formats', () => {
  assert.equal(parseAmount('123,50'), 123.5);
  assert.equal(parseAmount('1 234.5'), 1234.5);
  assert.ok(Number.isNaN(parseAmount('abc')));
});

test('formatAmount uses decimal separator', () => {
  assert.equal(formatAmount(12.5), '12,50');
  assert.equal(formatAmount(12.5, '.'), '12.50');
});

test('renderTemplate replaces keys, keeps unknown and expands escapes', () => {
  assert.equal(renderTemplate('{a}\\t{b}\\n{x}', { a: 1, b: 'two' }), '1\ttwo\n{x}');
});

test('toCsv quotes values containing separators and quotes', () => {
  assert.equal(toCsv([['a;b', 'c"d', 'e']]), '"a;b";"c""d";e');
});

test('haversineKm Göteborg–Stockholm is about 400 km', () => {
  const km = haversineKm({ lat: 57.7089, lon: 11.9746 }, { lat: 59.3293, lon: 18.0686 });
  assert.ok(km > 390 && km < 410, String(km));
});

test('formatDuration', () => {
  assert.equal(formatDuration(5 * 60000), '5m');
  assert.equal(formatDuration(125 * 60000), '2h 5m');
  assert.equal(formatDuration(26 * 3600000), '1d 2h 0m');
});

test('tripLegs and ownCarKm', () => {
  const legs = tripLegs(trip);
  assert.equal(legs.length, 3);
  assert.deepEqual(legs.map((l) => l.transport), ['car', 'flight', 'car']);
  assert.equal(ownCarKm(trip), 25);
  const active = { status: 'active', points: [trip.points[0]] };
  assert.equal(tripLegs(active).length, 1);
  assert.equal(tripLegs(active)[0].to, null);
});

test('tripValues', () => {
  const v = tripValues(trip, company);
  assert.equal(v.start_date, '2026-09-21');
  assert.equal(v.start_time, '07:05');
  assert.equal(v.end_time, '17:35');
  assert.equal(v.transport, 'Own car, Flight');
  assert.equal(v.car_km, '25');
  assert.equal(v.company, 'Altegra');
});

test('expenseValues maps categories per company', () => {
  const e = { date: '2026-09-21', amount: 389, currency: 'SEK', category: 'Taxi', merchant: 'Taxi Sthlm', description: 'Airport', tripId: 't1', status: 'todo' };
  const v = expenseValues(e, { trip, company });
  assert.equal(v.category, 'Local transport');
  assert.equal(v.my_category, 'Taxi');
  assert.equal(renderTemplate(DEFAULT_EXPENSE_TEMPLATE, v), '2026-09-21\t389,00\tSEK\tLocal transport\tTaxi Sthlm\tAirport');
  const csv = expensesCsv([e], { tripsById: { t1: trip }, company });
  assert.match(csv.split('\r\n')[1], /^2026-09-21;389,00;SEK;Local transport;Taxi Sthlm;Airport;;Stockholm;Customer meeting;To report$/);
});
