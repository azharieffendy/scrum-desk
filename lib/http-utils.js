/*
 * Small HTTP helpers shared by the local server (server.js) and the
 * Vercel function (api/jira.js).
 */
'use strict';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — a full board export is far smaller

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Reads the request body. Oversized bodies are drained without buffering,
 * then rejected with 413 so clients can reliably receive the response.
 * Node's requestTimeout bounds the drain.
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let oversized = Number(req.headers && req.headers['content-length']) > limit;
    req.on('data', (c) => {
      if (done) return;
      if (oversized) return;
      size += c.length;
      if (size > limit) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (oversized) reject(httpError(413, 'Request body too large.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => { if (!done) { done = true; reject(httpError(400, 'Could not read request body: ' + e.message)); } });
  });
}

/** Reads and parses a JSON body. Empty body → {}. Rejects with 400 / 413. */
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (_) { throw httpError(400, 'Invalid JSON body.'); }
}

module.exports = { MAX_BODY_BYTES, httpError, readBody, readJson };
