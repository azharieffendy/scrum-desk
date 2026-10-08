#!/usr/bin/env node
/*
 * Daily Scrum — single local server (used by the Docker image).
 * One process serves everything:
 *   - static UI            (public/)
 *   - auth API             (/api/auth/*)      login/session, DB-backed
 *   - state API            (/api/state)       SQLite persistence
 *   - JIRA proxy           (/api/jira)        avoids CORS, hides credentials
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./lib/db.js');
const core = require('./lib/jira-core.js');
const { handleJira } = require('./lib/jira-handler.js');
const { readJson } = require('./lib/http-utils.js');
const { createKpiService, jiraAccess } = require('./lib/kpi-service.js');
const { createPiService } = require('./lib/pi-service.js');
const { createStatusSync } = require('./lib/status-sync.js');
const { createLiveHub } = require('./lib/live.js');
const scope = require('./lib/team-scope.js');
const passwordPolicy = require('./public/password-policy.js');

const kpiService = createKpiService();
const piService = createPiService();
const statusSync = createStatusSync();
const liveHub = createLiveHub();
db.onChange((change) => liveHub.publish(change));

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const SESSION_COOKIE = 'ds_session';
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/* ---------------- helpers ---------------- */

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i <= 0) return;
    try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
    catch (_) { /* malformed cookie value — ignore */ }
  });
  return out;
}

function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setCookie(req, res, name, value, maxAge) {
  const secure = process.env.COOKIE_SECURE === 'true' || isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure);
}

/* Behind a trusted proxy, the last X-Forwarded-For entry is the address the
 * proxy itself saw; earlier entries are client-supplied and can be forged. */
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    const hops = String(req.headers['x-forwarded-for']).split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* ---------------- login limiter ----------------
 * In-memory, counts failed sign-ins per username from one client IP, and
 * per client IP, over a 10 minute window. A username is never locked for
 * everyone, so someone else's wrong guesses cannot lock its owner out.
 * Expired entries are pruned periodically. */
const LOGIN_WINDOW_MS = 10 * 60000;
const MAX_FAILS_PER_USER = 8;
const MAX_FAILS_PER_IP = 50;
const MAX_SETUP_FAILS_PER_IP = 10;
const loginFailures = new Map();

function failCount(key) {
  const a = loginFailures.get(key);
  return a && a.resetAt > Date.now() ? a.count : 0;
}
function recordFailure(key) {
  const now = Date.now();
  const a = loginFailures.get(key);
  if (!a || a.resetAt <= now) loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else a.count++;
}
const userKey = (username, ip) => 'u:' + ip + '|' + username;
function loginBlocked(username, ip) {
  return failCount(userKey(username, ip)) >= MAX_FAILS_PER_USER || failCount('ip:' + ip) >= MAX_FAILS_PER_IP;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of loginFailures) if (a.resetAt <= now) loginFailures.delete(k);
}, LOGIN_WINDOW_MS).unref();

function validateCreds(u, p) {
  if (!u || String(u).trim().length < 3) return 'Username needs at least 3 characters.';
  if (!/^[\w.\-@ ]+$/.test(String(u).trim())) return 'Username has invalid characters.';
  return passwordPolicy.problem(p);
}

/* ---------------- first-run setup code ----------------
 * Until the first admin exists, anyone who can reach the server could
 * claim it. Creating that admin therefore needs a one-time code that is
 * printed to the server log (or set via the SETUP_CODE env var). */
let setupCode = null;
function currentSetupCode() {
  if (db.countUsers() > 0) { setupCode = null; return null; }
  if (!setupCode) setupCode = process.env.SETUP_CODE || crypto.randomBytes(16).toString('hex');
  return setupCode;
}

/* Background JIRA refresh on sign-in: keeps the sprint snapshot in the
 * database fresh even when only viewers log in. Rate-limited to one run
 * per 5 minutes. Credentials: env vars first, then the signed-in user's
 * own key, then the team's (viewers always use the team's). */
