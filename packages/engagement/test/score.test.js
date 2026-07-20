import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeScore,
  decayFactor,
  eventWeight,
  statusFor,
  detectTransitions,
  bucketSeries,
  DEFAULT_HALF_LIFE_MS,
  DEFAULT_WEIGHTS,
} from '../src/score.js';

const H = DEFAULT_HALF_LIFE_MS;
const T0 = Date.parse('2026-07-04T12:00:00Z');

test('decayFactor: 1 at age zero, 0.5 after one half-life, 0.25 after two', () => {
  assert.equal(decayFactor(0, H), 1);
  assert.ok(Math.abs(decayFactor(H, H) - 0.5) < 1e-12);
  assert.ok(Math.abs(decayFactor(2 * H, H) - 0.25) < 1e-12);
  assert.equal(decayFactor(-5000, H), 1, 'future events count fully');
});

test('score halves after one half-life', () => {
  const events = [{ type: 'commit', at: T0 }];
  const s0 = computeScore(events, T0);
  const s1 = computeScore(events, T0 + H);
  assert.equal(s0, 3);
  assert.ok(Math.abs(s1 - 1.5) < 1e-9);
});

test('computeScore sums weighted decayed events; explicit weight overrides type table', () => {
  const events = [
    { type: 'commit', at: T0 }, // 3
    { type: 'discord_message', at: T0 }, // 1
    { type: 'portal_login', at: T0 }, // 0.5
    { type: 'checkin', at: T0 }, // 2
    { type: 'discord_message', at: T0, weight: 10 }, // 10 (override)
    { type: 'mystery_signal', at: T0 }, // 1 (default)
  ];
  assert.equal(computeScore(events, T0), 3 + 1 + 0.5 + 2 + 10 + 1);
});

test('eventWeight respects custom weight tables', () => {
  assert.equal(eventWeight({ type: 'commit' }, { commit: 7 }), 7);
  assert.equal(eventWeight({ type: 'commit' }), DEFAULT_WEIGHTS.commit);
  assert.equal(eventWeight({ type: 'nope' }), 1);
});

test('statusFor band transitions', () => {
  const thresholds = { active: 6, dark: 2, darkAfterMinutes: 120 };
  const recently = T0 - 10 * 60_000; // 10 min ago
  const longAgo = T0 - 5 * 3_600_000; // 5h ago
  assert.equal(statusFor({ score: 0, lastEventAt: null, now: T0, thresholds }), 'new');
  assert.equal(statusFor({ score: 8, lastEventAt: recently, now: T0, thresholds }), 'active');
  assert.equal(statusFor({ score: 6, lastEventAt: recently, now: T0, thresholds }), 'active', 'boundary is inclusive');
  assert.equal(statusFor({ score: 3, lastEventAt: recently, now: T0, thresholds }), 'cooling');
  assert.equal(statusFor({ score: 1, lastEventAt: recently, now: T0, thresholds }), 'cooling',
    'low score but recent activity is cooling, not dark');
  assert.equal(statusFor({ score: 1, lastEventAt: longAgo, now: T0, thresholds }), 'dark',
    'dark needs low score AND prolonged silence');
});

test('detectTransitions generates alerts only for worsening from engaged states', () => {
  const prev = { a: 'active', b: 'active', c: 'cooling', d: 'dark', e: 'new', f: 'cooling' };
  const next = { a: 'cooling', b: 'dark', c: 'dark', d: 'active', e: 'cooling', f: 'cooling' };
  const alerts = detectTransitions(prev, next);
  assert.deepEqual(alerts, [
    { team: 'a', from: 'active', to: 'cooling' },
    { team: 'b', from: 'active', to: 'dark' },
    { team: 'c', from: 'cooling', to: 'dark' },
  ]);
});

test('detectTransitions works with Maps and ignores teams without prior status', () => {
  const prev = new Map([['a', 'active']]);
  const next = new Map([['a', 'dark'], ['brand-new', 'active']]);
  assert.deepEqual(detectTransitions(prev, next), [{ team: 'a', from: 'active', to: 'dark' }]);
});

test('bucketSeries: 48 half-hour buckets over 24h, events land in the right ones', () => {
  const events = [
    { type: 'commit', at: T0 - 5 * 60_000 }, // last bucket
    { type: 'discord_message', at: T0 - 5 * 60_000 }, // last bucket
    { type: 'commit', at: T0 - 23.9 * 3_600_000 }, // first bucket
    { type: 'commit', at: T0 - 25 * 3_600_000 }, // outside window: dropped
    { type: 'commit', at: T0 + 60_000 }, // future: dropped
  ];
  const series = bucketSeries(events, T0);
  assert.equal(series.length, 48);
  assert.equal(series[0].t, T0 - 24 * 3_600_000);
  assert.equal(series[47].count, 2);
  assert.equal(series[47].weight, 4); // commit 3 + discord 1
  assert.equal(series[0].count, 1);
  const total = series.reduce((n, b) => n + b.count, 0);
  assert.equal(total, 3, 'out-of-window and future events excluded');
});

test('bucketSeries: event exactly at now goes in the final bucket', () => {
  const series = bucketSeries([{ type: 'checkin', at: T0 }], T0);
  assert.equal(series[47].count, 1);
  assert.equal(series[47].weight, 2);
});
