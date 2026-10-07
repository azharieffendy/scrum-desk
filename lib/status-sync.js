/*
 * Status colours: a daily sync of the site's statuses into the saved
 * colour map, and PUT /api/status-colors for admin overrides.
 */
'use strict';

const db = require('./db.js');
const jk = require('./jira-kpi.js');
const { jiraAccess } = require('./kpi-service.js');
const { httpError } = require('./http-utils.js');
const { assignColors, cleanColorMap } = require('../public/status-colors.js');

const SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

function createStatusSync(options = {}) {
  const now = options.now || Date.now;
  const wait = options.wait;

  /** Fetches statuses and adds colours for new ones; existing slots never move. */
  async function sync(access) {
    let statuses;
    try {
      statuses = await jk.listStatuses(access.site, access.auth, { wait });
    } catch (e) {
      throw httpError(502, 'JIRA: ' + e.message);
    }
    const saved = db.getStatusColors();
    const next = assignColors(statuses, saved);
    const changed = JSON.stringify(next) !== JSON.stringify(saved);
    if (changed) db.setStatusColors(next);
    db.setStatusColorsSyncedAt(new Date(now()).toISOString());
    return { changed };
  }

  /** At most once a day; a failure leaves the sync due so the next run retries. */
  async function syncIfDue(creds) {
    const access = jiraAccess(creds);
    const last = Date.parse(db.getStatusColorsSyncedAt()) || 0;
    if (!access || now() - last < SYNC_EVERY_MS) return { skipped: true };
    return sync(access);
  }

  /** Strict: every entry must be valid, or nothing is saved. */
  function parseColors(colors) {
    const clean = cleanColorMap(colors);
    const count = colors && typeof colors === 'object' && !Array.isArray(colors) ? Object.keys(colors).length : -1;
    if (count !== Object.keys(clean).length) {
      throw httpError(400, 'Colours must map status names to slots 0–23.');
    }
    return clean;
  }

  /** { method, body, admin, creds } → { status, payload } */
  async function handleRequest(req) {
    try {
      if (req.method !== 'PUT') return { status: 405, payload: { error: 'PUT only.' } };
      if (!req.admin) return { status: 403, payload: { error: 'Only admins can change status colours.' } };
      const body = req.body || {};
      if (body.reset === true) {
        db.setStatusColors({});
        db.setStatusColorsSyncedAt('');
        const access = jiraAccess(req.creds);
        if (access) await sync(access);
      } else {
        // Merge: only the changed entries are sent, so a stale page can't drop statuses synced since.
        db.setStatusColors(Object.assign(db.getStatusColors(), parseColors(body.colors)));
      }
      return { status: 200, payload: { statusColors: db.getStatusColors() } };
    } catch (e) {
      if (e.status && e.status < 600) return { status: e.status, payload: { error: e.message } };
      throw e;
    }
  }

  return { syncIfDue, handleRequest };
}

module.exports = { createStatusSync };
