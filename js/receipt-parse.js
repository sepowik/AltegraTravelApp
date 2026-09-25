// Turns OCR text from a receipt into expense fields. Pure and unit tested.
// Receipts vary a lot, so every rule here is a heuristic; the form shows what was
// filled in so the user can check it.

// Words that mark the line with the amount actually paid, strongest first.
const TOTAL_WORDS = [
  ['att betala', 'to pay', 'amount due', 'zu zahlen', 'gesamtbetrag', 'grand total', 'totalbelopp', 'summe eur', 'total sek', 'total eur'],
  ['totalt', 'total', 'summa', 'summe', 'gesamt', 'betalt', 'paid', 'bezahlt'],
  ['kortbetalning', 'kort', 'card', 'visa', 'mastercard', 'bankkort', 'kontokort', 'karte', 'ec-karte', 'belopp', 'betrag', 'amount', 'kontant', 'cash', 'bar'],
];
const VAT_WORDS = ['moms', 'vat', 'mwst', 'mw.st', 'ust', 'mehrwertsteuer', 'tax', 'varav'];
const NOT_TOTAL_WORDS = ['netto', 'exkl', 'excl', 'subtotal', 'delsumma', 'zwischensumme', 'växel', 'vaxel', 'change', 'rückgeld', 'retur', 'rabatt', 'discount', 'tips', 'dricks'];

const CURRENCY_HINTS = [
  ['EUR', /€|\beur\b|\beuro\b/i],
  ['USD', /\$|\busd\b/i],
  ['GBP', /£|\bgbp\b/i],
  ['NOK', /\bnok\b/i],
  ['DKK', /\bdkk\b/i],
  ['CHF', /\bchf\b/i],
  ['PLN', /\bpln\b|\bzł\b/i],
  ['SEK', /\bsek\b|\bkr\b|\d:-|\bkronor\b/i],
];

const CATEGORY_HINTS = [
  ['Hotel', /\bhotell?\b|scandic|radisson|clarion|quality hotel|elite hotel|best western|comfort hotel|hilton|marriott|ibis|novotel|motel|hostel|logi|übernachtung|nights?\b|nätter|natt\b/i],
  ['Taxi', /\btaxi\b|\buber\b|\bbolt\b|cabonline|taxikurir|sverigetaxi|\bcab\b/i],
  ['Train', /\bsj\b|\bmtr\b|\btåg\b|\btag\b|\btrain\b|deutsche bahn|\bdb\b|\bice\b|öresundståg|snälltåget|\bvy\b|\bbahn\b|arlanda express|flygtåget/i],
  ['Flight', /\bsas\b|norwegian|lufthansa|ryanair|klm|finnair|braathens|\bflyg\b|\bflight\b|boarding|\bflug\b/i],
  ['Parking', /parkering|parking|easypark|\bparken\b|apcoa|q-park|aimo|parkster|parkhaus/i],
  ['Fuel', /circle k|preem|okq8|\bst1\b|\bshell\b|ingo|\bqstar\b|diesel|bensin|\bfuel\b|\baral\b|\besso\b|kraftstoff|\bliter\b|\blitres?\b/i],
  ['Rental car', /hertz|\bavis\b|europcar|\bsixt\b|enterprise rent|budget rent|biluthyrning|mietwagen|car rental/i],
  ['Toll', /trängselskatt|brobizz|öresundsbron|\bmaut\b|\btoll\b|vägavgift|infrastrukturavgift/i],
  ['Local transport', /\bsl\b|västtrafik|skånetrafiken|\bul\b|östgötatrafiken|\bbuss\b|\bbus\b|tunnelbana|u-bahn|s-bahn|\bmetro\b|\btram\b|spårvagn|\bmvv\b|\bbvg\b|\bhvv\b|ruter/i],
  ['Meal', /restaurang|restaurant|\bcaf[eé]\b|kaffe|espresso|coffee|lunch|middag|frukost|dinner|breakfast|pizza|burger|\bbar\b|bistro|gasthaus|kneipe|mcdonald|max hamburgare|pressbyrån|7-eleven|\bsushi\b|kebab|\bmat\b|gaststätte|bäckerei|konditori/i],
  ['Conference', /konferens|conference|seminar|tagung|kongress|registration fee/i],
];

const MONTHS = {
  jan: 1, januari: 1, january: 1, januar: 1, jän: 1,
  feb: 2, februari: 2, february: 2, februar: 2,
  mar: 3, mars: 3, march: 3, märz: 3, mär: 3, maerz: 3,
  apr: 4, april: 4,
  maj: 5, may: 5, mai: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, augusti: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, dez: 12, december: 12, dezember: 12,
};

// Matches money amounts: 1 234,56 / 1.234,56 / 1,234.56 / 245.00 / 245,- / 245:-
const AMOUNT_RE = /(?<![\d.,])(\d{1,3}(?:[ ., ]\d{3})+|\d+)(?:\s?([.,])\s?(\d{2})|\s?[:,.]-)(?![\d%])/g;

function toNumber(intPart, decimals) {
  const whole = intPart.replace(/[ ., ]/g, '');
  const n = Number(`${whole}.${decimals || '00'}`);
  return Number.isFinite(n) ? n : NaN;
}

// All money amounts on a line, skipping percentages.
export function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const after = line.slice(m.index + m[0].length).trimStart();
    if (after.startsWith('%')) continue;
    const n = toNumber(m[1], m[3]);
    if (Number.isFinite(n) && n > 0 && n < 1000000) out.push(n);
  }
  return out;
}

