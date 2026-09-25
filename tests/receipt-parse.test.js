import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiptText, amountsIn, findDate } from '../js/receipt-parse.js';

const now = new Date(2026, 8, 25, 12).getTime();

test('amountsIn reads common formats and skips percentages', () => {
  assert.deepEqual(amountsIn('Totalt 1 234,56'), [1234.56]);
  assert.deepEqual(amountsIn('Summe 1.234,56 EUR'), [1234.56]);
  assert.deepEqual(amountsIn('Total $1,234.56'), [1234.56]);
  assert.deepEqual(amountsIn('Att betala 245:-'), [245]);
  assert.deepEqual(amountsIn('Moms 25% 49,10'), [49.1]);
  assert.deepEqual(amountsIn('Org.nr 556677-8899'), []);
});

test('Swedish restaurant receipt', () => {
  const text = `ESPRESSO HOUSE
Drottninggatan 12
111 51 Stockholm
Org.nr 556677-8899
Kvitto 1234   2026-09-24 14:32
Caffe Latte          52,00
Kanelbulle           39,00
Totalt SEK           91,00
Moms 12%    9,75   81,25   91,00
Kortbetalning        91,00
Tack för besöket!`;
  assert.deepEqual(parseReceiptText(text, { now }), {
    amount: 91, vat: 9.75, date: '2026-09-24', currency: 'SEK', merchant: 'Espresso House', category: 'Meal',
  });
});

test('German hotel receipt with dotted date and total on next line', () => {
  const text = `Hotel Adlon Kempinski
Unter den Linden 77, 10117 Berlin
Rechnung Nr. 4711
Datum: 23.09.2026
1 Übernachtung      189,00
Frühstück            32,00
Gesamtbetrag
221,00 EUR
MwSt. 7%  12,36
MwSt. 19%  5,11`;
  const r = parseReceiptText(text, { now });
  assert.equal(r.amount, 221);
  assert.equal(r.currency, 'EUR');
  assert.equal(r.date, '2026-09-23');
  assert.equal(r.merchant, 'Hotel Adlon Kempinski');
  assert.equal(r.category, 'Hotel');
  assert.equal(r.vat, 12.36);
});

test('English taxi receipt with month name', () => {
  const text = `Taxi Stockholm
Receipt
Sep 22, 2026 08:14
From: Arlanda Terminal 5
Fare            SEK 612.00
Tip             SEK 20.00
Total paid      SEK 632.00
VAT 6%          SEK 35.77`;
  const r = parseReceiptText(text, { now });
  assert.equal(r.amount, 632);
  assert.equal(r.date, '2026-09-22');
  assert.equal(r.category, 'Taxi');
  assert.equal(r.vat, 35.77);
  assert.equal(r.merchant, 'Taxi Stockholm');
});

test('fuel receipt: change and subtotal are not the total', () => {
  const text = `CIRCLE K ANGERED
Diesel 42,10 liter
Delsumma          800,00
Att betala        842,50
Kontant          1000,00
Växel             157,50
Varav moms        168,50
25.09.26`;
  const r = parseReceiptText(text, { now });
  assert.equal(r.amount, 842.5);
  assert.equal(r.vat, 168.5);
  assert.equal(r.category, 'Fuel');
  assert.equal(r.date, '2026-09-25');
  assert.equal(r.merchant, 'Circle K Angered');
});

test('OCR slips inside numbers are corrected', () => {
  assert.equal(parseReceiptText('Totalt 1O5,5O', { now }).amount, 105.5);
});

test('dates too old or in the future are ignored', () => {
  assert.equal(findDate('2019-01-01', now), null);
  assert.equal(findDate('2027-01-01', now), null);
  assert.equal(findDate('Datum 2026-09-01', now), '2026-09-01');
});

test('Spanish restaurant receipt', () => {
  const text = `RESTAURANTE CASA LUCIO
C/ Cava Baja 35, 28005 Madrid
CIF B12345678
Fecha: 21 de septiembre de 2026 21:40
2 Huevos estrellados      32,00
1 Vino tinto              18,50
Base imponible            45,91
IVA 10%                    4,59
TOTAL A PAGAR          50,50 €
Tarjeta                   50,50`;
  const r = parseReceiptText(text, { now });
  assert.equal(r.amount, 50.5);
  assert.equal(r.vat, 4.59);
  assert.equal(r.date, '2026-09-21');
  assert.equal(r.currency, 'EUR');
  assert.equal(r.merchant, 'Restaurante Casa Lucio');
  assert.equal(r.category, 'Meal');
});

test('Indian taxi receipt with GST in rupees', () => {
  const text = `Ola
Trip invoice
20 Sep 2026
Ride fare          Rs. 420.00
CGST 2.5%          Rs. 10.50
SGST 2.5%          Rs. 10.50
Total Amount       ₹ 441.00
Paid by UPI`;
  const r = parseReceiptText(text, { now });
  assert.equal(r.amount, 441);
  assert.equal(r.currency, 'INR');
  assert.equal(r.date, '2026-09-20');
  assert.equal(r.category, 'Taxi');
  assert.equal(r.vat, 21);
});

test('garbage gives an empty result', () => {
  assert.deepEqual(parseReceiptText('~~ ## ..', { now }), {});
  assert.deepEqual(parseReceiptText('', { now }), {});
});
