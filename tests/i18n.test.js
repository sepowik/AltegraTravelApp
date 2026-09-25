import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { t, label, setLanguage, getLanguage, DICTIONARIES, DEFAULT_LANGUAGE } from '../js/i18n.js';
import { expenseValues, formatDuration, TRANSPORTS, expensesCsv } from '../js/util.js';

afterEach(() => setLanguage(DEFAULT_LANGUAGE));

test('default language is English', () => {
  assert.equal(DEFAULT_LANGUAGE, 'en');
  assert.equal(getLanguage(), 'en');
  assert.equal(t('nav.home'), 'Home');
});

test('all languages define the same keys', () => {
  const keys = Object.keys(DICTIONARIES.en).sort();
  for (const lang of ['sv', 'de']) {
    const other = Object.keys(DICTIONARIES[lang]).sort();
    assert.deepEqual(other.filter((k) => !keys.includes(k)), [], `${lang} has extra keys`);
    assert.deepEqual(keys.filter((k) => !other.includes(k)), [], `${lang} is missing keys`);
  }
});

test('placeholders match across languages', () => {
  const ph = (v) => JSON.stringify([].concat(v).map((s) => (s.match(/\{\w+\}/g) || []).sort()));
  for (const [k, v] of Object.entries(DICTIONARIES.en)) {
    for (const lang of ['sv', 'de']) assert.equal(ph(DICTIONARIES[lang][k]), ph(v), `${lang}.${k}`);
  }
});

test('switching language, plurals and unknown language', () => {
  setLanguage('sv');
  assert.equal(t('nav.home'), 'Hem');
  assert.equal(t('distanceDone', { n: 2 }), 'Avstånd beräknat för 2 delsträckor');
  setLanguage('de');
  assert.equal(t('receipt', { n: 1 }), 'Beleg');
  assert.equal(TRANSPORTS[0].label, 'Privat-Pkw');
  setLanguage('xx');
  assert.equal(getLanguage(), 'en');
});

test('stored ids stay the same, display and copy are translated', () => {
  const e = { date: '2026-09-21', amount: 120, currency: 'SEK', category: 'Meal', payment: 'Cash', status: 'todo' };
  setLanguage('sv');
  const v = expenseValues(e);
  assert.equal(v.category, 'Måltid');
  assert.equal(v.payment, 'Kontant');
  assert.equal(label('cat', 'Custom thing'), 'Custom thing');
  assert.equal(formatDuration(65 * 60000), '1h 5min');
  assert.match(expensesCsv([e]), /^Datum;Belopp;.*\r\n2026-09-21;120,00;SEK;Måltid;.*;Att rapportera$/);
  // A company mapping still wins over the translation.
  assert.equal(expenseValues(e, { company: { categoryMap: { Meal: 'Traktamente' } } }).category, 'Traktamente');
});
