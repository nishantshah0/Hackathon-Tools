import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jaccard,
  roleCoverage,
  interestCohesion,
  skillComplementarity,
  experienceBalance,
  teamScore,
  DEFAULT_WEIGHTS,
} from '../src/index.js';

const member = (over = {}) => ({
  roles: ['backend'],
  skills: ['python'],
  interests: ['devtools'],
  experience: 3,
  ...over,
});

test('jaccard basics', () => {
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a', 'b'], ['c', 'd']), 0);
  assert.equal(jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(['a'], []), 0);
  assert.equal(jaccard(['a', 'a', 'b'], ['a', 'b']), 1); // duplicates ignored
});

test('roleCoverage rewards distinct roles and frontend+backend presence', () => {
  const fullStack = [
    member({ roles: ['frontend'] }),
    member({ roles: ['backend'] }),
    member({ roles: ['infra'] }),
  ];
  const monoculture = [
    member({ roles: ['backend'] }),
    member({ roles: ['backend'] }),
    member({ roles: ['backend'] }),
  ];
  assert.ok(roleCoverage(fullStack) > roleCoverage(monoculture));
  assert.equal(roleCoverage(fullStack), 1); // 3 distinct roles, both bonuses
  // all-backend: base 1/3 * 0.5 + backend bonus 0.25
  assert.ok(Math.abs(roleCoverage(monoculture) - (0.5 / 3 + 0.25)) < 1e-9);
  assert.equal(roleCoverage([]), 0);
});

test('interestCohesion is mean pairwise jaccard', () => {
  const aligned = [
    member({ interests: ['ai-agents', 'devtools'] }),
    member({ interests: ['ai-agents', 'devtools'] }),
  ];
  const disjoint = [
    member({ interests: ['ai-agents'] }),
    member({ interests: ['fintech'] }),
  ];
  assert.equal(interestCohesion(aligned), 1);
  assert.equal(interestCohesion(disjoint), 0);
  assert.equal(interestCohesion([member()]), 0); // no pairs
});

test('skillComplementarity penalizes duplication', () => {
  const complementary = [
    member({ skills: ['react', 'css'] }),
    member({ skills: ['go', 'k8s'] }),
  ];
  const duplicated = [
    member({ skills: ['react', 'css'] }),
    member({ skills: ['react', 'css'] }),
  ];
  assert.equal(skillComplementarity(complementary), 1);
  assert.equal(skillComplementarity(duplicated), 0.5);
  assert.ok(skillComplementarity(complementary) > skillComplementarity(duplicated));
  assert.equal(skillComplementarity([member({ skills: [] })]), 0);
});

test('experienceBalance penalizes all-novice and all-expert teams', () => {
  const allNovice = [member({ experience: 1 }), member({ experience: 1 })];
  const allExpert = [member({ experience: 5 }), member({ experience: 5 })];
  const mixed = [member({ experience: 1 }), member({ experience: 5 }), member({ experience: 3 })];
  assert.equal(experienceBalance(allNovice), 0);
  assert.equal(experienceBalance(allExpert), 0);
  assert.equal(experienceBalance(mixed), 1);
  assert.ok(experienceBalance(mixed) > experienceBalance(allNovice));
  const allMid = [member({ experience: 3 }), member({ experience: 3 })];
  assert.equal(experienceBalance(allMid), 0.5); // centered mean, zero spread
});

test('teamScore is a weighted sum of components, bounded in [0,1]', () => {
  const team = [
    member({ roles: ['frontend'], skills: ['react'], interests: ['ai'], experience: 2 }),
    member({ roles: ['backend'], skills: ['go'], interests: ['ai'], experience: 4 }),
    member({ roles: ['ml'], skills: ['python'], interests: ['ai'], experience: 3 }),
  ];
  const s = teamScore(team);
  const expected =
    DEFAULT_WEIGHTS.roleCoverage * s.roleCoverage +
    DEFAULT_WEIGHTS.interestCohesion * s.interestCohesion +
    DEFAULT_WEIGHTS.skillComplementarity * s.skillComplementarity +
    DEFAULT_WEIGHTS.experienceBalance * s.experienceBalance;
  assert.ok(Math.abs(s.total - expected) < 1e-12);
  assert.ok(s.total >= 0 && s.total <= 1);
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    assert.ok(s[key] >= 0 && s[key] <= 1, `${key} out of range`);
  }
});
