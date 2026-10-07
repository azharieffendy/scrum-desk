/*
 * Unit tests for the monthly report and the .xlsx writer. Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMonthlyReport, reportSheets, shiftMonth, isValidMonth } = require('../public/monthly-report.js');
const XlsxLite = require('../public/xlsx.js');

const members = [
  { id: 'a', name: 'Andi', role: 'Backend', color: '#E85D4A' },
  { id: 'b', name: 'Sari', role: 'QA', color: '#2E9E5B' },
];

// September 2026: 1st is a Tuesday, 5th/6th are the weekend
const state = {
  members,
  days: {
    '2026-09-01': { entries: { a: { attendance: 'late', today: 'deploy' }, b: { yesterday: 'tests' } }, jira: null, startedAt: 's' },
    '2026-09-02': { entries: { b: { attendance: 'leave' } }, jira: null, startedAt: 's' },
    '2026-09-03': { entries: {}, jira: { syncedAt: 'x', sprint: { name: 'S14' }, issues: [] }, startedAt: 's' }, // started, all present
    '2026-09-04': { entries: {}, jira: { syncedAt: 'x', issues: [] }, startedAt: null },   // holiday: auto-sync, never started
    '2026-09-05': { entries: {}, jira: { syncedAt: 'x', issues: [] }, startedAt: null },   // weekend auto-sync only
    '2026-10-01': { entries: { a: { attendance: 'sick' } }, jira: null, startedAt: 's' },  // other month
  },
};

/** Reads the stored (uncompressed) entries of a ZIP produced by XlsxLite. */
function unzipStored(bytes) {
  const buf = Buffer.from(bytes);
  const files = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    assert.equal(buf.readUInt16LE(p + 8), 0, 'stored method');
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    files[name] = buf.toString('utf8', p + 30 + nameLen, p + 30 + nameLen + size);
    p += 30 + nameLen + size;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'end of central directory');
  return files;
}

test('month helpers', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.ok(isValidMonth('2026-09'));
  assert.ok(!isValidMonth('2026-13'));
  assert.throws(() => buildMonthlyReport(state, '2026/09'));
});

test('monthly report counts recorded days per member', () => {
  const r = buildMonthlyReport(state, '2026-09');
  assert.equal(r.dates.length, 30);
  assert.equal(r.label, 'September 2026');
  assert.deepEqual(r.dates.filter((d) => d.recorded).map((d) => d.iso), ['2026-09-01', '2026-09-02', '2026-09-03']);

  const andi = r.members.find((m) => m.id === 'a');
  assert.deepEqual(andi.counts, { present: 2, late: 1, leave: 0, sick: 0, noshow: 0 });
  assert.equal(andi.rate, 1);
  assert.equal(andi.statuses['2026-09-01'], 'late');
  assert.equal(andi.statuses['2026-09-05'], undefined);

  const sari = r.members.find((m) => m.id === 'b');
  assert.deepEqual(sari.counts, { present: 2, late: 0, leave: 1, sick: 0, noshow: 0 });
  assert.equal(Math.round(sari.rate * 100), 67);

  assert.equal(r.totals.memberDays, 6);
  assert.equal(r.details.length, 3);
  assert.equal(r.details[0].entries[0].today, 'deploy');
  assert.equal(r.details[2].sprint, 'S14');
});

test('only started days count; legacy days without the flag count when they have notes', () => {
  const r = buildMonthlyReport({
    members,
    days: {
      '2026-07-01': { entries: { a: { today: 'x' } }, jira: null },                   // legacy, has notes
      '2026-07-02': { entries: {}, jira: { syncedAt: 'x', issues: [] } },              // legacy, JIRA only
      '2026-07-03': { entries: { a: { attendance: 'sick' } }, jira: null, startedAt: null }, // cancelled
      '2026-07-04': { entries: {}, jira: null, startedAt: 's' },                       // Saturday, started
    },
  }, '2026-07');
  assert.deepEqual(r.dates.filter((d) => d.recorded).map((d) => d.iso), ['2026-07-01', '2026-07-04']);
});

test('historical rosters exclude later joiners and retain removed members', () => {
  const removed = { id: 'old', name: 'Former member', role: 'QA', color: '#3D51E0' };
  const joined = { id: 'new', name: 'New member', role: 'QA', color: '#E85D4A' };
  const report = buildMonthlyReport({
    members: [joined],
    days: {
      '2026-09-01': { startedAt: 's', roster: [removed], entries: { old: { attendance: 'sick', today: 'old note' } } },
      '2026-09-02': { startedAt: 's', roster: [removed, joined], entries: {} },
    },
  }, '2026-09');
  const old = report.members.find((m) => m.id === 'old');
  const newcomer = report.members.find((m) => m.id === 'new');
  assert.equal(old.recorded, 2);
  assert.equal(old.counts.sick, 1);
  assert.equal(newcomer.recorded, 1);
  assert.equal(newcomer.statuses['2026-09-01'], undefined);
  assert.equal(report.totals.memberDays, 3);
  assert.equal(report.details[0].entries[0].today, 'old note');
});

