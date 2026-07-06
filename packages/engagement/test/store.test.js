import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { bucketSeries } from '../src/score.js';

const T0 = Date.parse('2026-07-04T12:00:00Z');

test('events round-trip with weight and meta', () => {
  const store = createStore();
  const stored = store.addEvent({
    team: 'team-1',
    type: 'commit',
    at: T0,
    weight: 4.5,
    meta: { repo: 'org/repo', author: 'ada' },
  });
  assert.ok(stored.id > 0);
  const got = store.eventsForTeam('team-1');
  assert.equal(got.length, 1);
  assert.equal(got[0].team, 'team-1');
  assert.equal(got[0].type, 'commit');
  assert.equal(got[0].at, T0);
  assert.equal(got[0].weight, 4.5);
  assert.deepEqual(got[0].meta, { repo: 'org/repo', author: 'ada' });
  store.close();
});

test('eventsForTeam filters by team and time range, sorted ascending', () => {
  const store = createStore();
  store.addEvent({ team: 'a', type: 'checkin', at: T0 - 3000 });
  store.addEvent({ team: 'a', type: 'commit', at: T0 - 1000 });
  store.addEvent({ team: 'a', type: 'discord_message', at: T0 - 2000 });
  store.addEvent({ team: 'b', type: 'commit', at: T0 - 1500 });
  const all = store.eventsForTeam('a');
  assert.deepEqual(all.map((e) => e.type), ['checkin', 'discord_message', 'commit']);
  const ranged = store.eventsForTeam('a', { since: T0 - 2500 });
  assert.deepEqual(ranged.map((e) => e.type), ['discord_message', 'commit']);
  store.close();
});

test('lastEventAt, lastSeenByType, eventCount, recentEventsForTeam', () => {
  const store = createStore();
  assert.equal(store.lastEventAt('a'), null);
  assert.deepEqual(store.lastSeenByType('a'), {});
  store.addEvent({ team: 'a', type: 'commit', at: T0 - 5000 });
  store.addEvent({ team: 'a', type: 'commit', at: T0 - 1000 });
  store.addEvent({ team: 'a', type: 'discord_message', at: T0 - 3000 });
  assert.equal(store.lastEventAt('a'), T0 - 1000);
  assert.deepEqual(store.lastSeenByType('a'), {
    commit: T0 - 1000,
    discord_message: T0 - 3000,
  });
  assert.equal(store.eventCount('a'), 3);
  const recent = store.recentEventsForTeam('a', 2);
  assert.deepEqual(recent.map((e) => e.at), [T0 - 1000, T0 - 3000]);
  store.close();
});

test('bucketed sparkline series over stored events is correct', () => {
  const store = createStore();
  store.addEvent({ team: 'a', type: 'commit', at: T0 - 10 * 60_000 }); // bucket 47
  store.addEvent({ team: 'a', type: 'discord_message', at: T0 - 40 * 60_000 }); // bucket 46
  store.addEvent({ team: 'a', type: 'checkin', at: T0 - 12 * 3_600_000 }); // bucket 23
  const events = store.eventsForTeam('a', { since: T0 - 24 * 3_600_000, until: T0 });
  const series = bucketSeries(events, T0);
  assert.equal(series[47].count, 1);
  assert.equal(series[47].weight, 3);
  assert.equal(series[46].count, 1);
  assert.equal(series[46].weight, 1);
  assert.equal(series[23].count, 1);
  assert.equal(series[23].weight, 2);
  assert.equal(series.reduce((n, b) => n + b.count, 0), 3);
  store.close();
});

test('alerts round-trip, per-team and global recency ordering', () => {
  const store = createStore();
  store.addAlert({ team: 'a', from: 'active', to: 'cooling', at: T0 - 2000, score: 4.2 });
  store.addAlert({ team: 'a', from: 'cooling', to: 'dark', at: T0 - 1000, score: 1.1 });
  store.addAlert({ team: 'b', from: 'active', to: 'dark', at: T0 - 500 });
  const forA = store.alertsForTeam('a');
  assert.equal(forA.length, 2);
  assert.deepEqual(forA.map((a) => a.to), ['dark', 'cooling']);
  assert.equal(forA[1].score, 4.2);
  const all = store.recentAlerts(10);
  assert.deepEqual(all.map((a) => a.team), ['b', 'a', 'a']);
  store.close();
});

test('persists across reopen when backed by a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engagement-'));
  const dbPath = join(dir, 'test.db');
  const s1 = createStore({ path: dbPath });
  s1.addEvent({ team: 'a', type: 'commit', at: T0, meta: { sha: 'abc' } });
  s1.addAlert({ team: 'a', from: 'active', to: 'dark', at: T0 });
  s1.close();
  const s2 = createStore({ path: dbPath });
  assert.equal(s2.eventCount('a'), 1);
  assert.deepEqual(s2.eventsForTeam('a')[0].meta, { sha: 'abc' });
  assert.equal(s2.recentAlerts(5).length, 1);
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});
