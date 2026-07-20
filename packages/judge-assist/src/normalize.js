// Rubric score normalization. Pure math, zero deps.
//
// Problem: judges see different subsets of projects and use different personal
// scales — a harsh judge's 6 can mean the same as a generous judge's 9. Averaging
// raw scores rewards projects that happened to draw generous judges.
//
// Fix: per-judge z-score normalization. For each judge, compute the mean and
// standard deviation of the scores THEY gave, and re-express each of their scores
// as z = (score - judgeMean) / judgeStd — i.e. "how far above/below this judge's
// own average was this project". A project's normalized score is the mean z
// across the judges who scored it, so every judge's opinion carries equal weight
// regardless of how harsh or generous their raw numbers are.
//
// Criteria: when scores carry a `criterion`, normalization happens per
// (judge, criterion) — a judge may be harsh on "technical" but generous on
// "design" — then a project's per-criterion z-means are combined with equal
// weights (or caller-supplied weights).
//
// Small-sample guard: a judge's own mean/std estimated from fewer than
// `minSamples` (default 3) scores is unreliable, so it is shrunk toward the
// global (all-judges) mean/std for that criterion:
//     lambda = n / minSamples          (n = scores this judge gave)
//     mean'  = lambda * judgeMean + (1 - lambda) * globalMean
//     std'   = lambda * judgeStd  + (1 - lambda) * globalStd
// Judges with n >= minSamples use their own stats unshrunk.
//
// stddev = 0 (judge gave every project the same score) → z = 0: that judge
// expressed no preference, so they contribute no signal.

const OVERALL = "__overall__";

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs, m = mean(xs)) {
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

/**
 * normalizeScores(scores, {weights, minSamples})
 * scores: [{judge, project, criterion?, score}]
 * weights: optional {criterion: weight} (equal weights when omitted)
 *
 * Returns {
 *   projects: [{project, rawMean, normalizedScore, rawRank, normalizedRank,
 *               rankChange, judgeCount}],   // sorted by normalizedRank
 *   judges:   [{judge, count, mean, std, leniencyRank, shrunk}],
 *   criteria: [names...]
 * }
 */
export function normalizeScores(scores, { weights = null, minSamples = 3 } = {}) {
  if (!scores?.length) throw new Error("No scores provided");
  for (const s of scores) {
    if (typeof s.score !== "number" || Number.isNaN(s.score)) {
      throw new Error(`Non-numeric score for judge=${s.judge} project=${s.project}`);
    }
  }

  const crit = (s) => s.criterion ?? OVERALL;
  const criteria = [...new Set(scores.map(crit))];

  // --- global stats per criterion (shrinkage target) ---
  const globalStats = new Map();
  for (const c of criteria) {
    const xs = scores.filter((s) => crit(s) === c).map((s) => s.score);
    const m = mean(xs);
    globalStats.set(c, { mean: m, std: stddev(xs, m) });
  }

  // --- per (judge, criterion) calibration, with small-sample shrinkage ---
  const SEP = "\u0000"; // judge names may contain spaces; NUL cannot
  const groups = new Map(); // key: judge + SEP + criterion
  for (const s of scores) {
    const key = s.judge + SEP + crit(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.score);
  }
  const calibration = new Map(); // same key -> {mean, std, shrunk}
  for (const [key, xs] of groups) {
    const c = key.split(SEP)[1];
    const g = globalStats.get(c);
    const m = mean(xs);
    const sd = stddev(xs, m);
    if (xs.length >= minSamples) {
      calibration.set(key, { mean: m, std: sd, shrunk: false });
    } else {
      const lambda = xs.length / minSamples;
      calibration.set(key, {
        mean: lambda * m + (1 - lambda) * g.mean,
        std: lambda * sd + (1 - lambda) * g.std,
        shrunk: true,
      });
    }
  }

  // --- z-transform every score ---
  const zScores = scores.map((s) => {
    const cal = calibration.get(s.judge + SEP + crit(s));
    const z = cal.std > 1e-9 ? (s.score - cal.mean) / cal.std : 0;
    return { ...s, criterion: crit(s), z };
  });

  // --- aggregate per (project, criterion): mean z and mean raw ---
  const projects = [...new Set(scores.map((s) => s.project))];
  const byProject = new Map(projects.map((p) => [p, { z: new Map(), raw: new Map(), judges: new Set() }]));
  for (const s of zScores) {
    const agg = byProject.get(s.project);
    if (!agg.z.has(s.criterion)) {
      agg.z.set(s.criterion, []);
      agg.raw.set(s.criterion, []);
    }
    agg.z.get(s.criterion).push(s.z);
    agg.raw.get(s.criterion).push(s.score);
    agg.judges.add(s.judge);
  }

  // --- combine criteria per project (equal or caller weights) ---
  const weightOf = (c) => (weights ? weights[c] ?? 1 : 1);
  const rows = projects.map((project) => {
    const agg = byProject.get(project);
    let zSum = 0;
    let rawSum = 0;
    let wSum = 0;
    for (const [c, zs] of agg.z) {
      const w = weightOf(c);
      zSum += w * mean(zs);
      rawSum += w * mean(agg.raw.get(c));
      wSum += w;
    }
    return {
      project,
      rawMean: rawSum / wSum,
      normalizedScore: zSum / wSum,
      judgeCount: agg.judges.size,
    };
  });

  // --- ranks and rank movement (the money shot) ---
  const byRaw = [...rows].sort((a, b) => b.rawMean - a.rawMean || a.project.localeCompare(b.project));
  const byNorm = [...rows].sort(
    (a, b) => b.normalizedScore - a.normalizedScore || a.project.localeCompare(b.project)
  );
  const rawRank = new Map(byRaw.map((r, i) => [r.project, i + 1]));
  byNorm.forEach((r, i) => {
    r.rawRank = rawRank.get(r.project);
    r.normalizedRank = i + 1;
    r.rankChange = r.rawRank - r.normalizedRank; // positive = moved up after normalization
  });

  // --- per-judge calibration report (pooled across criteria) ---
  const judgeNames = [...new Set(scores.map((s) => s.judge))];
  const judgeRows = judgeNames.map((judge) => {
    const xs = scores.filter((s) => s.judge === judge).map((s) => s.score);
    const m = mean(xs);
    return {
      judge,
      count: xs.length,
      mean: m,
      std: stddev(xs, m),
      shrunk: criteria.some((c) => calibration.get(judge + SEP + c)?.shrunk),
    };
  });
  [...judgeRows]
    .sort((a, b) => b.mean - a.mean || a.judge.localeCompare(b.judge))
    .forEach((r, i) => {
      r.leniencyRank = i + 1; // 1 = most generous
    });

  return {
    projects: byNorm,
    judges: judgeRows.sort((a, b) => a.leniencyRank - b.leniencyRank),
    criteria: criteria.map((c) => (c === OVERALL ? "overall" : c)),
  };
}
