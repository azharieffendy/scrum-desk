/* ================================================================
   Performance report periods — calendar-aligned, 1 to 12 months.

   Pure and shared: lib/pi-core.js requires it, the browser loads it
   before pi-report.js. The length (Settings → Performance report) splits the year
   evenly; each length has its own ID form, so saved results of one
   length are never mistaken for another:
     12 → '2026'      6 → '2026-H2'   4 → '2026-P2' (the original form)
      3 → '2026-Q3'   2 → '2026-B5'   1 → '2026-09'
   ================================================================ */
'use strict';

const PiPeriods = (() => {
  const LENGTHS = [1, 2, 3, 4, 6, 12];
  const DEFAULT_LENGTH = 4;
  const LETTER = { 6: 'H', 4: 'P', 3: 'Q', 2: 'B' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];
  const pad = (n) => String(n).padStart(2, '0');

  const isLength = (n) => (typeof n === 'number' || typeof n === 'string') && /^\d{1,2}$/.test(String(n)) &&
    LENGTHS.includes(Number(n));
  /** A saved length, or the default when it is missing or unknown. */
  const lengthOr = (n) => (isLength(n) ? Number(n) : DEFAULT_LENGTH);

  /** '2026-Q3' → { year: 2026, months: 3, index: 3 }; null when it is not a period. */
  function parse(p) {
    const s = String(p == null ? '' : p);
    let m = /^(\d{4})$/.exec(s);
    if (m) return { year: Number(m[1]), months: 12, index: 1 };
    m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(s);
    if (m) return { year: Number(m[1]), months: 1, index: Number(m[2]) };
    m = /^(\d{4})-([HPQB])(\d)$/.exec(s);
    if (!m) return null;
    const months = Number(Object.keys(LETTER).find((k) => LETTER[k] === m[2]));
    const index = Number(m[3]);
    return index >= 1 && index <= 12 / months ? { year: Number(m[1]), months, index } : null;
  }

  function id(year, months, index) {
    if (months === 12) return String(year);
    if (months === 1) return year + '-' + pad(index);
    return year + '-' + LETTER[months] + index;
  }

  const isValid = (p) => parse(p) !== null;
  const lengthOf = (p) => parse(p).months;

  /** First and last month (1–12) of a period. */
  function monthSpan(p) {
    const { months, index } = parse(p);
    const first = (index - 1) * months + 1;
    return { first, last: first + months - 1 };
  }

  /** '2026-P2' → { start: '2026-05-01', end: '2026-08-31', afterEnd: '2026-09-01' } (plain dates). */
  function range(p) {
    const { year } = parse(p);
    const { first, last } = monthSpan(p);
    const lastDay = new Date(Date.UTC(year, last, 0)).getUTCDate();
    const next = new Date(Date.UTC(year, last, 1)); // month index `last` is the month after the period
    return {
      start: year + '-' + pad(first) + '-01',
      end: year + '-' + pad(last) + '-' + pad(lastDay),
      afterEnd: next.getUTCFullYear() + '-' + pad(next.getUTCMonth() + 1) + '-01',
    };
  }

  /** The period of the given length containing a 'YYYY-MM-DD' day. */
  function ofDay(day, months) {
    const len = lengthOr(months);
    return id(Number(day.slice(0, 4)), len, Math.floor((Number(day.slice(5, 7)) - 1) / len) + 1);
  }

  function shift(p, by) {
    const { year, months, index } = parse(p);
    const per = 12 / months;
    const n = year * per + (index - 1) + by;
    return id(Math.floor(n / per), months, (((n % per) + per) % per) + 1);
  }

  /** The report is sent after a period ends, so the default is the one before the day's. */
  const lastFinished = (day, months) => shift(ofDay(day, months), -1);

  /** Every period of a length in one year, in order. */
  function ofYear(year, months) {
    const len = lengthOr(months);
    return Array.from({ length: 12 / len }, (_, i) => id(year, len, i + 1));
  }

  /** '2026-P2' → 'May – Aug' (no year); a one-month period → 'Sep'. */
  function shortLabel(p) {
    const { first, last } = monthSpan(p);
    const s = (m) => MONTHS[m - 1].slice(0, 3);
    return first === last ? s(first) : s(first) + ' – ' + s(last);
  }

  /** '2026-P2' → 'May – Aug 2026'. */
  const label = (p) => shortLabel(p) + ' ' + parse(p).year;

  /** '2026-P2' → 'MAY AUGUST' for the download name. */
  function words(p) {
    const { first, last } = monthSpan(p);
    const w = (m) => MONTHS[m - 1].toUpperCase();
    return first === last ? w(first) : w(first) + ' ' + w(last);
  }

  /** Settings choice text, e.g. '4 months (Jan – Apr, May – Aug, Sep – Dec)'. */
  function lengthLabel(months) {
    const len = lengthOr(months);
    const name = len === 1 ? '1 month' : len === 12 ? '12 months' : len + ' months';
    if (len === 1) return name + ' (Jan, Feb, …)';
    if (len === 12) return name + ' (Jan – Dec)';
    const all = ofYear(2000, len).map(shortLabel);
    return name + ' (' + (all.length > 3 ? all.slice(0, 2).join(', ') + ', …' : all.join(', ')) + ')';
  }

  return {
    LENGTHS, DEFAULT_LENGTH, isLength, lengthOr, parse, isValid, lengthOf, range, ofDay, shift, lastFinished,
    ofYear, shortLabel, label, words, lengthLabel,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PiPeriods;
