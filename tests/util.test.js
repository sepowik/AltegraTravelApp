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
  assert.match(csv.split('\r\n')[1], /^2026-09-21;389,00;SEK;Local transport;Taxi Sthlm;Airport;;Stockholm;Customer meeting;To report;389,00;SEK;1$/);
});

test('currency codes and labels', async () => {
  const { isCurrencyCode, currencyLabel, CURRENCIES } = await import('../js/util.js');
  assert.ok(CURRENCIES.includes('SEK') && CURRENCIES[0] === 'SEK');
  assert.equal(isCurrencyCode('JPY'), true);
  assert.equal(isCurrencyCode('jp'), false);
  assert.equal(isCurrencyCode(''), false);
  assert.match(currencyLabel('SEK', 'en'), /^SEK · Swedish krona$/i);
  assert.match(currencyLabel('SEK', 'sv'), /^SEK · svensk krona$/i);
  assert.equal(currencyLabel('XYZ', 'en').startsWith('XYZ'), true);
});

test('report currency conversion values', async () => {
  const { needsConversion, validConversion, convertAmount, formatRate, expenseValues, renderTemplate } = await import('../js/util.js');
  const company = { name: 'Altegra', decimalSep: ',', reportCurrency: 'SEK' };
  const eur = { date: '2026-09-24', amount: 50.5, currency: 'EUR', category: 'Meal', status: 'todo',
    conversion: { from: 'EUR', currency: 'SEK', amount: 581.92, rate: 11.5232, rateDate: '2026-09-24', source: 'ecb' } };
  assert.equal(needsConversion(eur, company), true);
  assert.equal(needsConversion({ ...eur, currency: 'SEK' }, company), false);
  assert.equal(needsConversion(eur, { name: 'Old company' }), false);
  assert.equal(convertAmount(50.5, 11.5232), 581.92);
  assert.equal(formatRate(11.5232), '11,5232');
  assert.equal(formatRate(11.5), '11,5');
  const v = expenseValues(eur, { company });
  assert.equal(v.report_amount, '581,92');
  assert.equal(v.report_currency, 'SEK');
  assert.equal(v.rate, '11,5232');
  assert.equal(renderTemplate('{amount} {currency} = {report_amount} {report_currency}', v), '50,50 EUR = 581,92 SEK');
  // Same currency: report fields mirror the expense.
  const sek = expenseValues({ ...eur, currency: 'SEK', conversion: undefined, amount: 91 }, { company });
  assert.deepEqual([sek.report_amount, sek.report_currency, sek.rate], ['91,00', 'SEK', '1']);
  // A stale conversion (currency changed since) is ignored.
  assert.equal(validConversion({ ...eur, currency: 'USD' }, company), null);
  assert.equal(expenseValues({ ...eur, currency: 'USD' }, { company }).report_amount, '');
  // CSV for all companies uses each row's company.
  const { expensesCsv } = await import('../js/util.js');
  const csv = expensesCsv([{ ...eur, companyId: 'c1' }], { companiesById: { c1: company } });
  assert.match(csv.split('\r\n')[1], /;50,50;EUR;.*;581,92;SEK;11,5232$/);
  // Company that reports in EUR: a SEK expense needs conversion.
  assert.equal(needsConversion({ ...eur, currency: 'SEK' }, { reportCurrency: 'EUR' }), true);
});
