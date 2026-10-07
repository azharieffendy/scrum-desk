/*
 * Live updates: GET /api/events is a Server-Sent Events stream that tells
 * every open board when the saved data changed. Events carry only a version
 * number and a reason, never board data — clients re-read /api/state, so
 * the usual session check guards the content.
 */
'use strict';

const KEEPALIVE_MS = 25000;
const MAX_CLIENTS = 200;

function createLiveHub({ keepaliveMs = KEEPALIVE_MS, maxClients = MAX_CLIENTS } = {}) {
  const clients = new Set();
  let timer = null;

  function write(res, text) {
    try { res.write(text); } catch (_) { clients.delete(res); }
  }

  function startKeepalive() {
    if (timer) return;
    timer = setInterval(() => { for (const res of clients) write(res, ': ping\n\n'); }, keepaliveMs);
    timer.unref();
  }

  function stopKeepaliveIfIdle() {
    if (clients.size || !timer) return;
    clearInterval(timer);
    timer = null;
  }

  /** Attach a request as a subscriber; returns false when the hub is full (503 sent). */
  function subscribe(req, res, version) {
    if (clients.size >= maxClients) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      res.end(JSON.stringify({ error: 'Too many live connections.' }));
      return false;
    }
    if (req.socket) req.socket.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    write(res, 'retry: 3000\n\n');
    write(res, 'data: ' + JSON.stringify({ version, reason: 'hello' }) + '\n\n');
    clients.add(res);
    startKeepalive();
    const drop = () => { clients.delete(res); stopKeepaliveIfIdle(); };
    req.on('close', drop);
    res.on('error', drop);
    return true;
  }

  /** Tell every subscriber that the board changed. reason: 'save' | 'jira' | 'colors'. */
  function publish(change) {
    const text = 'data: ' + JSON.stringify({ version: change.version, reason: change.reason }) + '\n\n';
    for (const res of clients) write(res, text);
  }

  function close() {
    for (const res of clients) { try { res.end(); } catch (_) { /* already closed */ } }
    clients.clear();
    stopKeepaliveIfIdle();
  }

  return { subscribe, publish, close, size: () => clients.size };
}

module.exports = { createLiveHub };
