// End-to-end simulation: prove the system recovers a hidden true ranking with far
// fewer judgments than a full round-robin.
//
// 1. Assign each submission a hidden true quality (deterministic from the seed).
// 2. Schedule pairwise comparisons in two rounds — the second round is adaptive,
//    fed the Bradley-Terry strengths from round one so it targets close matchups.
// 3. Simulate judge votes: P(A beats B) follows the Bradley-Terry model on the
//    true qualities, with noise (judges are imperfect).
// 4. Fit Bradley-Terry on the votes and compare recovered vs true ranking
//    (Kendall tau).

import { mulberry32 } from "./prng.js";
import { scheduleComparisons } from "./schedule.js";
import { bradleyTerry, kendallTau } from "./rank.js";

/**
 * simulate({submissions, numJudges, perJudge, seed, noise})
 * noise: standard-deviation-ish jitter on perceived quality per vote (default 0.35).
 */
export function simulate({ submissions, numJudges = 5, perJudge = 8, seed = 1, noise = 0.35 }) {
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);

  // Hidden true qualities on a log-strength scale, spread wide enough to be
  // recoverable but with realistic mid-pack crowding.
  const shuffled = [...submissions.keys()];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const n = submissions.length;
  const quality = new Map(); // id -> true log-quality
  shuffled.forEach((subIdx, pos) => {
    // Evenly spaced qualities over ~2.75 log-units, plus small jitter.
    const q = (pos / Math.max(1, n - 1)) * 2.75 + (rand() - 0.5) * 0.2;
    quality.set(submissions[subIdx].id, q);
  });

  const trueRanking = [...quality.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  // Judges; judge-1 gets a conflict of interest to exercise COI handling.
  const judges = Array.from({ length: numJudges }, (_, i) => ({ id: `judge-${i + 1}` }));
  if (submissions[0]?.team) judges[0].excludedTeams = [submissions[0].team];

  const vote = ({ judge, projectA, projectB }) => {
    const qa = quality.get(projectA) + (rand() - 0.5) * 2 * noise;
    const qb = quality.get(projectB) + (rand() - 0.5) * 2 * noise;
    const pA = 1 / (1 + Math.exp(-(qa - qb)));
    const aWins = rand() < pA;
    return { judge, winner: aWins ? projectA : projectB, loser: aWins ? projectB : projectA };
  };

  // Round 1: uniform coverage. Round 2: adaptive (targets close matchups).
  const round1Budget = Math.ceil(perJudge / 2);
  const round2Budget = perJudge - round1Budget;

  const assignments1 = scheduleComparisons({ submissions, judges, perJudge: round1Budget, seed });
  const results = assignments1.map(vote);

  let assignments2 = [];
  if (round2Budget > 0) {
    const interim = bradleyTerry(results);
    assignments2 = scheduleComparisons({
      submissions,
      judges,
      perJudge: round2Budget,
      seed: seed + 1,
      strengths: interim.strengths,
    });
    results.push(...assignments2.map(vote));
  }

  const fit = bradleyTerry(results);
  const recoveredRanking = fit.ranking.map((r) => r.id);
  const tau = kendallTau(trueRanking, recoveredRanking);

  const roundRobinComparisons = judges.length * ((n * (n - 1)) / 2);

  return {
    trueRanking,
    trueQuality: Object.fromEntries(quality),
    judges,
    assignments: [...assignments1, ...assignments2],
    results,
    fit,
    recoveredRanking,
    tau,
    comparisonsUsed: results.length,
    roundRobinComparisons,
  };
}
