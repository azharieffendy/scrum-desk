/*
 * JIRA fetching for the KPI report: JQL issue search (sprint discovery by
 * member, sprint issues with changelogs), status categories, and sprint /
 * story-point field detection.
 * All calls go through jiraFetch (timeout, error mapping) and withRetry
 * (HTTP 429). Calls are sequential to stay under JIRA rate limits.
 */
'use strict';

const core = require('./jira-core');
const kpi = require('./kpi-core');

const RETRIES = 3;
const DEFAULT_WAIT_S = 5;
const MAX_WAIT_S = 30;
const ISSUE_FIELDS = ['summary', 'status', 'assignee', 'issuetype', 'created', 'updated', 'sprint', 'closedSprints'];
const FIELD_ID = /^[\w.-]{1,64}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs fn, waiting and retrying on HTTP 429 (Retry-After, default 5 s, max 30 s, 3 retries). */
async function withRetry(fn, opts = {}) {
  const wait = opts.wait || sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!e || e.status !== 429 || attempt >= RETRIES) throw e;
      await wait(Math.min(e.retryAfter || DEFAULT_WAIT_S, MAX_WAIT_S) * 1000);
    }
  }
}

const SPRINT_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint';

const get = (site, auth, path, opts) => withRetry(() => core.jiraFetch(site, auth, path), opts);
const post = (site, auth, path, body, opts) =>
  withRetry(() => core.jiraFetch(site, auth, path, { method: 'POST', body }), opts);

/** The site's Sprint custom field ID, or '' when it has none. */
async function sprintFieldId(site, auth, opts = {}) {
  const fields = (await get(site, auth, '/rest/api/3/field', opts)) || [];
  const field = fields.find((f) => f && f.schema && f.schema.custom === SPRINT_FIELD_TYPE);
  return field && FIELD_ID.test(field.id) ? field.id : '';
}

/**
 * Every issue a JQL search matches (paged by nextPageToken); opts.changelog expands the changelog.
 * opts.limit stops after that many issues (the result then has more = true).
 */
async function searchIssues(site, auth, jql, fields, opts = {}) {
  const out = [];
  for (let pageToken; ; ) {
    const body = { jql, maxResults: 100, fields };
    if (opts.changelog) body.expand = 'changelog';
    if (pageToken) body.nextPageToken = pageToken;
    const data = (await post(site, auth, '/rest/api/3/search/jql', body, opts)) || {};
    out.push(...(data.issues || []));
    if (data.isLast || !data.nextPageToken) break;
    if (opts.limit && out.length >= opts.limit) { out.more = true; break; }
    pageToken = data.nextPageToken;
  }
  return out;
}

/** Every sprint (any board, normalized) the JQL's issues are or were in. */
async function sprintsOfIssues(site, auth, jql, sprintField, opts = {}) {
  const byId = new Map();
  for (const issue of await searchIssues(site, auth, jql, [sprintField], opts)) {
    for (const s of [].concat((issue.fields || {})[sprintField] || [])) {
      if (s && s.id && !byId.has(s.id)) byId.set(s.id, kpi.normalizeSprint(s));
    }
  }
  return [...byId.values()];
}

/** Status ID → category key ('new' | 'indeterminate' | 'done'). */
async function statusCategories(site, auth, opts = {}) {
  const list = (await get(site, auth, '/rest/api/3/status', opts)) || [];
  const map = {};
  for (const s of list) if (s && s.id) map[String(s.id)] = (s.statusCategory && s.statusCategory.key) || '';
  return map;
}

/** Every status of the site: [{ id, name, category }] (category '' when JIRA gives none). */
async function listStatuses(site, auth, opts = {}) {
  const list = (await get(site, auth, '/rest/api/3/status', opts)) || [];
  return list.filter((s) => s && s.id).map((s) => ({
    id: String(s.id), name: String(s.name || ''), category: (s.statusCategory && s.statusCategory.key) || '',
  }));
}

/** Fields whose name looks like story points: [{ id, name }]. */
async function storyPointFields(site, auth, opts = {}) {
  const list = (await get(site, auth, '/rest/api/3/field', opts)) || [];
  return list.filter((f) => f && /story ?points?/i.test(f.name || '')).map((f) => ({ id: f.id, name: f.name }));
}

/** Every changelog history of an issue (used when the inline one is truncated). */
async function fullChangelog(site, auth, key, opts = {}) {
  const out = [];
  for (let startAt = 0; ; ) {
    const data = await get(site, auth, '/rest/api/3/issue/' + encodeURIComponent(key) +
      '/changelog?maxResults=100&startAt=' + startAt, opts);
    const values = (data && data.values) || [];
    out.push(...values);
    startAt += values.length;
    if (!values.length || data.isLast !== false) break;
  }
  return out;
}

/**
 * Timelines of the issues a JQL search matches, changelog expanded.
 * opts.sprintField: the site's Sprint field, read as the issue's sprints
 * (search does not return the agile "sprint"/"closedSprints" fields).
 * opts.cached (Map key → stored timeline): an issue whose `updated` is
 * unchanged reuses its stored timeline, so its truncated changelog is not
 * paged again.
 */
async function searchTimelines(site, auth, jql, opts = {}) {
  const extra = [opts.pointsField, opts.sprintField].filter((id) => FIELD_ID.test(id || ''));
  const raw = await searchIssues(site, auth, jql, ISSUE_FIELDS.concat(extra), Object.assign({}, opts, { changelog: true }));
  const issues = opts.sprintField
    ? raw.map((i) => Object.assign({}, i, { fields: Object.assign({}, i.fields, { sprint: (i.fields || {})[opts.sprintField] || [] }) }))
    : raw;
  return toTimelines(site, auth, issues, opts);
}

async function toTimelines(site, auth, issues, opts) {
  const cached = opts.cached || new Map();
  const out = [];
  for (const issue of issues) {
    const f = issue.fields || {};
    const stored = cached.get(issue.key);
    if (stored && stored.updated && stored.updated === kpi.parseTime(f.updated)) { out.push(stored); continue; }
    const cl = issue.changelog || {};
    const histories = cl.histories || [];
    const full = (cl.total || 0) > histories.length
      ? Object.assign({}, issue, { changelog: Object.assign({}, cl, { histories: await fullChangelog(site, auth, issue.key, opts) }) })
      : issue;
    out.push(kpi.toTimeline(full, opts.pointsField));
  }
  return out;
}

module.exports = {
  withRetry, statusCategories, listStatuses, storyPointFields,
  sprintFieldId, searchIssues, sprintsOfIssues, fullChangelog, searchTimelines,
};
