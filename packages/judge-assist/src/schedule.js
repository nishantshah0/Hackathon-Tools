// Pairwise comparison scheduler.
//
// Given N submissions, J judges, and a budget of K comparisons per judge, produce
// (judge, projectA, projectB) assignments that:
//   (a) balance how often each project appears overall,
//   (b) avoid giving one judge the same project too many times,
//   (c) respect judge conflict-of-interest exclusions (judge.excludedTeams),
//   (d) when current Bradley-Terry strengths are provided (adaptive rounds),
//       prefer pairs with similar strength — comparisons between near-equals
//       carry the most information (uncertainty reduction).
//
// Deterministic for a given seed (mulberry32 PRNG used only for tie-breaking).

import { mulberry32 } from "./prng.js";

const W_GLOBAL = 4; // weight: overall appearance balance
const W_JUDGE = 2; // weight: per-judge repetition
const W_GAP = 3; // weight: strength-gap penalty in adaptive mode

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * scheduleComparisons({submissions, judges, perJudge, seed, strengths})
 *
 * submissions: [{id, team, ...}]
 * judges:      [{id or name, excludedTeams?: [team, ...]}]
 * strengths:   optional {projectId: strength} from a previous Bradley-Terry round
 *
 * Returns [{judge, projectA, projectB}]
 */
export function scheduleComparisons({ submissions, judges, perJudge, seed = 1, strengths = null }) {
  if (!submissions?.length || submissions.length < 2) {
    throw new Error("Need at least 2 submissions to schedule comparisons");
  }
  if (!judges?.length) throw new Error("Need at least 1 judge");
  if (!Number.isInteger(perJudge) || perJudge < 1) {
    throw new Error("perJudge must be a positive integer");
  }

  const rand = mulberry32(seed);
  const teamOf = new Map(submissions.map((s) => [s.id, s.team]));
  const ids = submissions.map((s) => s.id);

  const logStrength = strengths
    ? new Map(ids.map((id) => [id, Math.log(Math.max(strengths[id] ?? 1, 1e-9))]))
    : null;

  const totalCount = new Map(ids.map((id) => [id, 0]));
  const judgeStates = judges.map((j) => {
    const excluded = new Set(j.excludedTeams || []);
    const eligible = ids.filter((id) => !excluded.has(teamOf.get(id)));
    return {
      id: j.id ?? j.name,
      eligible,
      counts: new Map(ids.map((id) => [id, 0])),
      seenPairs: new Set(),
    };
  });

  const assignments = [];

  // Round-robin over slots so global balance is maintained as we go.
  for (let slot = 0; slot < perJudge; slot++) {
    for (const js of judgeStates) {
      if (js.eligible.length < 2) continue; // COI leaves nothing to compare

      let best = null;
      let bestCost = Infinity;
      for (let i = 0; i < js.eligible.length; i++) {
        for (let k = i + 1; k < js.eligible.length; k++) {
          const a = js.eligible[i];
          const b = js.eligible[k];
          if (js.seenPairs.has(pairKey(a, b))) continue;

          let cost =
            W_GLOBAL * (totalCount.get(a) + totalCount.get(b)) +
            W_JUDGE * (js.counts.get(a) + js.counts.get(b));
          if (logStrength) {
            cost += W_GAP * Math.abs(logStrength.get(a) - logStrength.get(b));
          }
          cost += rand() * 1e-6; // deterministic (seeded) tie-break

          if (cost < bestCost) {
            bestCost = cost;
            best = [a, b];
          }
        }
      }
      if (!best) continue; // judge has exhausted all eligible pairs

      const [a, b] = best;
      js.seenPairs.add(pairKey(a, b));
      js.counts.set(a, js.counts.get(a) + 1);
      js.counts.set(b, js.counts.get(b) + 1);
      totalCount.set(a, totalCount.get(a) + 1);
      totalCount.set(b, totalCount.get(b) + 1);
      assignments.push({ judge: js.id, projectA: a, projectB: b });
    }
  }

  return assignments;
}

/** Appearance counts per project for an assignment list (handy for balance checks). */
export function appearanceCounts(assignments) {
  const counts = new Map();
  for (const { projectA, projectB } of assignments) {
    counts.set(projectA, (counts.get(projectA) || 0) + 1);
    counts.set(projectB, (counts.get(projectB) || 0) + 1);
  }
  return counts;
}
