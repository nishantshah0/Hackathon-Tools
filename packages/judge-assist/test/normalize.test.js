import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeScores } from "../src/normalize.js";

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

test("z-score math matches a hand-computed fixture", () => {
  // Judge j gives scores 4, 6, 8: mean = 6, population std = sqrt(8/3).
  // z(4) = -2/std, z(6) = 0, z(8) = +2/std.
  const std = Math.sqrt(8 / 3);
  const scores = [
    { judge: "j", project: "A", score: 4 },
    { judge: "j", project: "B", score: 6 },
    { judge: "j", project: "C", score: 8 },
  ];
  const report = normalizeScores(scores);
  const byProject = Object.fromEntries(report.projects.map((p) => [p.project, p]));
  approx(byProject.A.normalizedScore, -2 / std);
  approx(byProject.B.normalizedScore, 0);
  approx(byProject.C.normalizedScore, 2 / std);
  // Judge calibration stats reported correctly.
  assert.equal(report.judges[0].judge, "j");
  approx(report.judges[0].mean, 6);
  approx(report.judges[0].std, std);
  assert.equal(report.judges[0].leniencyRank, 1);
});

test("harsh and generous judges scoring identical projects produce identical normalized scores", () => {
  // Same relative opinions, wildly different scales.
  const scores = [
    { judge: "harsh", project: "A", score: 5 },
    { judge: "harsh", project: "B", score: 4 },
    { judge: "harsh", project: "C", score: 3 },
    { judge: "generous", project: "A", score: 10 },
    { judge: "generous", project: "B", score: 9 },
    { judge: "generous", project: "C", score: 8 },
  ];
  const report = normalizeScores(scores);
  // Both judges gave equally spaced scores, so per-judge z values are identical
  // and each project's normalized score is the same as if one judge scored it.
  const byProject = Object.fromEntries(report.projects.map((p) => [p.project, p]));
  const std = Math.sqrt(2 / 3); // population std of {-1, 0, 1}-spaced triple
  approx(byProject.A.normalizedScore, 1 / std);
  approx(byProject.B.normalizedScore, 0);
  approx(byProject.C.normalizedScore, -1 / std);
  // Leniency report identifies who is who.
  const generous = report.judges.find((j) => j.judge === "generous");
  const harsh = report.judges.find((j) => j.judge === "harsh");
  assert.equal(generous.leniencyRank, 1);
  assert.equal(harsh.leniencyRank, 2);
});

test("normalization corrects for judge-panel luck that raw averages get wrong", () => {
  // A and B are equally good in every judge's eyes (top of their batch),
  // but A drew the harsh judge and B drew the generous one.
  const scores = [
    { judge: "harsh", project: "A", score: 6 },
    { judge: "harsh", project: "X", score: 4 },
    { judge: "harsh", project: "Y", score: 2 },
    { judge: "generous", project: "B", score: 10 },
    { judge: "generous", project: "X2", score: 8 },
    { judge: "generous", project: "Y2", score: 6 },
  ];
  const report = normalizeScores(scores);
  const byProject = Object.fromEntries(report.projects.map((p) => [p.project, p]));
  // Raw averages say B (10) crushes A (6)...
  assert.ok(byProject.B.rawMean > byProject.A.rawMean);
  // ...but normalized scores are identical: both were "top of batch" by the same margin.
  approx(byProject.A.normalizedScore, byProject.B.normalizedScore);
});

test("stddev = 0 yields z = 0 rather than NaN/Infinity", () => {
  const scores = [
    { judge: "flat", project: "A", score: 7 },
    { judge: "flat", project: "B", score: 7 },
    { judge: "flat", project: "C", score: 7 },
    { judge: "normal", project: "A", score: 9 },
    { judge: "normal", project: "B", score: 5 },
    { judge: "normal", project: "C", score: 7 },
  ];
  const report = normalizeScores(scores);
  for (const p of report.projects) {
    assert.ok(Number.isFinite(p.normalizedScore), `${p.project} score not finite`);
  }
  // The flat judge contributes 0 signal; ordering comes entirely from "normal".
  assert.deepEqual(report.projects.map((p) => p.project), ["A", "C", "B"]);
});

