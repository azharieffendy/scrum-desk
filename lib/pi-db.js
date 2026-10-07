/*
 * PI report cache: one person's result for a finished period. A finished
 * period's tickets and worklogs no longer change, so it is read from JIRA once
 * and served from here until an admin asks for a refresh.
 * sig is everything the result depends on (filled JQL, fields, site); a
 * mismatch is a miss, so changing the query or the site never serves stale rows.
 */
'use strict';

function createPiDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pi_person_cache (
      period TEXT NOT NULL, member_id TEXT NOT NULL, sig TEXT NOT NULL,
      data_json TEXT NOT NULL, fetched_at TEXT NOT NULL,
      PRIMARY KEY (period, member_id)
    );
  `);

  /** { data, fetchedAt } for a matching entry, else null. */
  function getPiCache(period, memberId, sig) {
    const row = db.prepare('SELECT sig, data_json, fetched_at FROM pi_person_cache WHERE period = ? AND member_id = ?')
      .get(period, memberId);
    if (!row || row.sig !== sig) return null;
    try {
      return { data: JSON.parse(row.data_json), fetchedAt: row.fetched_at };
    } catch {
      return null;
    }
  }

  function setPiCache(period, memberId, sig, data, fetchedAt) {
    db.prepare(`INSERT INTO pi_person_cache (period, member_id, sig, data_json, fetched_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (period, member_id) DO UPDATE SET sig = excluded.sig, data_json = excluded.data_json, fetched_at = excluded.fetched_at`)
      .run(period, memberId, sig, JSON.stringify(data), fetchedAt);
  }

  function clearPiCache() {
    db.prepare('DELETE FROM pi_person_cache').run();
  }

  return { getPiCache, setPiCache, clearPiCache };
}

module.exports = { createPiDb };
