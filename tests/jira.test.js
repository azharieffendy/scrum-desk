/*
 * Unit tests for the JIRA helpers and the public (Vercel) proxy. Run: npm test
 */
'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSite } = require('../lib/jira-core.js');
const { handleJira } = require('../lib/jira-handler.js');

const ENV_KEYS = ['JIRA_SITE', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'APP_ACCESS_CODE'];
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

function run(ctx) {
  return new Promise((resolve) => handleJira(ctx, (code, payload) => resolve({ code, payload })));
}

test('normalizeSite accepts JIRA Cloud forms', () => {
  assert.equal(normalizeSite('team'), 'https://team.atlassian.net');
  assert.equal(normalizeSite('Team.Atlassian.net/'), 'https://team.atlassian.net');
  assert.equal(normalizeSite('https://team.atlassian.net/jira/software'), 'https://team.atlassian.net');
});

test('normalizeSite rejects other hosts', () => {
  for (const bad of ['evil.com', 'http://169.254.169.254', 'team.atlassian.net.evil.com',
    'https://evil.com/.atlassian.net', 'a@evil.com', '']) {
    assert.equal(normalizeSite(bad), '', bad);
  }
});

test('public proxy refuses env credentials without APP_ACCESS_CODE', async () => {
  Object.assign(process.env, { JIRA_SITE: 'team', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' });
  const r = await run({ body: { action: 'test' }, headers: {}, isPublic: true });
  assert.equal(r.code, 503);
});

test('access code is enforced when set', async () => {
  process.env.APP_ACCESS_CODE = 'letmein';
  const r = await run({ body: { action: 'test' }, headers: { 'x-access-code': 'wrong' }, isPublic: true });
  assert.equal(r.code, 401);
});