const hasWord = (line, words) => words.some((w) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu').test(line));

// Common OCR slips inside numbers: O→0, l/I→1, S→5 when surrounded by digits.
function cleanLine(line) {
  return line
    .replace(/(?<=\d)[oO](?=\d|[.,]\d)/g, '0')
    .replace(/(?<=\d[.,]?)[oO](?=\b)/g, '0')
    .replace(/(?<=\d)[lI](?=\d)/g, '1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findTotal(lines) {
  for (let level = 0; level < TOTAL_WORDS.length; level++) {
    const candidates = [];
    lines.forEach((line, i) => {
      if (!hasWord(line, TOTAL_WORDS[level]) || hasWord(line, NOT_TOTAL_WORDS)) return;
      if (hasWord(line, VAT_WORDS) && !hasWord(line, ['inkl', 'incl', 'inkl.', 'including'])) return;
      let nums = amountsIn(line);
      // The amount is often on the next line in two-column layouts.
      if (!nums.length && lines[i + 1]) nums = amountsIn(lines[i + 1]);
      candidates.push(...nums);
    });
    if (candidates.length) return Math.max(...candidates);
  }
  return null;
}

export function findVat(lines, total) {
  const found = [];
  lines.forEach((line, i) => {
    if (!hasWord(line, VAT_WORDS) || hasWord(line, ['exkl', 'excl', 'netto'])) return;
    let nums = amountsIn(line);
    if (!nums.length && lines[i + 1] && !hasWord(lines[i + 1], TOTAL_WORDS.flat())) nums = amountsIn(lines[i + 1]);
    // "Moms 25% 20,00 80,00 100,00" lists vat, net and gross: the VAT is the smallest.
    const plausible = nums.filter((n) => total == null || n < total * 0.35);
    if (plausible.length) found.push(Math.min(...plausible));
  });
  if (!found.length) return null;
  // Several VAT rates (e.g. 12% food + 25% drinks) usually come with a sum line; take the largest.
  return Math.max(...found);
}

function validDate(y, m, d, now) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1) return null;
  const ageDays = (now - date) / 86400000;
  if (ageDays < -2 || ageDays > 800) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function findDate(text, now = Date.now()) {
  const candidates = [];
  const push = (idx, v) => { if (v) candidates.push([idx, v]); };
  for (const m of text.matchAll(/\b(20\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/g)) push(m.index, validDate(+m[1], +m[2], +m[3], now));
  for (const m of text.matchAll(/\b(\d{1,2})[-./](\d{1,2})[-./](20\d{2}|\d{2})\b/g)) push(m.index, validDate(+m[3], +m[2], +m[1], now));
  for (const m of text.matchAll(/\b(\d{1,2})\.?\s+([a-zäöüé]{3,9})\.?\s+(20\d{2})\b/gi)) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon) push(m.index, validDate(+m[3], mon, +m[1], now));
  }
  for (const m of text.matchAll(/\b([a-zäöüé]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/gi)) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon) push(m.index, validDate(+m[3], mon, +m[2], now));
  }
  // Compact Swedish style 260925 next to a time, e.g. "260925 14:32".
  for (const m of text.matchAll(/\b(\d{2})(\d{2})(\d{2})\s+\d{1,2}:\d{2}\b/g)) push(m.index, validDate(+m[1], +m[2], +m[3], now));
  candidates.sort((a, b) => a[0] - b[0]);
  return candidates[0]?.[1] ?? null;
}

export function findCurrency(text) {
  const hit = CURRENCY_HINTS.find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
}

const SKIP_MERCHANT = /(?<!\p{L})(kvitto|receipt|quittung|beleg|kassa|org\.?\s?nr|orgnr|vat no|moms ?nr|ust-?id|tel|telefon|phone|datum|date|kassör|cashier|välkommen|welcome|willkommen|tack|thank|danke)(?!\p{L})|www\.|http|@|^\W*$/iu;

function titleCase(s) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-/&])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(Ab|Hb|Gmbh|Ag|Ltd|As|Oy)\b/g, (w) => w.toUpperCase());
}

export function findMerchant(lines) {
  for (const raw of lines.slice(0, 6)) {
    const line = raw.replace(/^[^\p{L}\d]+|[^\p{L}\d.)]+$/gu, '').trim();
    const letters = (line.match(/\p{L}/gu) || []).length;
    if (letters < 3 || letters < line.length * 0.5 || SKIP_MERCHANT.test(line)) continue;
    return titleCase(line).slice(0, 60);
  }
  return null;
}

export function guessCategory(text) {
  const hit = CATEGORY_HINTS.find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
}

// Returns only the fields it found; missing ones are left out.
export function parseReceiptText(text, { now = Date.now() } = {}) {
  const lines = String(text || '').split(/\r?\n/).map(cleanLine).filter(Boolean);
  const joined = lines.join('\n');
  const result = {};
  const amount = findTotal(lines);
  if (amount != null) result.amount = amount;
  const vat = findVat(lines, amount);
  if (vat != null) result.vat = vat;
  const date = findDate(joined, now);
  if (date) result.date = date;
  const currency = findCurrency(joined);
  if (currency) result.currency = currency;
  const merchant = findMerchant(lines);
  if (merchant) result.merchant = merchant;
  const category = guessCategory(joined);
  if (category) result.category = category;
  return result;
}
