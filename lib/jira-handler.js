/*
 * Shared JIRA proxy handler — used by:
 *   - the local/Docker server (server.js, with DB credentials)
 *   - the Vercel serverless function (api/jira.js, env/request credentials)
 *
 * Credential priority: environment  >  request body  >  database.
 */
'use strict';

const crypto = require('crypto');
const core = require('./jira-core.js');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * ctx.isPublic — true when the endpoint has no login in front of it
 * (Vercel). Server-side env credentials are then only usable behind
 * APP_ACCESS_CODE, otherwise anyone could query JIRA as that account.
 */
async function handleJira(ctx, send) {
  const body = ctx.body || {};
  const headers = ctx.headers || {};
  const hasEnvCreds = Boolean(process.env.JIRA_SITE && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);

  if (process.env.APP_ACCESS_CODE && !safeEqual(headers['x-access-code'] || '', process.env.APP_ACCESS_CODE)) {
    return send(401, { error: 'Invalid access code. Set the matching code in Settings.' });
  }
  if (ctx.isPublic && hasEnvCreds && !process.env.APP_ACCESS_CODE) {
    return send(503, {
      error: 'Server JIRA credentials are configured but APP_ACCESS_CODE is not set. ' +
        'Set APP_ACCESS_CODE on the server so the proxy is not open to everyone.',
    });
  }

  let site, email, token, authSource;
  if (hasEnvCreds) {
    site = process.env.JIRA_SITE; email = process.env.JIRA_EMAIL; token = process.env.JIRA_API_TOKEN;
    authSource = 'env';
  } else if (body.site && body.email && body.token) {
    site = body.site; email = body.email; token = body.token;
    authSource = 'request';
  } else {
    const ex = ctx.extraCreds || {};
    if (ex.site && ex.email && ex.token) {
      site = ex.site; email = ex.email; token = ex.token;
      authSource = 'database';
    } else {
      return send(400, {
        error: 'Missing JIRA credentials. Fill in Site / Email / API token in Settings, or set JIRA_SITE / JIRA_EMAIL / JIRA_API_TOKEN on the server.',
        authSource: 'none',
      });
    }
  }

  site = core.normalizeSite(site);
  if (!site) return send(400, { error: 'Invalid JIRA site — only JIRA Cloud sites (*.atlassian.net) are supported.', authSource });

  try {
    const auth = core.authHeader(email, token);

    if (body.action === 'test') {
      const me = await core.jiraFetch(site, auth, '/rest/api/3/myself');
      return send(200, {
        ok: true, site, authSource,
        user: { name: me.displayName || me.name || '(unknown)', email: me.emailAddress || null },
      });
    }

    const jql = (body.jql && String(body.jql).trim()) || core.DEFAULT_JQL;
    const issues = await core.searchIssues(site, auth, jql);
    const withSprint = issues.find((i) => i.sprint);
    return send(200, {
      ok: true, site, authSource, jql,
      sprint: withSprint ? withSprint.sprint : null,
      issueCount: issues.length,
      syncedAt: new Date().toISOString(),
      issues,
    });
  } catch (e) {
    const s = e.status || 0;
    const code = (s === 400 || s === 401 || s === 403) ? 400 : (s ? 502 : 500);
    return send(code, { error: e.message || 'Unexpected server error.' });
  }
}

module.exports = { handleJira };
