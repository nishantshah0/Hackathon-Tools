import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scheduleComparisons, appearanceCounts } from "../src/schedule.js";

const submissions = JSON.parse(
  readFileSync(new URL("../examples/submissions.json", import.meta.url), "utf8")
);
const judges = JSON.parse(readFileSync(new URL("../examples/judges.json", import.meta.url), "utf8"));

test("balance: project appearance counts differ by at most 2", () => {
  const assignments = scheduleComparisons({ submissions, judges, perJudge: 8, seed: 1 });
  const counts = appearanceCounts(assignments);
  // Every project must appear at least once at this budget.
  assert.equal(counts.size, submissions.length);
  const values = [...counts.values()];
  assert.ok(
    Math.max(...values) - Math.min(...values) <= 2,
    `imbalance too high: ${JSON.stringify([...counts])}`
  );
});

test("conflicts of interest are never violated", () => {
  for (const seed of [1, 2, 3, 99]) {
    const assignments = scheduleComparisons({ submissions, judges, perJudge: 10, seed });
    const teamOf = new Map(submissions.map((s) => [s.id, s.team]));
    const excludedOf = new Map(judges.map((j) => [j.id, new Set(j.excludedTeams || [])]));
    for (const { judge, projectA, projectB } of assignments) {
      const excluded = excludedOf.get(judge);
      assert.ok(!excluded.has(teamOf.get(projectA)), `${judge} judged excluded team via ${projectA}`);
      assert.ok(!excluded.has(teamOf.get(projectB)), `${judge} judged excluded team via ${projectB}`);
    }
  }
});

test("a judge never sees the same pair twice and never compares a project to itself", () => {
  const assignments = scheduleComparisons({ submissions, judges, perJudge: 12, seed: 5 });
  const seen = new Set();
  for (const { judge, projectA, projectB } of assignments) {
    assert.notEqual(projectA, projectB);
    const key = `${judge}:${[projectA, projectB].sort().join("|")}`;
    assert.ok(!seen.has(key), `duplicate pair for ${key}`);
    seen.add(key);
  }
});

test("judge repetition is bounded: no judge hammers one project", () => {
  const perJudge = 8;
  const assignments = scheduleComparisons({ submissions, judges, perJudge, seed: 1 });
  const perJudgeCounts = new Map();
  for (const { judge, projectA, projectB } of assignments) {
    if (!perJudgeCounts.has(judge)) perJudgeCounts.set(judge, new Map());
    const m = perJudgeCounts.get(judge);
    m.set(projectA, (m.get(projectA) || 0) + 1);
    m.set(projectB, (m.get(projectB) || 0) + 1);
  }
  // 8 comparisons over >=10 eligible projects: nobody should see one project more
  // than ceil(2*perJudge/10)+1 = 3 times.
  for (const [judge, m] of perJudgeCounts) {
    const max = Math.max(...m.values());
    assert.ok(max <= 3, `${judge} saw a project ${max} times`);
  }
});

test("deterministic for the same seed, different for different seeds", () => {
  const a = scheduleComparisons({ submissions, judges, perJudge: 8, seed: 42 });
  const b = scheduleComparisons({ submissions, judges, perJudge: 8, seed: 42 });
  assert.deepEqual(a, b);
  const c = scheduleComparisons({ submissions, judges, perJudge: 8, seed: 43 });
  assert.notDeepEqual(a, c);
});

test("adaptive mode prefers pairs with similar strengths", () => {
  // Strengths split into two well-separated tiers. With gap-aware scheduling,
  // cross-tier pairs (huge gap) should be rarer than under uniform scheduling.
  const strengths = {};
  submissions.forEach((s, i) => {
    strengths[s.id] = i < 6 ? 50 : 0.02;
  });
  const tier = (id) => (strengths[id] === 50 ? "hi" : "lo");
  const crossFraction = (assignments) =>
    assignments.filter((a) => tier(a.projectA) !== tier(a.projectB)).length / assignments.length;

  const uniform = scheduleComparisons({ submissions, judges, perJudge: 6, seed: 9 });
  const adaptive = scheduleComparisons({ submissions, judges, perJudge: 6, seed: 9, strengths });
  assert.ok(
    crossFraction(adaptive) < crossFraction(uniform),
    `adaptive cross-tier ${crossFraction(adaptive)} not below uniform ${crossFraction(uniform)}`
  );
});

test("input validation", () => {
  assert.throws(() => scheduleComparisons({ submissions: [], judges, perJudge: 2 }));
  assert.throws(() => scheduleComparisons({ submissions, judges: [], perJudge: 2 }));
  assert.throws(() => scheduleComparisons({ submissions, judges, perJudge: 0 }));
});
