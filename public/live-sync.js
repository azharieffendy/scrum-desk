/*
 * Live sync helpers: merge someone else's saved board into this tab's
 * board without losing edits this tab has not saved yet.
 */
'use strict';

function isPlainRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function copy(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Arrays of records with an id (team members, rosters) merge item by item. */
function isIdList(v) {
  return Array.isArray(v) && v.every((item) => isPlainRecord(item) && typeof item.id === 'string');
}

function mergeIdLists(base, mine, theirs) {
  const byId = (list) => new Map(list.map((item) => [item.id, item]));
  const b = byId(base), m = byId(mine), t = byId(theirs);
  // mine's order first (keeps a local reorder), then items only the server has, in its order
  const ids = [...m.keys(), ...[...t.keys()].filter((id) => !m.has(id))];
  const out = [];
  for (const id of ids) {
    const merged = merge3(b.get(id), m.get(id), t.get(id));
    if (merged !== undefined) out.push(merged);
  }
  return out;
}

/**
 * Three-way merge. base: what this tab last knew the server had;
 * mine: this tab's board now; theirs: the server's board now.
 * Objects merge key by key and id lists item by item; anything else
 * changed on both sides keeps mine.
 * Returns a new value (inputs are not modified).
 */
function merge3(base, mine, theirs) {
  if (sameValue(mine, base)) return copy(theirs);
  if (sameValue(theirs, base) || sameValue(mine, theirs)) return copy(mine);
  // created on both sides (e.g. both started today's standup): merge from empty
  if (base === undefined && isPlainRecord(mine) && isPlainRecord(theirs)) base = {};
  if (base === undefined && isIdList(mine) && isIdList(theirs)) base = [];
  if (isIdList(base) && isIdList(mine) && isIdList(theirs)) return mergeIdLists(base, mine, theirs);
  if (!isPlainRecord(base) || !isPlainRecord(mine) || !isPlainRecord(theirs)) return copy(mine);
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
  for (const key of keys) {
    const merged = merge3(base[key], mine[key], theirs[key]);
    if (merged !== undefined) out[key] = merged;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { merge3 };
