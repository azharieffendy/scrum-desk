/*
 * PI report service (lib/pi-service.js): /api/pi and /api/pi/preview — against
 * a temporary database and a fake JIRA. No network. Run: npm test
 */
'use strict';

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-desk-pisrv-'));
process.env.DATA_DIR = dataDir;
for (const k of ['JIRA_SITE', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete process.env[k];
const db = require('../lib/db.js');
const { createPiService } = require('../lib/pi-service.js');

const SITE = 'https://team.atlassian.net';
const NOW = Date.parse('2026-10-01T03:00:00Z');
const realFetch = globalThis.fetch;

after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

let routes; let searches; let byAssignee; let calls;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const on = (match, reply) => routes.unshift({ match, reply: typeof reply === 'function' ? reply : () => reply });

const TEAM = [
  { id: 'm1', name: 'Alex', email: 'alex@example.com' },
  { id: 'm2', name: 'Taylor', email: 'taylor@example.com' },
  { id: 'm3', name: 'Casey', email: 'casey@example.com' },
  { id: 'm4', name: 'Morgan', email: '' },
];

const raw = (key, timespent, points) => ({
  id: key.replace(/\D/g, ''), key,
  fields: {
    issuetype: { name: 'Task' }, summary: 'Do ' + key, status: { name: 'DONE' }, resolution: { name: 'Done' },
    created: '2026-05-02T09:00:00.000+0700', resolutiondate: '2026-06-01T10:00:00.000+0700',
    timespent, customfield_10032: points,
  },
});

/** The assignee value the filled JQL carries. */
const assigneeIn = (jql) => (/assignee = '([^']+)'/.exec(jql) || [])[1];

beforeEach(() => {
  db.savePatch({ baseVersion: db.getStateVersion(),
    patch: { members: TEAM, mapping: { 'acc-1': 'm1', 'acc-2': 'm2', 'acc-3': 'm3' }, settings: { kpiMembers: ['m1', 'm2'], piJql: '', piPrefix: '', piPeriodMonths: 4 } },
    creds: { site: 'team', email: 'lead@example.com', token: 'secret', kpiBoardId: '', kpiPointsField: '' } });
  routes = [];
  searches = [];
  byAssignee = {
    'acc-1': [[raw('DEMO-1', 3600, 2), raw('DEMO-2', null, null)]],
    'acc-2': [[raw('DEMO-3', 1800, 1)], [raw('DEMO-4', 1800, 3)]], // two pages
    'acc-3': [[raw('DEMO-5', 7200, 5)]],
  };
  calls = [];
  db.clearPiCache();
  db.setKpiSetting('sprintField', '');
  on(/^\/rest\/api\/3\/field$/, [{ id: 'customfield_10032', name: 'Story Points' }]);
  on(/^\/rest\/api\/3\/search\/jql$/, (p, body) => {
    searches.push(body);
    const pages = byAssignee[assigneeIn(body.jql)] || [[]];
    const i = body.nextPageToken ? Number(body.nextPageToken) : 0;
    return { issues: pages[i], nextPageToken: i + 1 < pages.length ? String(i + 1) : undefined, isLast: i + 1 >= pages.length };
  });
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url).slice(SITE.length));
    const p = String(url).slice(SITE.length).split('?')[0];
    const body = init.body ? JSON.parse(init.body) : null;
    const r = routes.find((x) => x.match.test(p));
    if (!r) return json({ errorMessages: ['no route for ' + p] }, 404);
    const out = r.reply(p, body);
    return out instanceof Response ? out : json(out);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const service = () => createPiService({ wait: async () => {}, now: () => NOW });
const get = (svc, opts = {}) => svc.handleRequest(Object.assign({ method: 'GET', path: '/api/pi', period: null, admin: true, memberId: '' }, opts));

test('defaults to the last finished period and searches once per person with the filled JQL', async () => {
  const res = await get(service());
  assert.equal(res.status, 200);
  const r = res.payload;
  assert.equal(r.period, '2026-P2');
  assert.equal(r.name, 'MAY AUGUST');
  assert.equal(r.prefix, 'TEAM');
  assert.equal(r.you, null);
  assert.deepEqual(r.people.map((p) => p.name), ['Alex', 'Taylor']);
  assert.deepEqual(searches.map((b) => assigneeIn(b.jql)), ['acc-1', 'acc-2', 'acc-2']);
  assert.ok(searches[0].jql.includes("resolutionDate < '2026-09-01'"));
  assert.ok(searches[0].fields.includes('timespent') && searches[0].fields.includes('customfield_10032'));
  const [alex, taylor] = r.people;
  assert.deepEqual(alex.totals, { seconds: 3600, hours: 1, points: 2, count: 2 });
  assert.equal(alex.rows[0].key, 'DEMO-1');
  assert.deepEqual(taylor.rows.map((x) => x.key), ['DEMO-3', 'DEMO-4'], 'all pages');
  assert.equal(taylor.totals.points, 4);
  assert.equal(db.getKpiSettings().pointsField, 'customfield_10032', 'detected field is saved');
});

test("rows carry each ticket's latest sprint when the site has a Sprint field", async () => {
  on(/^\/rest\/api\/3\/field$/, [{ id: 'customfield_10032', name: 'Story Points' },
    { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }]);
  byAssignee['acc-1'][0][0].fields.customfield_10020 = [{ id: 5, name: 'Demo Sprint 5', startDate: '2026-05-04T01:00:00.000Z' }];
  const [ferdi] = (await get(service())).payload.people;
  assert.ok(searches[0].fields.includes('customfield_10020'));
  assert.deepEqual(ferdi.rows.map((x) => x.sprint), ['Demo Sprint 5', '']);
});

test('the report still works when the sprint field lookup fails', async () => {
  db.setKpiSetting('pointsField', 'customfield_10032');
  on(/^\/rest\/api\/3\/field$/, () => json({ errorMessages: ['boom'] }, 403));
  const res = await get(service());
  assert.equal(res.status, 200);
  assert.equal(res.payload.people[0].rows[0].sprint, '');
});

test("hours are each ticket's Time Spent (JIRA Time tracking), whenever the work was logged; no worklog reads", async () => {
  const [ferdi] = (await get(service())).payload.people;
  assert.deepEqual(ferdi.rows.map((x) => x.timeSpent), [3600, null]);
  assert.equal(ferdi.totals.hours, 1);
  assert.ok(!calls.some((c) => c.includes('/worklog')), 'no worklog read');
});

test('a finished period is saved per person and served until a refresh', async () => {
  const first = (await get(service())).payload;
  assert.equal(first.finished, true);
  assert.equal(first.cachedAt, null);
  searches = []; calls = [];
  const again = (await get(service())).payload;
  assert.equal(searches.length, 0, 'no JIRA search');
  assert.ok(!calls.some((c) => c.includes('/worklog')), 'no worklog read');
  assert.equal(again.cachedAt, first.generatedAt);
  assert.deepEqual(again.people.map((p) => p.totals), first.people.map((p) => p.totals));
  assert.deepEqual(again.people[0].rows, first.people[0].rows);

  // a GET never re-reads JIRA, so a link or prefetch cannot overwrite the saved copy
  const viaGet = (await get(service(), { refresh: true })).payload;
  assert.equal(viaGet.cachedAt, first.generatedAt);
  assert.equal(searches.length, 0);

  const fresh = (await get(service(), { method: 'POST' })).payload;
  assert.equal(fresh.cachedAt, null);
  assert.ok(searches.length > 0);

  db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { piJql: "assignee = '{assignee}' AND resolved >= '{start}' AND resolved <= '{end}'" } } });
  searches = [];
  await get(service());
  assert.ok(searches.length > 0, 'a changed query is a miss');
});

