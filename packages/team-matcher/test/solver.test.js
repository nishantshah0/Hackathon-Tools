import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchTeams,
  mulberry32,
  participantUtcIntervals,
  overlapHours,
} from '../src/index.js';

const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Warsaw',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];
const ROLES = ['frontend', 'backend', 'ml', 'design', 'infra', 'mobile'];
const SKILLS = ['react', 'vue', 'node', 'python', 'go', 'rust', 'k8s', 'figma', 'swift', 'aws'];
const INTERESTS = ['devtools', 'fintech', 'ai-agents', 'health', 'climate', 'gaming', 'social'];

function pick(rng, arr, count) {
  const copy = arr.slice();
  const out = [];
  for (let i = 0; i < count && copy.length > 0; i++) {
    out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  }
  return out;
}

function randomParticipants(seed, n) {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const start = Math.floor(rng() * 16); // 0..15
    const length = 6 + Math.floor(rng() * 10); // 6..15h, may wrap past midnight
    return {
      id: `r${i}`,
      name: `Rando ${i}`,
      roles: pick(rng, ROLES, 1 + Math.floor(rng() * 2)),
      skills: pick(rng, SKILLS, 2 + Math.floor(rng() * 3)),
      interests: pick(rng, INTERESTS, 1 + Math.floor(rng() * 3)),
      timezone: ZONES[Math.floor(rng() * ZONES.length)],
      availability: [{ start, end: start + length }],
      experience: 1 + Math.floor(rng() * 5),
    };
  });
}

function assertHardConstraints(result, participants, { minSize, maxSize, minOverlapHours }) {
  const byId = new Map(participants.map((p) => [p.id, p]));
  const seen = new Set();

  for (const team of result.teams) {
    assert.ok(
      team.members.length >= minSize && team.members.length <= maxSize,
      `${team.id} has size ${team.members.length}, expected ${minSize}-${maxSize}`
    );
    const intervals = team.members.map((m) => participantUtcIntervals(byId.get(m.id)));
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        const h = overlapHours(intervals[i], intervals[j]);
        assert.ok(
          h >= minOverlapHours - 1e-9,
          `${team.id}: ${team.members[i].id} and ${team.members[j].id} overlap only ${h}h`
        );
      }
    }
    for (const m of team.members) {
      assert.ok(!seen.has(m.id), `participant ${m.id} assigned twice`);
      seen.add(m.id);
    }
  }
  for (const u of result.unassigned) {
    assert.ok(!seen.has(u.id), `unassigned ${u.id} also appears in a team`);
    seen.add(u.id);
  }
  assert.equal(seen.size, participants.length, 'every participant accounted for exactly once');
}

test('property: hard constraints never violated across random seeded inputs', () => {
  for (const trial of [1, 2, 3, 4, 5]) {
    const participants = randomParticipants(1000 + trial, 40 + trial * 7);
    const opts = { minSize: 3, maxSize: 4, minOverlapHours: 4, seed: trial, iterations: 4000 };
    const result = matchTeams(participants, opts);
    assertHardConstraints(result, participants, opts);
  }
});

test('property: holds for other size ranges and overlap thresholds', () => {
  const participants = randomParticipants(77, 60);
  const opts = { minSize: 2, maxSize: 5, minOverlapHours: 6, seed: 7, iterations: 4000 };
  const result = matchTeams(participants, opts);
  assertHardConstraints(result, participants, opts);
});

test('determinism: same seed produces identical output', () => {
  const participants = randomParticipants(42, 50);
  const a = matchTeams(participants, { seed: 123, iterations: 3000 });
  const b = matchTeams(participants, { seed: 123, iterations: 3000 });
  assert.deepEqual(a, b);
});

test('participant with a tiny availability window is unassigned with a reason', () => {
  const participants = [
    ...randomParticipants(5, 12).map((p) => ({ ...p, timezone: 'UTC', availability: [{ start: 9, end: 18 }] })),
    {
      id: 'loner',
      name: 'Night Loner',
      roles: ['ml'],
      skills: ['python'],
      interests: ['ai-agents'],
      timezone: 'UTC',
      availability: [{ start: 2, end: 4 }], // 2h window can never satisfy 4h overlap
      experience: 5,
    },
  ];
  const result = matchTeams(participants, { seed: 1, iterations: 2000 });
  const loner = result.unassigned.find((u) => u.id === 'loner');
  assert.ok(loner, 'loner should be unassigned');
  assert.match(loner.reason, /only 0 other participant/);
});

test('everyone incompatible: all unassigned, no teams', () => {
  // Three participants with mutually disjoint 3h windows and H=4.
  const participants = [
    { id: 'a', name: 'A', roles: ['frontend'], skills: [], interests: [], timezone: 'UTC', availability: [{ start: 0, end: 3 }], experience: 3 },
    { id: 'b', name: 'B', roles: ['backend'], skills: [], interests: [], timezone: 'UTC', availability: [{ start: 8, end: 11 }], experience: 3 },
    { id: 'c', name: 'C', roles: ['ml'], skills: [], interests: [], timezone: 'UTC', availability: [{ start: 16, end: 19 }], experience: 3 },
  ];
  const result = matchTeams(participants, { seed: 9, iterations: 500 });
  assert.equal(result.teams.length, 0);
  assert.equal(result.unassigned.length, 3);
});

test('input validation: duplicate ids and bad options are rejected', () => {
  const p = randomParticipants(3, 4);
  assert.throws(() => matchTeams([...p, { ...p[0] }]), /duplicate participant id/);
  assert.throws(() => matchTeams(p, { minSize: 1 }), /minSize/);
  assert.throws(() => matchTeams(p, { minSize: 4, maxSize: 3 }), /maxSize/);
  assert.throws(() => matchTeams(p, { minOverlapHours: 30 }), /minOverlapHours/);
  assert.throws(() => matchTeams('nope'), /must be an array/);
});

test('handles a few hundred participants quickly', () => {
  const participants = randomParticipants(2026, 300);
  const started = Date.now();
  const opts = { minSize: 3, maxSize: 4, minOverlapHours: 4, seed: 11 };
  const result = matchTeams(participants, opts);
  const elapsed = Date.now() - started;
  assertHardConstraints(result, participants, opts);
  assert.ok(elapsed < 15_000, `took ${elapsed}ms`);
  assert.ok(result.teams.length > 0);
});