test("small-sample judges are shrunk toward global stats and flagged", () => {
  const scores = [
    // Well-sampled judge (n=4).
    { judge: "big", project: "A", score: 8 },
    { judge: "big", project: "B", score: 6 },
    { judge: "big", project: "C", score: 4 },
    { judge: "big", project: "D", score: 2 },
    // One-score judge: their personal mean equals their single score, so pure
    // z-scoring would force z = 0 (or blow up). Shrinkage keeps their opinion alive.
    { judge: "tiny", project: "A", score: 10 },
  ];
  const report = normalizeScores(scores);
  const tiny = report.judges.find((j) => j.judge === "tiny");
  const big = report.judges.find((j) => j.judge === "big");
  assert.equal(tiny.shrunk, true);
  assert.equal(big.shrunk, false);

  // With shrinkage, tiny's 10 is judged against a blended mean < 10, so it
  // contributes a positive z to project A instead of zero.
  const a = report.projects.find((p) => p.project === "A");
  const bigZforA = (8 - 5) / Math.sqrt(5); // big judge's own stats: mean 5, std sqrt(5)
  assert.ok(a.normalizedScore > bigZforA / 2, "tiny judge's vote should pull A up, not be zeroed");
});

test("rank movement report is correct (raw vs normalized ordering)", () => {
  const scores = [
    // harsh judge scores the genuinely-best project...
    { judge: "harsh", project: "best", score: 6 },
    { judge: "harsh", project: "mid1", score: 3 },
    { judge: "harsh", project: "mid2", score: 2 },
    // ...generous judge scores a mediocre project higher in raw terms.
    { judge: "generous", project: "lucky", score: 9 },
    { judge: "generous", project: "mid3", score: 9.5 },
    { judge: "generous", project: "mid4", score: 10 },
  ];
  const report = normalizeScores(scores);
  const byProject = Object.fromEntries(report.projects.map((p) => [p.project, p]));

  // Raw: best (6) ranks below lucky (9). Normalized: best is far above its judge's
  // mean, lucky is below its judge's mean, so they must swap sides.
  assert.ok(byProject.best.rawRank > byProject.lucky.rawRank);
  assert.ok(byProject.best.normalizedRank < byProject.lucky.normalizedRank);
  assert.ok(byProject.best.rankChange > 0, "best should move up");
  assert.ok(byProject.lucky.rankChange < 0, "lucky should move down");

  // rankChange is exactly rawRank - normalizedRank, and ranks are permutations.
  for (const p of report.projects) {
    assert.equal(p.rankChange, p.rawRank - p.normalizedRank);
  }
  const normRanks = report.projects.map((p) => p.normalizedRank).sort((x, y) => x - y);
  assert.deepEqual(normRanks, [1, 2, 3, 4, 5, 6]);
});

test("criteria are normalized per (judge, criterion) and combined with weights", () => {
  // Judge is harsh on technical, generous on design; per-criterion z-scores
  // must be computed separately.
  const scores = [
    { judge: "j", project: "A", criterion: "technical", score: 5 },
    { judge: "j", project: "B", criterion: "technical", score: 3 },
    { judge: "j", project: "C", criterion: "technical", score: 1 },
    { judge: "j", project: "A", criterion: "design", score: 8 },
    { judge: "j", project: "B", criterion: "design", score: 9 },
    { judge: "j", project: "C", criterion: "design", score: 10 },
  ];
  const equal = normalizeScores(scores);
  const byP = Object.fromEntries(equal.projects.map((p) => [p.project, p]));
  // A is +z on technical, -z on design (equal magnitudes) → net 0 with equal weights.
  approx(byP.A.normalizedScore, 0);
  approx(byP.B.normalizedScore, 0);
  approx(byP.C.normalizedScore, 0);

  // Weighting technical 3:1 makes the technical ordering dominate.
  const weighted = normalizeScores(scores, { weights: { technical: 3, design: 1 } });
  assert.deepEqual(weighted.projects.map((p) => p.project), ["A", "B", "C"]);
  assert.deepEqual(equal.criteria.sort(), ["design", "technical"]);
});

test("rejects empty and non-numeric input", () => {
  assert.throws(() => normalizeScores([]));
  assert.throws(() => normalizeScores([{ judge: "j", project: "A", score: "9" }]));
});