test('the current period is never saved', async () => {
  const r = (await get(service(), { period: '2026-P3' })).payload;
  assert.equal(r.finished, false);
  searches = [];
  const again = (await get(service(), { period: '2026-P3' })).payload;
  assert.ok(searches.length > 0);
  assert.equal(again.cachedAt, null);
});

test('the Sprint field is looked up once and remembered', async () => {
  on(/^\/rest\/api\/3\/field$/, () => {
    calls.push('field');
    return [{ id: 'customfield_10032', name: 'Story Points' },
      { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }];
  });
  await get(service());
  assert.equal(db.getKpiSettings().sprintField, 'customfield_10020');
  calls = [];
  await get(service(), { method: 'POST' });
  assert.ok(!calls.includes('field'), 'no field lookup the second time');
  assert.ok(searches.at(-1).fields.includes('customfield_10020'));
});

test("the signed-in admin's linked member is added once", async () => {
  const added = (await get(service(), { memberId: 'm3' })).payload;
  assert.deepEqual(added.people.map((p) => [p.name, p.self]), [['Alex', false], ['Taylor', false], ['Casey', true]]);
  assert.deepEqual(added.you, { memberId: 'm3', name: 'Casey' });

  searches = [];
  const already = (await get(service(), { memberId: 'm1', method: 'POST' })).payload;
  assert.deepEqual(already.people.map((p) => p.name), ['Alex', 'Taylor']);
  assert.equal(searches.filter((b) => assigneeIn(b.jql) === 'acc-1').length, 1);

  const stale = (await get(service(), { memberId: 'gone' })).payload;
  assert.equal(stale.you, null);
  assert.equal(stale.people.length, 2);
});

