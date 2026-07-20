// Bradley-Terry ranking from sparse pairwise comparison results. Pure math, zero deps.
//
// Model: P(i beats j) = p_i / (p_i + p_j) for latent strengths p > 0.
// Fitting: the standard iterative MM/Zermelo algorithm, run to a convergence
// tolerance on the max change in log-strength.
//
// Regularization: each item gets `epsilon` virtual wins AND `epsilon` virtual
// losses against a dummy opponent of fixed strength 1. This keeps undefeated
// items from diverging to +inf and never-winning items from collapsing to 0,
// while barely perturbing well-sampled items.

/**
 * bradleyTerry(results, opts)
 * results: [{winner, loser, judge?}]
 * opts: {epsilon=0.5, tolerance=1e-9, maxIterations=2000}
 *
 * Returns {
 *   strengths,       // {id: strength}, normalized to geometric mean 1
 *   ranking,         // [{id, rank, strength, score, wins, losses, comparisons, confidence}]
 *   judgeAgreement,  // {judge: {total, agreed, rate, outlier}}
 *   iterations, converged
 * }
 */
export function bradleyTerry(results, { epsilon = 0.5, tolerance = 1e-9, maxIterations = 2000 } = {}) {
  if (!results?.length) throw new Error("No comparison results provided");

  const items = [...new Set(results.flatMap((r) => [r.winner, r.loser]))];
  const wins = new Map(items.map((i) => [i, 0]));
  const losses = new Map(items.map((i) => [i, 0]));
  // games[i] = Map(opponent -> number of games between i and opponent)
  const games = new Map(items.map((i) => [i, new Map()]));

  for (const { winner, loser } of results) {
    if (winner === loser) throw new Error(`Result pits ${winner} against itself`);
    wins.set(winner, wins.get(winner) + 1);
    losses.set(loser, losses.get(loser) + 1);
    games.get(winner).set(loser, (games.get(winner).get(loser) || 0) + 1);
    games.get(loser).set(winner, (games.get(loser).get(winner) || 0) + 1);
  }

  let p = new Map(items.map((i) => [i, 1]));
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    const next = new Map();
    for (const i of items) {
      const pi = p.get(i);
      // Zermelo update: p_i <- W_i / sum_j n_ij / (p_i + p_j)
      // plus the regularizing dummy: eps wins + eps losses vs strength-1 opponent.
      let denom = (2 * epsilon) / (pi + 1);
      for (const [j, n] of games.get(i)) denom += n / (pi + p.get(j));
      next.set(i, (wins.get(i) + epsilon) / denom);
    }

    // Normalize to geometric mean 1 (the model is scale-invariant).
    const meanLog = items.reduce((s, i) => s + Math.log(next.get(i)), 0) / items.length;
    const scale = Math.exp(meanLog);
    for (const i of items) next.set(i, next.get(i) / scale);

    let delta = 0;
    for (const i of items) {
      delta = Math.max(delta, Math.abs(Math.log(next.get(i)) - Math.log(p.get(i))));
    }
    p = next;
    if (delta < tolerance) {
      converged = true;
      break;
    }
  }

  const strengths = Object.fromEntries(items.map((i) => [i, p.get(i)]));
  const totalStrength = items.reduce((s, i) => s + p.get(i), 0);

  const sorted = [...items].sort((a, b) => p.get(b) - p.get(a) || String(a).localeCompare(String(b)));

  const ranking = sorted.map((id, idx) => {
    const comparisons = wins.get(id) + losses.get(id);
    // Gap to nearest neighbor in log-strength — small gap = uncertain ordering locally.
    const gaps = [];
    if (idx > 0) gaps.push(Math.abs(Math.log(p.get(sorted[idx - 1])) - Math.log(p.get(id))));
    if (idx < sorted.length - 1) gaps.push(Math.abs(Math.log(p.get(id)) - Math.log(p.get(sorted[idx + 1]))));
    const gap = gaps.length ? Math.min(...gaps) : 1;
    // Simple confidence in [0,1): more comparisons and a wider gap to neighbors = higher.
    const confidence = (comparisons / (comparisons + 5)) * (gap / (gap + 0.5));
    return {
      id,
      rank: idx + 1,
      strength: p.get(id),
      score: p.get(id) / totalStrength,
      wins: wins.get(id),
      losses: losses.get(id),
      comparisons,
      confidence,
    };
  });

  return {
    strengths,
    ranking,
    judgeAgreement: judgeAgreement(results, strengths),
    iterations,
    converged,
  };
}

/**
 * How often each judge's individual votes agree with the final global ranking.
 * A judge far below the pack is flagged as an outlier (confused, biased, or
 * judging a genuinely different dimension).
 */
export function judgeAgreement(results, strengths) {
  const perJudge = new Map();
  for (const { winner, loser, judge } of results) {
    const j = judge ?? "(unknown)";
    if (!perJudge.has(j)) perJudge.set(j, { total: 0, agreed: 0 });
    const s = perJudge.get(j);
    s.total += 1;
    if (strengths[winner] > strengths[loser]) s.agreed += 1;
  }

  const rates = [...perJudge.values()].map((s) => s.agreed / s.total);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const sd = Math.sqrt(rates.reduce((a, r) => a + (r - mean) ** 2, 0) / rates.length);

  const out = {};
  for (const [j, s] of perJudge) {
    const rate = s.agreed / s.total;
    out[j] = {
      total: s.total,
      agreed: s.agreed,
      rate,
      outlier: s.total >= 5 && (rate < 0.5 || rate < mean - 2 * sd),
    };
  }
  return out;
}

/**
 * Kendall tau rank correlation between two orderings (arrays of ids, best first).
 * 1 = identical order, -1 = fully reversed, ~0 = unrelated.
 * Computed over the intersection of items.
 */
export function kendallTau(orderA, orderB) {
  const posB = new Map(orderB.map((id, i) => [id, i]));
  const common = orderA.filter((id) => posB.has(id));
  const n = common.length;
  if (n < 2) return 0;

  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = posB.get(common[i]) - posB.get(common[j]);
      if (d < 0) concordant++;
      else if (d > 0) discordant++;
    }
  }
  return (concordant - discordant) / ((n * (n - 1)) / 2);
}
