'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assignColors, slotFor, cleanColorMap, STATUS_SLOTS, STATUS_SLOT_RANGES, STATUS_PICK_ORDER,
} = require('../public/status-colors.js');

const st = (id, name, category) => ({ id: String(id), name, category });
const inRange = (slot, cat) => slot >= STATUS_SLOT_RANGES[cat][0] && slot <= STATUS_SLOT_RANGES[cat][1];

test('the palette ranges cover all 24 slots once, in stage order', () => {
  assert.equal(STATUS_SLOTS, 24);
  const r = STATUS_SLOT_RANGES;
  assert.deepEqual([r.new[0], r.indeterminate[0] - 1, r.done[0] - 1, r.done[1]],
    [0, r.new[1], r.indeterminate[1], 23]);
});

test('statuses get slots by category, then JIRA id, each within its category hues', () => {
  const map = assignColors([
    st(10001, 'Done', 'done'), st(3, 'In Progress', 'indeterminate'), st(1, 'To Do', 'new'),
    st(10002, 'Untested', 'indeterminate'), st(4, 'In Review', 'indeterminate'),
  ], {});
  assert.equal(map['to do'], STATUS_PICK_ORDER.new[0]);
  assert.deepEqual([map['in progress'], map['in review'], map.untested], STATUS_PICK_ORDER.indeterminate.slice(0, 3));
  assert.equal(map.done, STATUS_PICK_ORDER.done[0]);
});

test('each pick order is a permutation of its range', () => {
  for (const [cat, [lo, hi]] of Object.entries(STATUS_SLOT_RANGES)) {
    const want = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    assert.deepEqual([...STATUS_PICK_ORDER[cat]].sort((a, b) => a - b), want, cat);
  }
});

test('saved slots are kept and a new status takes the next free slot without moving others', () => {
  const saved = { 'in progress': 8, 'to do': 2 };
  const map = assignColors([
    st(1, 'To Do', 'new'), st(2, 'Backlog', 'new'), st(3, 'In Progress', 'indeterminate'), st(4, 'QA Testing', 'indeterminate'),
  ], saved);
  assert.equal(map['to do'], 2);
  assert.equal(map['in progress'], 8);
  assert.equal(map.backlog, 0);
  assert.equal(map['qa testing'], STATUS_PICK_ORDER.indeterminate[0]);
  assert.deepEqual(saved, { 'in progress': 8, 'to do': 2 }); // input not mutated
});

test('a full category range reuses its own slots in pick order', () => {
  const order = STATUS_PICK_ORDER.new;
  const size = order.length;
  const statuses = Array.from({ length: size + 2 }, (_, i) => st(i + 1, 'New ' + i, 'new'));
  const map = assignColors(statuses, {});
  assert.equal(map['new ' + (size - 1)], order[size - 1]);
  assert.equal(map['new ' + size], order[0]);
  assert.equal(map['new ' + (size + 1)], order[1]);
});

test('an unknown category is treated as in progress', () => {
  const map = assignColors([st(7, 'Odd', '')], {});
  assert.ok(inRange(map.odd, 'indeterminate'));
});

test('slotFor is case-insensitive and falls back to a stable hash in the category range', () => {
  const map = { 'in review': 9 };
  assert.equal(slotFor('In Review', 'indeterminate', map), 9);
  assert.equal(slotFor('  IN REVIEW ', 'indeterminate', map), 9);
  const a = slotFor('Waiting for Vendor', 'indeterminate', {});
  assert.equal(slotFor('waiting for vendor', 'indeterminate', {}), a);
  assert.ok(inRange(a, 'indeterminate'));
  assert.ok(inRange(slotFor('Archived', 'done', null), 'done'));
  assert.equal(slotFor('', 'new', {}), null);
});

test('cleanColorMap keeps valid entries only and lower-cases names', () => {
  assert.deepEqual(cleanColorMap({ ' To Do ': 1, Done: 23, bad: 24, neg: -1, frac: 1.5, str: '3', '': 4 }),
    { 'to do': 1, done: 23 });
  assert.deepEqual(cleanColorMap(null), {});
  assert.deepEqual(cleanColorMap([1, 2]), {});
  assert.equal(Object.keys(cleanColorMap({ ['x'.repeat(101)]: 1 })).length, 0);
});

/* ---------------- palette in styles.css ---------------- */

const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const block = (selector) => {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, 'missing ' + selector);
  return css.slice(start, css.indexOf('}', start));
};
const tokens = (text) => Object.fromEntries(
  [...text.matchAll(/--(st-\d+-(?:bg|ink)):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

for (const [theme, selector] of [['light', ':root'], ['dark', ':root[data-theme="dark"]']]) {
  test(`every palette slot has readable ${theme} badge colours (WCAG AA 4.5:1)`, () => {
    const t = tokens(block(selector));
    for (let i = 0; i < STATUS_SLOTS; i++) {
      const bg = t[`st-${i}-bg`];
      const ink = t[`st-${i}-ink`];
      assert.ok(bg && ink, `slot ${i} missing in ${theme}`);
      const ratio = contrast(bg, ink);
      assert.ok(ratio >= 4.5, `slot ${i} ${theme}: ${bg} on ${ink} is ${ratio.toFixed(2)}:1`);
    }
  });
}

test('every palette slot has a badge rule using its tokens', () => {
  for (let i = 0; i < STATUS_SLOTS; i++) {
    const rule = new RegExp(`\\.status\\.st-${i}\\s*\\{[^}]*var\\(--st-${i}-bg\\)[^}]*var\\(--st-${i}-ink\\)`);
    assert.ok(rule.test(css), `no .status.st-${i} rule`);
  }
});

/* ---------------- Settings list ---------------- */

const { statusColorRows } = require('../public/status-colors.js');

test('statusColorRows lists statuses by slot, with the stage of the slot and who shares it', () => {
  const rows = statusColorRows({ done: 18, 'to do': 0, 'in review': 7, closed: 18, 'in progress': 6 });
  assert.deepEqual(rows.map((r) => [r.name, r.slot, r.category]), [
    ['to do', 0, 'new'], ['in progress', 6, 'indeterminate'], ['in review', 7, 'indeterminate'],
    ['closed', 18, 'done'], ['done', 18, 'done'],
  ]);
  assert.deepEqual(rows.find((r) => r.name === 'done').sharedWith, ['closed']);
  assert.deepEqual(rows.find((r) => r.name === 'to do').sharedWith, []);
  assert.deepEqual(statusColorRows(null), []);
});