test('nobody ticked for KPI means the whole team; a person without account or email gets an error', async () => {
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { kpiMembers: [] } } });
  const r = (await get(service())).payload;
  assert.deepEqual(r.people.map((p) => p.name), ['Alex', 'Taylor', 'Casey', 'Morgan']);
  const morgan = r.people[3];
  assert.match(morgan.error, /No JIRA account/);
  assert.deepEqual(morgan.rows, []);
});

test('one failing search is reported on that person; the others still return', async () => {
  on(/^\/rest\/api\/3\/search\/jql$/, (p, body) => {
    if (assigneeIn(body.jql) === 'acc-2') return json({ errorMessages: ["Field 'Start date' does not exist"] }, 400);
    return { issues: byAssignee[assigneeIn(body.jql)][0], isLast: true };
  });
  const r = (await get(service())).payload;
  assert.equal(r.people[0].error, null);
  assert.equal(r.people[0].rows.length, 2);
  assert.match(r.people[1].error, /Start date/);
});

test('the saved template and prefix are used', async () => {
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { kpiMembers: ['m1'],
    piJql: "assignee = '{assignee}' AND resolved >= '{start}' AND resolved <= '{end}'", piPrefix: 'DEMO' } } });
  const r = (await get(service(), { period: '2026-P1' })).payload;
  assert.equal(r.prefix, 'DEMO');
  assert.equal(searches[0].jql, "assignee = 'acc-1' AND resolved >= '2026-01-01' AND resolved < '2026-05-01'");
});

test('saving an invalid template is refused; prefix is cleaned', () => {
  assert.throws(() => db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { piJql: 'project = X' } } }),
    (e) => e.status === 400 && /\{assignee\}/.test(e.message));
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { piPrefix: ' a/b:c* ' } } });
  assert.equal(db.loadState().settings.piPrefix, 'abc');
});

test('admins only; bad period 400; JIRA not configured 400', async () => {
  const svc = service();
  assert.equal((await get(svc, { admin: false })).status, 403);
  assert.equal((await get(svc, { admin: false, path: '/api/pi/preview', person: 'm1' })).status, 403);
  assert.equal((await get(svc, { method: 'PUT' })).status, 405);
  assert.equal((await get(svc, { method: 'POST', path: '/api/pi/preview', person: 'm1' })).status, 405);
  assert.equal((await get(svc, { method: 'POST', admin: false })).status, 403);
  for (const bad of ['2026-P4', '2026-13', '2026-Q5', '2026-H0', 'x']) assert.equal((await get(svc, { period: bad })).status, 400, bad);
  assert.equal(searches.length, 0);
  db.savePatch({ baseVersion: db.getStateVersion(), patch: {}, creds: { site: '', email: '', token: '' } });
  const res = await get(svc);
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /not configured/);
});

test('preview returns the filled JQL for one member without calling JIRA', async () => {
  const svc = service();
  const res = await get(svc, { path: '/api/pi/preview', person: 'm3', period: '2026-P3' });
  assert.equal(res.status, 200);
  assert.equal(res.payload.person, 'Casey');
  assert.ok(res.payload.jql.includes("assignee = 'acc-3'"));
  assert.ok(res.payload.jql.includes("'2027-01-01'"));
  assert.equal((await get(svc, { path: '/api/pi/preview', person: 'nobody' })).status, 404);
  assert.equal((await get(svc, { path: '/api/pi/preview', person: 'm4' })).status, 400);
  assert.equal(searches.length, 0);
});

test('users can be linked to a team member', () => {
  const id = db.createUser('lead', 'secret123', 'admin');
  db.setUserMember(id, 'm3');
  assert.equal(db.listUsers().find((u) => u.id === id).memberId, 'm3');
  db.setUserMember(id, '');
  assert.equal(db.listUsers().find((u) => u.id === id).memberId, '');
  assert.throws(() => db.setUserMember(id, 'bad id!'), /Invalid member id/);
});

