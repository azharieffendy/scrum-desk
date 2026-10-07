/*
 * Vercel Serverless Function: POST /api/jira
 * Thin wrapper around lib/jira-handler.js for serverless deployments
 * (credentials from env vars or the request body; no database there).
 * The local Docker server uses lib/jira-handler.js directly.
 */
'use strict';

const { handleJira } = require('../lib/jira-handler.js');
const { readJson } = require('../lib/http-utils.js');

module.exports = async (req, res) => {
  const send = (code, payload) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
  };

  if (req.method !== 'POST') {
    return send(405, { error: 'POST only. Send JSON: { "action": "test" | "search", "jql": "..." }' });
  }
  let body;
  try { body = await readJson(req); }
  catch (e) { return send(e.status || 400, { error: e.message }); }

  // No login exists on serverless deployments, so this endpoint is public.
  return handleJira({ body, headers: req.headers, isPublic: true }, send);
};
