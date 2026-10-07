/*
 * Shared JIRA Cloud helpers. Zero dependencies, Node 18+ (global fetch).
 * Used by both the Vercel serverless function (api/jira.js) and the
 * local server (server.js).
 */
'use strict';

const SEARCH_FIELDS = ['summary', 'status', 'assignee', 'sprint', 'issuetype', 'priority', 'updated'];
const DEFAULT_JQL = 'sprint in openSprints() ORDER BY assignee';

const JIRA_CLOUD_HOST = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.atlassian\.net$/;

/**
 * Accepts "team", "team.atlassian.net" or a full URL; returns https://team.atlassian.net.
 * Only JIRA Cloud hosts are allowed, so the proxy cannot be pointed at
 * arbitrary (e.g. internal) servers. Returns '' for anything else.
 */
function normalizeSite(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let host;
  try { host = new URL(s).hostname.toLowerCase(); } catch (_) { return ''; }
  if (!host.includes('.')) host += '.atlassian.net';
  return JIRA_CLOUD_HOST.test(host) ? 'https://' + host : '';
}

function authHeader(email, token) {
  const raw = email + ':' + token;
  if (typeof Buffer !== 'undefined' && Buffer.from) {
    return 'Basic ' + Buffer.from(raw).toString('base64');
  }
  throw new Error('Unable to encode credentials on this runtime.');
}

async function jiraFetch(site, auth, path, options = {}) {
  let res;
  try {
    res = await fetch(site + path, {
      method: options.method || 'GET',
      headers: Object.assign(
        { Authorization: auth, Accept: 'application/json' },
        options.body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? 'timed out' : e.message;
    throw new Error('Could not reach ' + site + ' (' + why + '). Check the site URL and your connection.');
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }

  if (!res.ok) {
    let msg = (data && ((data.errorMessages && data.errorMessages.join('; ')) || data.message || data.error)) ||
      (res.status + ' ' + res.statusText);
    if (res.status === 401 || res.status === 403) {
      msg = 'JIRA rejected the credentials (HTTP ' + res.status + '). Check the login email and API token.';
    } else if (res.status === 404) {
      msg = 'Not found (HTTP 404) — double-check the site URL (' + site + ').';
    } else if (res.status === 429) {
      msg = 'JIRA rate limit reached (HTTP 429). Try again in a minute.';
    }
    const err = new Error(msg);
    err.status = res.status;
    if (res.status === 429) {
      const wait = Number(res.headers && res.headers.get('retry-after'));
      err.retryAfter = Number.isFinite(wait) && wait > 0 ? wait : null;
    }
    throw err;
  }
  return data;
}

function normalizeIssue(issue, site) {
  const f = issue.fields || {};
  const st = f.status || {};
  const cat = st.statusCategory || {};
  const a = f.assignee || null;
  const sp = f.sprint || null;
  return {
    key: issue.key,
    summary: f.summary || '(no summary)',
    status: st.name || '',
    statusCategory: cat.key || '',
    assignee: a ? {
      accountId: a.accountId || null,
      name: a.displayName || a.name || null,
      email: a.emailAddress || null,
    } : null,
    sprint: sp ? {
      id: sp.id,
      name: sp.name,
      state: sp.state || null,
      start: sp.startDate || null,
      end: sp.endDate || null,
    } : null,
    type: f.issuetype ? f.issuetype.name : '',
    priority: f.priority ? f.priority.name : '',
    url: site + '/browse/' + issue.key,
  };
}

/**
 * Runs a JQL search and returns all issues (handles pagination).
 * Tries the modern /search/jql endpoint first, falls back to the
 * legacy /search endpoint (older sites / during Atlassian migration).
 */
async function searchIssues(site, auth, jql) {
  const issues = [];
  let modernWorked = true;

  try {
    let pageToken;
    for (;;) {
      const body = { jql, maxResults: 100, fields: SEARCH_FIELDS };
      if (pageToken) body.nextPageToken = pageToken;
      const data = await jiraFetch(site, auth, '/rest/api/3/search/jql', { method: 'POST', body });
      (data.issues || []).forEach((i) => issues.push(normalizeIssue(i, site)));
      if (data.isLast || !data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
  } catch (e) {
    if (e.status === 404 || e.status === 410 || e.status === 405) modernWorked = false;
    else throw e;
  }

  if (!modernWorked) {
    issues.length = 0;
    for (let startAt = 0; ; startAt += 100) {
      const path = '/rest/api/3/search?jql=' + encodeURIComponent(jql) +
        '&fields=' + encodeURIComponent(SEARCH_FIELDS.join(',')) +
        '&maxResults=100&startAt=' + startAt;
      const data = await jiraFetch(site, auth, path);
      (data.issues || []).forEach((i) => issues.push(normalizeIssue(i, site)));
      if (!data.issues || data.issues.length < 100 || issues.length >= (data.total || 0)) break;
    }
  }

  return issues;
}

module.exports = { normalizeSite, authHeader, jiraFetch, searchIssues, DEFAULT_JQL };