test('the period length setting: saved, refused when unknown, and used for the default period', async () => {
  assert.equal(db.loadState().settings.piPeriodMonths, 4);
  for (const bad of [5, 0, '3x', 'abc', 24]) {
    assert.throws(() => db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { piPeriodMonths: bad } } }),
      (e) => e.status === 400 && /Period length/.test(e.message), String(bad));
  }
  assert.equal(db.loadState().settings.piPeriodMonths, 4, 'a refused value changes nothing');
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { piPeriodMonths: '3' } } });
  assert.equal(db.loadState().settings.piPeriodMonths, 3);
  const r = (await get(service())).payload; // NOW is 2026-10-01: Q4 is running, Q3 is the last finished
  assert.equal(r.period, '2026-Q3');
  assert.equal(r.months, 3);
  assert.equal(r.name, 'JULY SEPTEMBER');
  assert.deepEqual([r.start, r.end], ['2026-07-01', '2026-09-30']);
  assert.ok(searches[0].jql.includes("resolutionDate < '2026-10-01'"));
  db.savePatch({ baseVersion: db.getStateVersion(), patch: { settings: { piPeriodMonths: 1 } } });
  assert.equal((await get(service())).payload.period, '2026-09');
});

test('each period length is saved separately, so switching back keeps the 4-month results', async () => {
  const fourMonths = (await get(service(), { period: '2026-P2' })).payload;
  const months = (await get(service(), { period: '2026-05' })).payload;
  assert.equal(months.cachedAt, null, 'a one-month period is not served from the 4-month save');
  assert.deepEqual([months.start, months.end], ['2026-05-01', '2026-05-31']);
  searches = [];
  const back = (await get(service(), { period: '2026-P2' })).payload;
  assert.equal(searches.length, 0, 'no JIRA search');
  assert.equal(back.cachedAt, fourMonths.generatedAt);
});

test('draft test counts all pages without saving the query or report cache', async () => {
  const before = db.loadState().settings.piJql;
  const svc = service();
  const template = "project = OTHER AND assignee = '{assignee}' AND status = 'DONE' AND resolutionDate >= '{start}' AND resolutionDate <= '{end}'";
  const out = await svc.handleRequest({method:'POST',path:'/api/pi/test',admin:true,body:{person:'m2',period:'2026-P2',template}});
  assert.equal(out.status,200);assert.equal(out.payload.count,2);assert.equal(searches.length,2);
  assert.match(out.payload.jql,/project = OTHER/);assert.match(out.payload.jql,/resolutionDate < '2026-09-01'/);
  assert.equal(new URL(out.payload.url).searchParams.get('jql'),out.payload.jql);
  assert.equal(db.loadState().settings.piJql,before);
  searches.length=0;await get(svc);assert.ok(searches.length>0,'testing creates no saved report');
});
test('draft test stops paging at 1,000 tickets and says the count is a lower bound', async () => {
  byAssignee['acc-2'] = Array.from({ length: 12 }, (_, p) => Array.from({ length: 100 }, (_, i) => raw('BIG-' + (p * 100 + i), 60, 1)));
  const template = "assignee = '{assignee}' AND resolutionDate >= '{start}' AND resolutionDate <= '{end}'";
  const out = await service().handleRequest({ method: 'POST', path: '/api/pi/test', admin: true, body: { person: 'm2', period: '2026-P2', template } });
  assert.equal(out.status, 200);
  assert.equal(out.payload.count, 1000);
  assert.equal(out.payload.more, true);
  assert.equal(searches.length, 10);
});
test('draft tests reject invalid drafts, viewers and members outside team before JIRA calls',async()=>{
 const svc=service(),body={person:'m1',period:'2026-P2',template:require('../lib/pi-core').DEFAULT_TEMPLATE};
 for(const [opts,status] of [[{admin:false},403],[{team:new Set(['m2'])},404],[{body:{...body,template:'broken ('}},400],[{method:'GET'},405]]){
  const r=await svc.handleRequest({method:'POST',path:'/api/pi/test',admin:true,body,...opts});assert.equal(r.status,status);
 }assert.equal(searches.length,0);
});
test('builder options load paged projects and date fields without exposing credentials',async()=>{
 let page = 0;
 on(/^\/rest\/api\/3\/project\/search/,()=>page++ === 0?{values:[{key:'TOR',name:'TOR - SEMERU',id:'1'}],total:2,isLast:false}:{values:[{key:'QNB',name:'SCRUM - QNB',id:'2'}],total:2,isLast:true});
 on(/^\/rest\/api\/3\/status$/,[{id:'1',name:'DONE',statusCategory:{key:'done'}}]);
 on(/^\/rest\/api\/3\/field$/,[{id:'customfield_10015',name:'Start date',schema:{type:'date'}},{id:'customfield_10020',name:'Story points',schema:{type:'number'}}]);
 const r=await service().handleRequest({method:'GET',path:'/api/pi/options',admin:true});
 assert.equal(r.status,200);assert.equal(r.payload.projects.length,2);assert.ok(r.payload.fields.some(f=>f.value==='cf[10015]'));assert.ok(!r.payload.fields.some(f=>f.value==='cf[10020]'));
 assert.ok(!JSON.stringify(r.payload).includes('secret'));
});