let bgRefreshing = false;
let bgLastRun = 0;
function backgroundJiraRefresh(user) {
  if (bgRefreshing || Date.now() - bgLastRun < 5 * 60000) return;
  const creds = db.credsForUser(user);
  const access = jiraAccess(creds);
  if (!access) return;
  const { site, auth } = access;
  bgRefreshing = true;
  (async () => {
    try {
      const jql = ((db.loadState().settings || {}).jql) || core.DEFAULT_JQL;
      const issues = await core.searchIssues(site, auth, jql);
      const withSprint = issues.find((i) => i.sprint);
      // "today" in the team's timezone (saved by the admin's browser), not the server's
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: db.getTimezone() });
      db.upsertDayJira(today, {
        syncedAt: new Date().toISOString(),
        sprint: withSprint ? withSprint.sprint : null,
        issues,
      });
    } catch (e) {
      console.warn('[jira] background refresh failed: ' + e.message);
    } finally { bgRefreshing = false; bgLastRun = Date.now(); }
    // Status colours at most once a day; a failure is retried on the next run
    await statusSync.syncIfDue(creds).catch((e) => console.warn('[jira] status colour sync failed: ' + e.message));
    // KPI months after the daily sync; it has its own busy flag and 5-minute limit
    kpiService.backgroundRefresh(creds);
  })();
}

/* ---------------- auth routes ---------------- */

function isAdmin(user) { return (user.role || 'admin') === 'admin'; }

const envJira = () => Boolean(process.env.JIRA_SITE && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);

/** The user's own JIRA key status for the browser (never the token); null for viewers. */
function myJira(user) {
  return db.canOwnKey(user) ? Object.assign(db.getUserJira(user.id), { envOverride: envJira() }) : null;
}

