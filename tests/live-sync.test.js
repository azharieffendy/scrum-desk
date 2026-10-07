'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { merge3 } = require('../public/live-sync.js');
const { createLiveHub } = require('../lib/live.js');

test('merge3 takes their change when this tab did not touch the value', () => {
  assert.deepEqual(merge3({ a: 1 }, { a: 1 }, { a: 2 }), { a: 2 });
});

test('merge3 keeps an unsaved local change the server does not have', () => {
  assert.deepEqual(merge3({ a: 1 }, { a: 5 }, { a: 1 }), { a: 5 });
});

test('merge3 combines different fields changed on each side', () => {
  const base = { entries: { m1: { today: '' }, m2: { today: '' } } };
  const mine = { entries: { m1: { today: 'mine' }, m2: { today: '' } } };
  const theirs = { entries: { m1: { today: '' }, m2: { today: 'theirs' } } };
  assert.deepEqual(merge3(base, mine, theirs), { entries: { m1: { today: 'mine' }, m2: { today: 'theirs' } } });
});

test('merge3 keeps mine when both sides changed the same text', () => {
  assert.deepEqual(merge3({ t: 'a' }, { t: 'mine' }, { t: 'theirs' }), { t: 'mine' });
});

test('merge3 drops a key deleted on the other side and keeps one added here', () => {
  assert.deepEqual(merge3({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 }, { a: 1 }), { a: 1, c: 3 });
});

test('merge3 merges a day both tabs created from empty', () => {
  const mine = { startedAt: 'x', entries: { m1: { today: 'mine' } } };
  const theirs = { startedAt: 'y', entries: { m2: { today: 'theirs' } } };
  assert.deepEqual(merge3(undefined, mine, theirs),
    { startedAt: 'x', entries: { m1: { today: 'mine' }, m2: { today: 'theirs' } } });
});

test('merge3 merges team lists by id: both additions survive, edits combine', () => {
  const base = [{ id: 'a', name: 'A', role: '' }];
  const mine = [{ id: 'a', name: 'A', role: 'Dev' }, { id: 'b', name: 'B' }];
  const theirs = [{ id: 'a', name: 'Anna', role: '' }, { id: 'c', name: 'C' }];
  assert.deepEqual(merge3(base, mine, theirs), [
    { id: 'a', name: 'Anna', role: 'Dev' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
  ]);
});

test('merge3 removes a member the other side deleted', () => {
  const base = [{ id: 'a' }, { id: 'b' }];
  const mine = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const theirs = [{ id: 'a' }];
  assert.deepEqual(merge3(base, mine, theirs), [{ id: 'a' }, { id: 'c' }]);
});

test('merge3 does not modify its inputs', () => {
  const base = { a: { x: 1 } }, mine = { a: { x: 1 } }, theirs = { a: { x: 2 } };
  const out = merge3(base, mine, theirs);
  out.a.x = 9;
  assert.equal(theirs.a.x, 2);
});

function fakeClient() {
  const req = new EventEmitter();
  req.socket = { setTimeout: () => {} };
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (text) => { res.chunks.push(text); return true; };
  res.end = (text) => { if (text) res.chunks.push(text); res.ended = true; };
  return { req, res };
}

test('live hub sends a hello, then every published change, as SSE', () => {
  const hub = createLiveHub();
  const { req, res } = fakeClient();
  assert.equal(hub.subscribe(req, res, 4), true);
  hub.publish({ version: 5, reason: 'save' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  const text = res.chunks.join('');
  assert.match(text, /data: \{"version":4,"reason":"hello"\}\n\n/);
  assert.match(text, /data: \{"version":5,"reason":"save"\}\n\n/);
  hub.close();
});

test('live hub forgets a client once its connection closes', () => {
  const hub = createLiveHub();
  const { req, res } = fakeClient();
  hub.subscribe(req, res, 1);
  assert.equal(hub.size(), 1);
  req.emit('close');
  assert.equal(hub.size(), 0);
  hub.publish({ version: 2, reason: 'save' });
  assert.ok(!res.chunks.join('').includes('"version":2'));
});

test('live hub refuses connections beyond its limit', () => {
  const hub = createLiveHub({ maxClients: 1 });
  hub.subscribe(fakeClient().req, fakeClient().res, 1);
  const { req, res } = fakeClient();
  assert.equal(hub.subscribe(req, res, 1), false);
  assert.equal(res.status, 503);
  hub.close();
});