test('empty month has no rate', () => {
  const r = buildMonthlyReport(state, '2026-08');
  assert.equal(r.recordedDays, 0);
  assert.equal(r.members[0].rate, null);
  assert.equal(r.totals.rate, null);
});

test('ticket lookup is included in the details', () => {
  const r = buildMonthlyReport(state, '2026-09', (iso, id) =>
    iso === '2026-09-03' && id === 'a' ? [{ key: 'PAY-1', summary: 'Fix', status: 'Done' }] : []);
  assert.deepEqual(r.details[2].entries[0].tickets, [{ key: 'PAY-1', summary: 'Fix', status: 'Done' }]);
});

test('excel workbook has three sheets with the report data', () => {
  const report = buildMonthlyReport(state, '2026-09');
  const bytes = XlsxLite.build(reportSheets(report, '2026-09-30 10:00'));
  const files = unzipStored(bytes);

  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml',
    'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']) {
    assert.ok(files[part], 'missing ' + part);
  }
  assert.match(files['xl/workbook.xml'], /name="Summary".*name="Attendance".*name="Daily detail"/);
  assert.match(files['xl/worksheets/sheet1.xml'], /Attendance report — September 2026/);
  assert.match(files['xl/worksheets/sheet2.xml'], /<t xml:space="preserve">LV<\/t>/);
  assert.match(files['xl/worksheets/sheet3.xml'], /deploy/);
});

test('xlsx writer escapes text and strips control characters', () => {
  const files = unzipStored(XlsxLite.build([{ name: 'a/b:c', rows: [['<b>&"x"\u0001', 3.5, null]] }]));
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /&lt;b&gt;&amp;&quot;x&quot;<\/t>/);
  assert.match(sheet, /<c r="B1"><v>3.5<\/v><\/c>/);
  assert.match(files['xl/workbook.xml'], /name="a b c"/);
});

test('xlsx writer turns cells with a link into external hyperlinks', () => {
  const files = unzipStored(XlsxLite.build([
    { name: 'Plain', rows: [['x']] },
    { name: 'Links', rows: [['head'], [{ v: 'A-1', s: 'link', link: 'https://t.atlassian.net/browse/A-1?a=1&b=2' },
      { v: 'B-2', link: 'javascript:alert(1)' }]] },
  ]));
  const sheet = files['xl/worksheets/sheet2.xml'];
  assert.match(sheet, /^<\?xml[^>]*><worksheet [^>]*xmlns:r="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships"/);
  assert.match(sheet, /<\/sheetData><hyperlinks><hyperlink ref="A2" r:id="rId1"\/><\/hyperlinks><\/worksheet>$/);
  assert.match(sheet, /<c r="A2" s="16" t="inlineStr"><is><t xml:space="preserve">A-1<\/t>/);
  assert.match(files['xl/worksheets/_rels/sheet2.xml.rels'],
    /<Relationship Id="rId1" Type="[^"]+\/hyperlink" Target="https:\/\/t.atlassian.net\/browse\/A-1\?a=1&amp;b=2" TargetMode="External"\/>/);
  assert.doesNotMatch(files['xl/worksheets/_rels/sheet2.xml.rels'], /javascript/);
  assert.equal(files['xl/worksheets/_rels/sheet1.xml.rels'], undefined);
  assert.doesNotMatch(files['xl/worksheets/sheet1.xml'], /hyperlink/);
  assert.match(files['xl/styles.xml'], /<cellXfs count="19">/);
});

test('xlsx writer writes date cells as serial numbers with a date format', () => {
  const files = unzipStored(XlsxLite.build([{ name: 'D', rows: [[{ v: 46147.5, s: 'date' }, { v: 46147, s: 'day' }]] }]));
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="A1" s="17"><v>46147.5<\/v><\/c>/);
  assert.match(sheet, /<c r="B1" s="18"><v>46147<\/v><\/c>/);
  const styles = files['xl/styles.xml'];
  assert.match(styles, /<numFmts count="1"><numFmt numFmtId="164" formatCode="d\/m\/yyyy h:mm"\/><\/numFmts><fonts/);
  const xfs = styles.split('<cellXfs')[1].match(/<xf [^>]*>/g);
  assert.match(xfs[17], /numFmtId="164"[^>]*applyNumberFormat="1"/);
  assert.match(xfs[18], /numFmtId="14"[^>]*applyNumberFormat="1"/);
});
