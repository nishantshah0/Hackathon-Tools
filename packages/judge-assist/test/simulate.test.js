import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulate } from "../src/simulate.js";
import { kendallTau } from "../src/rank.js";

delete process.env.ANTHROPIC_API_KEY; // whole suite must run offline

const submissions = JSON.parse(
  readFileSync(new URL("../examples/submissions.json", import.meta.url), "utf8")
);

test("end-to-end: recovers the hidden true ranking well above chance (seeded)", () => {
  const sim = simulate({ submissions, numJudges: 5, perJudge: 8, seed: 1 });
  assert.ok(sim.tau >= 0.7, `Kendall tau ${sim.tau} below 0.7 for seed 1`);
  // Far fewer judgments than a full round-robin.
  assert.ok(sim.comparisonsUsed <= 40);
  assert.equal(sim.roundRobinComparisons, 5 * 66);
  assert.ok(sim.comparisonsUsed < sim.roundRobinComparisons / 5);
});

test("end-to-end simulation is deterministic for a given seed", () => {
  const a = simulate({ submissions, numJudges: 5, perJudge: 8, seed: 2 });
  const b = simulate({ submissions, numJudges: 5, perJudge: 8, seed: 2 });
  assert.deepEqual(a.results, b.results);
  assert.equal(a.tau, b.tau);
  assert.deepEqual(a.recoveredRanking, b.recoveredRanking);
});

test("more comparison budget improves (or maintains) recovery on a hard seed", () => {
  const small = simulate({ submissions, numJudges: 5, perJudge: 8, seed: 3 });
  const big = simulate({ submissions, numJudges: 5, perJudge: 16, seed: 3 });
  assert.ok(big.tau >= small.tau, `more budget got worse: ${big.tau} < ${small.tau}`);
  assert.ok(big.tau >= 0.7, `even 16/judge should recover well (tau ${big.tau})`);
});

test("simulated COI judge never sees the excluded team's project", () => {
  const sim = simulate({ submissions, numJudges: 5, perJudge: 8, seed: 1 });
  const excludedTeam = sim.judges[0].excludedTeams[0];
  const excludedIds = new Set(submissions.filter((s) => s.team === excludedTeam).map((s) => s.id));
  for (const a of sim.assignments) {
    if (a.judge === sim.judges[0].id) {
      assert.ok(!excludedIds.has(a.projectA) && !excludedIds.has(a.projectB));
    }
  }
});

test("kendallTau of the true ranking against itself is 1", () => {
  const sim = simulate({ submissions, numJudges: 5, perJudge: 8, seed: 1 });
  assert.equal(kendallTau(sim.trueRanking, sim.trueRanking), 1);
});