async function handleAuth(req, res, url) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  const user = db.getSessionUser(token);

  if (url.pathname === '/api/auth/status') {
    return sendJson(res, 200, {
      authenticated: !!user,
      needsSetup: db.countUsers() === 0,
      user: user ? { name: user.username, role: user.role || 'admin', memberId: user.memberId || '' } : null,
    });
  }

  if (url.pathname === '/api/auth/jira') return handleOwnJira(req, res, user);

  if (url.pathname === '/api/auth/users' && req.method === 'GET') {
    if (!user || !isAdmin(user)) return sendJson(res, 403, { error: 'Admin access required.' });
    return sendJson(res, 200, { users: db.listUsers() });
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only.' });
  const body = await readJson(req);

  if (url.pathname === '/api/auth/setup') {
    const code = currentSetupCode();
    if (!code) return sendJson(res, 403, { error: 'Setup already completed — sign in instead.' });
    const setupKey = 'setup:' + clientIp(req);
    if (failCount(setupKey) >= MAX_SETUP_FAILS_PER_IP) return sendJson(res, 429, { error: 'Too many attempts — wait 10 minutes.' });
    if (!safeEqual(String(body.setupCode || '').trim(), code)) {
      recordFailure(setupKey);
      return sendJson(res, 403, { error: 'Wrong setup code. It is printed in the server log (docker compose logs daily-scrum).' });
    }
    const v = validateCreds(body.username, body.password);
    if (v) return sendJson(res, 400, { error: v });
    const id = db.createUser(String(body.username).trim(), body.password, 'admin');
    setupCode = null;
    const s = db.createSession(id);
    setCookie(req, res, SESSION_COOKIE, s.token, s.maxAge);
    backgroundJiraRefresh({ id, role: 'admin' });
    return sendJson(res, 200, { ok: true, user: { name: String(body.username).trim().toLowerCase(), role: 'admin' } });
  }

  if (url.pathname === '/api/auth/login') {
    const username = String(body.username || '').trim().toLowerCase();
    const ip = clientIp(req);
    if (loginBlocked(username, ip)) return sendJson(res, 429, { error: 'Too many attempts — wait 10 minutes.' });
    const u = db.verifyLogin(username, body.password || '');
    if (!u) {
      recordFailure(userKey(username, ip));
      recordFailure('ip:' + ip);
      return sendJson(res, 401, { error: 'Wrong username or password.' });
    }
    loginFailures.delete(userKey(username, ip));
    const s = db.createSession(u.id);
    setCookie(req, res, SESSION_COOKIE, s.token, s.maxAge);
    backgroundJiraRefresh(u);
    return sendJson(res, 200, { ok: true, user: { name: u.username, role: u.role || 'admin', memberId: u.memberId || '' } });
  }

  if (url.pathname === '/api/auth/logout') {
    db.deleteSession(token);
    setCookie(req, res, SESSION_COOKIE, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/auth/password') {
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const next = String(body.next || '');
    const weak = passwordPolicy.problem(next);
    if (weak) return sendJson(res, 400, { error: weak });
    if (!db.changePassword(user.id, body.current || '', next, token)) {
      return sendJson(res, 400, { error: 'Current password is wrong.' });
    }
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/auth/member') {
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const memberId = String(body.memberId || '');
    const members = db.loadState().members;
    if (memberId && !members.some((m) => m.id === memberId)) {
      return sendJson(res, 400, { error: 'No such team member.' });
    }
    // a Technical Lead may only link a member of their own team, or linking would widen it
    if (memberId && scope.isLead(user) && !scope.scopedMemberIds(members, user).has(memberId)) {
      return sendJson(res, 403, { error: 'That member is not on your team.' });
    }
    db.setUserMember(user.id, memberId);
    return sendJson(res, 200, { ok: true, memberId });
  }

  if (url.pathname.startsWith('/api/auth/users')) {
    if (!user || !isAdmin(user)) return sendJson(res, 403, { error: 'Admin access required.' });
    return handleUserAdmin(res, url, body, user);
  }

  return sendJson(res, 404, { error: 'Unknown auth route.' });
}

/**
 * An admin's or Technical Lead's own JIRA key. GET → status, PUT → save
 * { email, token? } (no token keeps the saved one; empty email clears both),
 * POST → test the key in use.
 */
async function handleOwnJira(req, res, user) {
  if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
  if (!db.canOwnKey(user)) return sendJson(res, 403, { error: 'Only admins and Technical Leads use their own JIRA key.' });
  if (req.method === 'GET') return sendJson(res, 200, myJira(user));
  if (req.method === 'PUT') {
    const body = await readJson(req);
    try {
      db.setUserJira(user.id, { email: body.email, token: body.token });
    } catch (e) {
      if (e.status) return sendJson(res, e.status, { error: e.message });
      throw e;
    }
    return sendJson(res, 200, myJira(user));
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET, PUT or POST only.' });
  const access = jiraAccess(db.credsForUser(user));
  if (!access) return sendJson(res, 400, { error: 'JIRA is not configured — an admin must set the site first.' });
  try {
    const me = await core.jiraFetch(access.site, access.auth, '/rest/api/3/myself');
    return sendJson(res, 200, { ok: true, user: { name: me.displayName || '(unknown)', email: me.emailAddress || null } });
  } catch (e) {
    return sendJson(res, 502, { error: 'JIRA: ' + e.message });
  }
}

/* admin-only user management (POST) */
function handleUserAdmin(res, url, body, user) {
  if (url.pathname === '/api/auth/users') {
    const v = validateCreds(body.username, body.password);
    if (v) return sendJson(res, 400, { error: v });
    const role = db.USER_ROLES.includes(body.role) ? body.role : 'viewer';
    try {
      const id = db.createUser(String(body.username).trim(), body.password, role);
      return sendJson(res, 200, { ok: true, id, user: { name: String(body.username).trim().toLowerCase(), role } });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) return sendJson(res, 409, { error: 'That username already exists.' });
      throw e;
    }
  }

  const target = db.listUsers().find((u) => u.id === Number(body.id));

  if (url.pathname === '/api/auth/users/delete') {
    if (!target) return sendJson(res, 404, { error: 'User not found.' });
    if (target.id === user.id) return sendJson(res, 400, { error: 'You cannot delete your own account.' });
    if (target.role === 'admin' && db.countAdmins() <= 1) return sendJson(res, 400, { error: 'Cannot delete the last admin.' });
    db.deleteUser(target.id);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/auth/users/reset') {
    if (!target) return sendJson(res, 404, { error: 'User not found.' });
    const weak = passwordPolicy.problem(body.newPassword);
    if (weak) return sendJson(res, 400, { error: weak });
    db.resetPassword(target.id, body.newPassword);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Unknown auth route.' });
}

/* ---------------- state & jira routes (session required) ---------------- */

function requireSession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = db.getSessionUser(token);
  if (!user) { sendJson(res, 401, { error: 'Not signed in.' }); return null; }
  return user;
}

async function handleState(req, res, user) {
  const lead = scope.isLead(user);
  if (req.method === 'GET') {
    const st = db.loadState();
    return sendJson(res, 200, {
      // a Technical Lead only sees their own team
      state: lead ? scope.scopeState(st, user) : st,
      version: db.getStateVersion(),
      loadedAt: new Date().toISOString(),
      // viewers and leads never see JIRA settings; admins never see the API token itself
      creds: isAdmin(user) ? db.getPublicCreds() : null,
      statusColors: db.getStatusColors(),
      leads: lead ? [] : db.listLeads(),
      myJira: myJira(user),
    });
  }
  if (req.method === 'PUT') {
    if (!isAdmin(user) && !lead) return sendJson(res, 403, { error: 'Your account is view-only.' });
    const body = await readJson(req, 8 * 1024 * 1024);
    if (lead && !body.patch) return sendJson(res, 403, { error: 'Only admins can replace the whole board.' });
    // loading and saving run synchronously, so nothing can change the board in between
    const version = lead ? db.savePatch(scope.widenPatch(db.loadState(), body, user))
      : body.patch ? db.savePatch(body) : db.saveAll(body);
    // No new loadedAt here: the client has not seen JIRA snapshots written by
    // background refreshes, so its GET time must keep guarding them.
    return sendJson(res, 200, { ok: true, version });
  }
  return sendJson(res, 405, { error: 'GET or PUT only.' });
}

async function handleJiraRoute(req, res, user) {
  const lead = scope.isLead(user);
  if (!isAdmin(user) && !lead) return sendJson(res, 403, { error: 'Your account is view-only.' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only.' });
  const body = await readJson(req);
  if (!lead) {
    return handleJira(
      { body, headers: req.headers, extraCreds: db.credsForUser(user) },
      (code, payload) => sendJson(res, code, payload)
    );
  }
  if (body.action) return sendJson(res, 403, { error: 'Only admins can change the JIRA connection.' });
  return leadJiraSync(req, res, user);
}

/**
 * A Technical Lead's sync: the server queries JIRA with the team's saved
 * query and credentials, stores the full snapshot itself (a lead's own
 * saves never carry JIRA data) and answers with the lead's tickets only.
 */
async function leadJiraSync(req, res, user) {
  const st = db.loadState();
  // always "today" in the team timezone: a client-sent date could overwrite another day's shared snapshot
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: db.getTimezone() });
  return handleJira(
    { body: { jql: st.settings.jql || undefined }, headers: req.headers, extraCreds: db.credsForUser(user) },
    (code, payload) => {
      if (code !== 200) return sendJson(res, code, payload);
      db.upsertDayJira(date, { syncedAt: payload.syncedAt, sprint: payload.sprint, issues: payload.issues });
      const ids = scope.scopedMemberIds(st.members, user);
      const issues = scope.scopeIssues(payload.issues, ids, st.members, st.mapping);
      return sendJson(res, 200, { ok: true, sprint: payload.sprint, syncedAt: payload.syncedAt, issueCount: issues.length, issues });
    }
  );
}

async function handleKpiRoute(req, res, user, url) {
  const lead = scope.isLead(user);
  if (lead && url.pathname === '/api/kpi/fields') return sendJson(res, 403, { error: 'Only admins can change KPI settings.' });
  const body = req.method === 'POST' ? await readJson(req) : null;
  const out = await kpiService.handleRequest({
    method: req.method, path: url.pathname, month: url.searchParams.get('month'), body, admin: isAdmin(user) || lead,
    team: lead ? scope.scopedMemberIds(db.loadState().members, user) : null,
    creds: db.credsForUser(user),
  });
  if (lead && out.status === 200 && Array.isArray(out.payload.tasks)) {
    const st = db.loadState();
    const ids = scope.scopedMemberIds(st.members, user);
    out.payload = scope.scopeKpiReport(out.payload, ids, st.members, st.mapping);
  }
  return sendJson(res, out.status, out.payload);
}

async function handlePiRoute(req, res, user, url) {
  const lead = scope.isLead(user);
  if (lead && ['/api/pi/test', '/api/pi/options'].includes(url.pathname)) return sendJson(res, 403, { error: 'Only admins can edit report queries.' });
  const body = req.method === 'POST' ? await readJson(req) : null;
  const out = await piService.handleRequest({
    method: req.method, path: url.pathname, period: url.searchParams.get('period'),
    person: url.searchParams.get('person') || '', body,
    admin: isAdmin(user) || lead, memberId: user.memberId || '',
    team: lead ? scope.scopedMemberIds(db.loadState().members, user) : null,
    creds: db.credsForUser(user),
  });
  return sendJson(res, out.status, out.payload);
}

async function handleStatusColorsRoute(req, res, user) {
  const body = req.method === 'PUT' ? await readJson(req) : null;
  const out = await statusSync.handleRequest({ method: req.method, body, admin: isAdmin(user), creds: db.credsForUser(user) });
  return sendJson(res, out.status, out.payload);
}

/* ---------------- static files ---------------- */

function serveStatic(res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch (_) { res.statusCode = 400; return res.end('Bad request'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  });
}

/* ---------------- server ---------------- */

/** Browser writes must come from this origin, including another port on the same host. */
function trustedWriteOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients can omit Origin
  try {
    return new URL(origin).origin === new URL('http://' + req.headers.host).origin ||
      new URL(origin).origin === new URL('https://' + req.headers.host).origin;
  } catch (_) { return false; }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url);
  if (!trustedWriteOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin write refused.' });
  if (url.pathname.startsWith('/api/auth/')) return handleAuth(req, res, url);

  const user = requireSession(req, res);
  if (!user) return;
  if (url.pathname === '/api/state') return handleState(req, res, user);
  if (url.pathname === '/api/jira') return handleJiraRoute(req, res, user);
  if (['/api/kpi', '/api/kpi/refresh', '/api/kpi/fields', '/api/kpi/trend'].includes(url.pathname)) return handleKpiRoute(req, res, user, url);
  if (['/api/pi', '/api/pi/preview', '/api/pi/test', '/api/pi/options'].includes(url.pathname)) return handlePiRoute(req, res, user, url);
  if (url.pathname === '/api/status-colors') return handleStatusColorsRoute(req, res, user);
  if (url.pathname === '/api/events') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
    return liveHub.subscribe(req, res, db.getStateVersion());
  }
  return sendJson(res, 404, { error: 'Unknown API route.' });
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // inline style="" for member colours
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    await route(req, res);
  } catch (e) {
    if (e.status && e.status < 500) {
      if (e.status === 413) res.setHeader('Connection', 'close');
      return sendJson(res, e.status, { error: e.message });
    }
    console.error('[server] ' + req.method + ' ' + req.url + ':', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
  }
});

db.purgeExpiredSessions();
kpiService.recomputeStale();
setInterval(db.purgeExpiredSessions, 60 * 60000).unref();

server.listen(PORT, () => {
  console.log('');
  console.log('  Daily Scrum is running');
  console.log('  ->  http://localhost:' + PORT);
  console.log('  Database: ' + path.join(db.DATA_DIR, 'daily-scrum.db'));
  const code = currentSetupCode();
  if (code) {
    console.log('');
    console.log('  First-time setup code: ' + code);
    console.log('  (enter it on the "Create your account" screen)');
  }
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

module.exports = server;
