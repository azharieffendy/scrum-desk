/* ================================================================
   Status colours — a fixed palette slot per JIRA status name.

   Pure and shared: the server assigns and saves the map, the browser
   looks slots up (with a stable hash fallback for statuses the map
   does not know yet).
   ================================================================ */
'use strict';

const STATUS_SLOTS = 24;
// Palette slots per status category: muted mixed tones for "new",
// a full hue wheel for "in progress", greens/teals for "done".
const STATUS_SLOT_RANGES = { new: [0, 5], indeterminate: [6, 17], done: [18, 23] };
// Order slots are handed out in, per category: each next pick is a hue far
// from the ones before, so a board's few statuses never get look-alike neighbours.
const STATUS_PICK_ORDER = {
  new: [0, 1, 2, 5, 3, 4],
  indeterminate: [6, 14, 9, 17, 12, 16, 8, 13, 10, 15, 7, 11],
  done: [18, 20, 22, 19, 21, 23],
};
const STATUS_CATEGORY_ORDER = ['new', 'indeterminate', 'done'];
const STATUS_NAME_MAX = 100;

const statusKey = (name) => String(name == null ? '' : name).trim().toLowerCase();
const statusPicks = (category) => STATUS_PICK_ORDER[category] || STATUS_PICK_ORDER.indeterminate;

/** Valid entries only: { "<lower-case name>": integer slot 0–23 }. */
function cleanColorMap(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [name, slot] of Object.entries(map)) {
    const key = statusKey(name);
    if (!key || key.length > STATUS_NAME_MAX) continue;
    if (!Number.isInteger(slot) || slot < 0 || slot >= STATUS_SLOTS) continue;
    out[key] = slot;
  }
  return out;
}

/**
 * statuses: [{ id, name, category }] from JIRA; saved: the stored map.
 * Returns a new map: saved slots kept, other statuses get the next free slot
 * of their category's pick order (category order, then JIRA id). A full range
 * reuses its own slots in that same order.
 */
function assignColors(statuses, saved) {
  const map = cleanColorMap(saved);
  const used = new Set(Object.values(map));
  const rank = (c) => {
    const i = STATUS_CATEGORY_ORDER.indexOf(c);
    return i < 0 ? 1 : i;
  };
  const sorted = (statuses || [])
    .filter((s) => s && statusKey(s.name))
    .slice()
    .sort((a, b) => rank(a.category) - rank(b.category) || Number(a.id) - Number(b.id));
  const overflow = {};
  for (const s of sorted) {
    const key = statusKey(s.name);
    if (key.length > STATUS_NAME_MAX || Object.prototype.hasOwnProperty.call(map, key)) continue;
    const picks = statusPicks(s.category);
    let slot = picks.find((i) => !used.has(i));
    if (slot == null) {
      const range = picks[0];
      overflow[range] = overflow[range] || 0;
      slot = picks[overflow[range]++ % picks.length];
    }
    map[key] = slot;
    used.add(slot);
  }
  return map;
}

/** FNV-1a: small, stable across runs and platforms. */
function statusHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Saved slot for a status, else a stable hash within its category's range; null without a name. */
function slotFor(name, category, map) {
  const key = statusKey(name);
  if (!key) return null;
  if (map && Number.isInteger(map[key])) return map[key];
  const picks = statusPicks(category);
  return picks[statusHash(key) % picks.length];
}

/** The stage a slot's hue stands for. */
function categoryForSlot(slot) {
  return STATUS_CATEGORY_ORDER.find((c) => slot >= STATUS_SLOT_RANGES[c][0] && slot <= STATUS_SLOT_RANGES[c][1]) || 'indeterminate';
}

/** Settings rows: [{ name, slot, category, sharedWith }] by slot, then name. */
function statusColorRows(map) {
  const clean = cleanColorMap(map);
  const names = Object.keys(clean).sort((a, b) => clean[a] - clean[b] || a.localeCompare(b));
  return names.map((name) => ({
    name,
    slot: clean[name],
    category: categoryForSlot(clean[name]),
    sharedWith: names.filter((other) => other !== name && clean[other] === clean[name]),
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    assignColors, slotFor, cleanColorMap, statusKey, statusColorRows, categoryForSlot, STATUS_SLOTS, STATUS_SLOT_RANGES, STATUS_PICK_ORDER,
  };
}
