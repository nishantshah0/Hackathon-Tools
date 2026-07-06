// Storage layer. Everything behind this interface so backends are swappable.
// Backend: node:sqlite (DatabaseSync). Times are stored as epoch ms integers.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * createStore({ path }) -> store
 *   path: sqlite file path, or ':memory:' (default) for ephemeral storage.
 *
 * Store interface:
 *   addEvent({team,type,at,weight?,meta?}) -> stored event
 *   eventsForTeam(team, {since?, until?})  -> events ascending by at
 *   recentEventsForTeam(team, limit)       -> events descending by at
 *   lastEventAt(team)                      -> epoch ms | null
 *   lastSeenByType(team)                   -> { type: epochMs }
 *   eventCount(team)                       -> number
 *   addAlert({team,from,to,at,score?})     -> stored alert
 *   alertsForTeam(team, limit)             -> alerts descending by at
 *   recentAlerts(limit)                    -> alerts descending by at
 *   backend                                -> 'sqlite'
 *   close()
 */
export function createStore({ path = ':memory:' } = {}) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      team   TEXT NOT NULL,
      type   TEXT NOT NULL,
      at     INTEGER NOT NULL,
      weight REAL,
      meta   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_team_at ON events(team, at);
    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      team        TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status   TEXT NOT NULL,
      at          INTEGER NOT NULL,
      score       REAL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_team_at ON alerts(team, at);
  `);

  const insertEvent = db.prepare(
    'INSERT INTO events (team, type, at, weight, meta) VALUES (?, ?, ?, ?, ?)'
  );
  const selectTeamEvents = db.prepare(
    'SELECT * FROM events WHERE team = ? AND at >= ? AND at <= ? ORDER BY at ASC'
  );
  const selectRecent = db.prepare(
    'SELECT * FROM events WHERE team = ? ORDER BY at DESC, id DESC LIMIT ?'
  );
  const selectLastAt = db.prepare('SELECT MAX(at) AS at FROM events WHERE team = ?');
  const selectLastByType = db.prepare(
    'SELECT type, MAX(at) AS at FROM events WHERE team = ? GROUP BY type'
  );
  const selectCount = db.prepare('SELECT COUNT(*) AS n FROM events WHERE team = ?');
  const insertAlert = db.prepare(
    'INSERT INTO alerts (team, from_status, to_status, at, score) VALUES (?, ?, ?, ?, ?)'
  );
  const selectTeamAlerts = db.prepare(
    'SELECT * FROM alerts WHERE team = ? ORDER BY at DESC, id DESC LIMIT ?'
  );
  const selectAllAlerts = db.prepare('SELECT * FROM alerts ORDER BY at DESC, id DESC LIMIT ?');

  const rowToEvent = (row) => ({
    id: Number(row.id),
    team: row.team,
    type: row.type,
    at: Number(row.at),
    weight: row.weight == null ? undefined : Number(row.weight),
    meta: row.meta == null ? undefined : JSON.parse(row.meta),
  });
  const rowToAlert = (row) => ({
    id: Number(row.id),
    team: row.team,
    from: row.from_status,
    to: row.to_status,
    at: Number(row.at),
    score: row.score == null ? undefined : Number(row.score),
  });

  return {
    backend: 'sqlite',

    addEvent({ team, type, at, weight = null, meta = null }) {
      const res = insertEvent.run(
        team,
        type,
        Math.round(at),
        weight,
        meta == null ? null : JSON.stringify(meta)
      );
      return {
        id: Number(res.lastInsertRowid),
        team,
        type,
        at: Math.round(at),
        weight: weight ?? undefined,
        meta: meta ?? undefined,
      };
    },

    eventsForTeam(team, { since = 0, until = Number.MAX_SAFE_INTEGER } = {}) {
      return selectTeamEvents.all(team, Math.round(since), Math.round(until)).map(rowToEvent);
    },

    recentEventsForTeam(team, limit = 50) {
      return selectRecent.all(team, limit).map(rowToEvent);
    },

    lastEventAt(team) {
      const row = selectLastAt.get(team);
      return row && row.at != null ? Number(row.at) : null;
    },

    lastSeenByType(team) {
      const out = {};
      for (const row of selectLastByType.all(team)) out[row.type] = Number(row.at);
      return out;
    },

    eventCount(team) {
      return Number(selectCount.get(team).n);
    },

    addAlert({ team, from, to, at, score = null }) {
      const res = insertAlert.run(team, from, to, Math.round(at), score);
      return { id: Number(res.lastInsertRowid), team, from, to, at: Math.round(at), score: score ?? undefined };
    },

    alertsForTeam(team, limit = 20) {
      return selectTeamAlerts.all(team, limit).map(rowToAlert);
    },

    recentAlerts(limit = 20) {
      return selectAllAlerts.all(limit).map(rowToAlert);
    },

    close() {
      db.close();
    },
  };
}
