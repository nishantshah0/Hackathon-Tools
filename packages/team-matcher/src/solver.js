/**
 * Team formation solver.
 *
 * 1. Precompute UTC availability intervals and the pairwise-overlap
 *    compatibility graph (pair is compatible iff overlap >= minOverlapHours).
 * 2. Greedy seeding: repeatedly seed a team with the hardest-to-place
 *    remaining participant, then grow it with the compatible candidate that
 *    maximizes the team's soft score (interest cohesion, role coverage, ...).
 * 3. Simulated annealing over swap / move / place operations, rejecting any
 *    move that violates a hard constraint. Deterministic via mulberry32(seed).
 * 4. Emit teams with score breakdowns + explanations, and unassigned
 *    participants with reasons.
 */

import { mulberry32, randInt } from './prng.js';
import {
  participantUtcIntervals,
  overlapHours,
  intersectIntervals,
  formatHourUtc,
} from './timezone.js';
import { teamScore, DEFAULT_WEIGHTS } from './scoring.js';

export const DEFAULT_OPTIONS = {
  minSize: 3,
  maxSize: 4,
  minOverlapHours: 4,
  seed: 42,
  iterations: null, // auto-scaled from participant count when null
  weights: DEFAULT_WEIGHTS,
};

const UNASSIGNED_PENALTY = 2; // objective cost per unassigned participant

export function matchTeams(participants, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { minSize, maxSize, minOverlapHours, seed, weights } = opts;

  validateInputs(participants, opts);

  const n = participants.length;
  const intervals = participants.map((p) => participantUtcIntervals(p));

  // Pairwise overlap + compatibility graph.
  const overlap = Array.from({ length: n }, () => new Float64Array(n));
  const compatible = Array.from({ length: n }, () => new Uint8Array(n));
  const compatCount = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const h = overlapHours(intervals[i], intervals[j]);
      overlap[i][j] = overlap[j][i] = h;
      if (h >= minOverlapHours - 1e-9) {
        compatible[i][j] = compatible[j][i] = 1;
        compatCount[i]++;
        compatCount[j]++;
      }
    }
  }

  const members = (idxs) => idxs.map((i) => participants[i]);
  const scoreOf = (idxs) => teamScore(members(idxs), weights).total;

  const teamIsCompatible = (idxs) => {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (!compatible[idxs[a]][idxs[b]]) return false;
      }
    }
    return true;
  };

  // ---- Phase 1: greedy seeding (hardest-to-place participants first) ----
  const { teams, unassigned } = greedySeed({
    n,
    minSize,
    maxSize,
    compatible,
    compatCount,
    scoreOf,
  });

  // ---- Phase 2: simulated annealing / local search ----
  anneal({
    teams,
    unassigned,
    minSize,
    maxSize,
    scoreOf,
    teamIsCompatible,
    compatible,
    rng: mulberry32(seed),
    iterations: opts.iterations ?? autoIterations(n),
  });

  // ---- Phase 3: last-chance placement of unassigned participants ----
  rescueUnassigned({ teams, unassigned, maxSize, minSize, compatible, compatCount, scoreOf });

  // ---- Build output ----
  return buildResult({
    participants,
    intervals,
    teams,
    unassigned,
    compatCount,
    minSize,
    minOverlapHours,
    weights,
    seed,
    opts,
  });
}

function validateInputs(participants, opts) {
  if (!Array.isArray(participants)) {
    throw new Error('participants must be an array');
  }
  const seen = new Set();
  for (const p of participants) {
    if (p.id == null) throw new Error('every participant needs an "id"');
    if (seen.has(p.id)) throw new Error(`duplicate participant id: "${p.id}"`);
    seen.add(p.id);
    if (typeof p.timezone !== 'string') {
      throw new Error(`participant "${p.id}" is missing an IANA "timezone"`);
    }
  }
  if (!Number.isInteger(opts.minSize) || opts.minSize < 2) {
    throw new Error(`minSize must be an integer >= 2 (got ${opts.minSize})`);
  }
  if (!Number.isInteger(opts.maxSize) || opts.maxSize < opts.minSize) {
    throw new Error(`maxSize must be an integer >= minSize (got ${opts.maxSize})`);
  }
  if (!(opts.minOverlapHours >= 0) || opts.minOverlapHours > 24) {
    throw new Error(`minOverlapHours must be within [0, 24] (got ${opts.minOverlapHours})`);
  }
}

function autoIterations(n) {
  return Math.min(60_000, Math.max(8_000, n * 250));
}

function greedySeed({ n, minSize, maxSize, compatible, compatCount, scoreOf }) {
  const pool = new Set(Array.from({ length: n }, (_, i) => i));
  const teams = [];
  const unassigned = [];

  while (pool.size > 0) {
    // Seed with the hardest-to-place participant (fewest compatible partners).
    let seedIdx = -1;
    for (const i of pool) {
      if (
        seedIdx === -1 ||
        compatCount[i] < compatCount[seedIdx] ||
        (compatCount[i] === compatCount[seedIdx] && i < seedIdx)
      ) {
        seedIdx = i;
      }
    }
    pool.delete(seedIdx);
    const team = [seedIdx];

    while (team.length < maxSize) {
      let best = -1;
      let bestScore = -Infinity;
      // Iterate candidates in ascending index order for determinism.
      const candidates = [...pool].sort((a, b) => a - b);
      for (const c of candidates) {
        let ok = true;
        for (const m of team) {
          if (!compatible[m][c]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const s = scoreOf([...team, c]);
        if (s > bestScore + 1e-12) {
          bestScore = s;
          best = c;
        }
      }
      if (best === -1) break;
      team.push(best);
      pool.delete(best);
    }

    if (team.length >= minSize) {
      teams.push(team);
    } else {
      // Dissolve: seed is set aside; the rest go back to the pool.
      unassigned.push(seedIdx);
      for (const m of team.slice(1)) pool.add(m);
    }
  }

  return { teams, unassigned };
}

function anneal({
  teams,
  unassigned,
  minSize,
  maxSize,
  scoreOf,
  teamIsCompatible,
  rng,
  iterations,
}) {
  if (teams.length === 0) return;

  const teamScores = teams.map((t) => scoreOf(t));
  const T0 = 0.35;
  const T1 = 0.001;
  const cooling = Math.pow(T1 / T0, 1 / Math.max(1, iterations - 1));
  let temperature = T0;

  for (let iter = 0; iter < iterations; iter++, temperature *= cooling) {
    const op = randInt(rng, 4);

    if (op === 0 && teams.length >= 2) {
      // Swap one member between two distinct teams.
      const a = randInt(rng, teams.length);
      let b = randInt(rng, teams.length - 1);
      if (b >= a) b++;
      const ai = randInt(rng, teams[a].length);
      const bi = randInt(rng, teams[b].length);
      const newA = teams[a].slice();
      const newB = teams[b].slice();
      [newA[ai], newB[bi]] = [newB[bi], newA[ai]];
      if (!teamIsCompatible(newA) || !teamIsCompatible(newB)) continue;
      const sA = scoreOf(newA);
      const sB = scoreOf(newB);
      const delta = sA + sB - teamScores[a] - teamScores[b];
      if (accept(delta, temperature, rng)) {
        teams[a] = newA;
        teams[b] = newB;
        teamScores[a] = sA;
        teamScores[b] = sB;
      }
    } else if (op === 1 && teams.length >= 2) {
      // Move a member from one team to another.
      const a = randInt(rng, teams.length);
      let b = randInt(rng, teams.length - 1);
      if (b >= a) b++;
      if (teams[a].length - 1 < minSize || teams[b].length + 1 > maxSize) continue;
      const ai = randInt(rng, teams[a].length);
      const moved = teams[a][ai];
      const newA = teams[a].filter((_, k) => k !== ai);
      const newB = [...teams[b], moved];
      if (!teamIsCompatible(newB)) continue;
      const sA = scoreOf(newA);
      const sB = scoreOf(newB);
      const delta = sA + sB - teamScores[a] - teamScores[b];
      if (accept(delta, temperature, rng)) {
        teams[a] = newA;
        teams[b] = newB;
        teamScores[a] = sA;
        teamScores[b] = sB;
      }
    } else if (op === 2 && unassigned.length > 0) {
      // Swap a team member with an unassigned participant (sizes unchanged).
      const a = randInt(rng, teams.length);
      const ai = randInt(rng, teams[a].length);
      const ui = randInt(rng, unassigned.length);
      const newA = teams[a].slice();
      const benched = newA[ai];
      newA[ai] = unassigned[ui];
      if (!teamIsCompatible(newA)) continue;
      const sA = scoreOf(newA);
      const delta = sA - teamScores[a];
      if (accept(delta, temperature, rng)) {
        teams[a] = newA;
        teamScores[a] = sA;
        unassigned[ui] = benched;
      }
    } else if (op === 3 && unassigned.length > 0) {
      // Place an unassigned participant into a team with room.
      const a = randInt(rng, teams.length);
      if (teams[a].length + 1 > maxSize) continue;
      const ui = randInt(rng, unassigned.length);
      const newA = [...teams[a], unassigned[ui]];
      if (!teamIsCompatible(newA)) continue;
      const sA = scoreOf(newA);
      const delta = sA - teamScores[a] + UNASSIGNED_PENALTY;
      if (accept(delta, temperature, rng)) {
        teams[a] = newA;
        teamScores[a] = sA;
        unassigned.splice(ui, 1);
      }
    }
  }
}

function accept(delta, temperature, rng) {
  if (delta > 0) return true;
  return rng() < Math.exp(delta / temperature);
}

function rescueUnassigned({ teams, unassigned, maxSize, minSize, compatible, compatCount, scoreOf }) {
  // Deterministic final pass: try to slot each unassigned participant into
  // the team (with room) where they raise the score most.
  for (let u = unassigned.length - 1; u >= 0; u--) {
    const idx = unassigned[u];
    let bestTeam = -1;
    let bestScore = -Infinity;
    for (let t = 0; t < teams.length; t++) {
      if (teams[t].length >= maxSize) continue;
      if (!teams[t].every((m) => compatible[m][idx])) continue;
      const s = scoreOf([...teams[t], idx]);
      if (s > bestScore + 1e-12) {
        bestScore = s;
        bestTeam = t;
      }
    }
    if (bestTeam !== -1) {
      teams[bestTeam] = [...teams[bestTeam], idx];
      unassigned.splice(u, 1);
    }
  }

  // The leftovers themselves might form a valid team (e.g. a late-arriving
  // timezone cluster). Try a mini greedy pass over them.
  if (unassigned.length >= minSize) {
    const pool = new Set(unassigned.slice().sort((a, b) => a - b));
    while (pool.size >= minSize) {
      let seedIdx = -1;
      for (const i of pool) {
        if (
          seedIdx === -1 ||
          compatCount[i] < compatCount[seedIdx] ||
          (compatCount[i] === compatCount[seedIdx] && i < seedIdx)
        ) {
          seedIdx = i;
        }
      }
      pool.delete(seedIdx);
      const team = [seedIdx];
      while (team.length < maxSize) {
        let best = -1;
        let bestScore = -Infinity;
        for (const c of [...pool].sort((a, b) => a - b)) {
          if (!team.every((m) => compatible[m][c])) continue;
          const s = scoreOf([...team, c]);
          if (s > bestScore + 1e-12) {
            bestScore = s;
            best = c;
          }
        }
        if (best === -1) break;
        team.push(best);
        pool.delete(best);
      }
      if (team.length >= minSize) {
        teams.push(team);
        for (const m of team) {
          const at = unassigned.indexOf(m);
          if (at !== -1) unassigned.splice(at, 1);
        }
      }
      // If the team failed, seedIdx stays out of the pool (still unassigned),
      // and its picked partners were only those compatible — return them:
      else {
        for (const m of team.slice(1)) pool.add(m);
      }
    }
  }
}

function buildResult({
  participants,
  intervals,
  teams,
  unassigned,
  compatCount,
  minSize,
  minOverlapHours,
  weights,
  seed,
  opts,
}) {
  const round3 = (x) => Math.round(x * 1000) / 1000;

  const teamObjects = teams
    .map((idxs) => {
      const memberList = idxs
        .slice()
        .sort((a, b) => a - b)
        .map((i) => participants[i]);
      const score = teamScore(memberList, weights);
      return { idxs, memberList, score };
    })
    .sort((a, b) => b.score.total - a.score.total || a.idxs[0] - b.idxs[0])
    .map(({ idxs, memberList, score }, rank) => {
      const window = commonWindow(idxs, intervals);
      return {
        id: `team-${rank + 1}`,
        members: memberList.map((p) => ({
          id: p.id,
          name: p.name,
          roles: p.roles ?? [],
          timezone: p.timezone,
          experience: p.experience,
        })),
        score: {
          roleCoverage: round3(score.roleCoverage),
          interestCohesion: round3(score.interestCohesion),
          skillComplementarity: round3(score.skillComplementarity),
          experienceBalance: round3(score.experienceBalance),
          total: round3(score.total),
        },
        overlapWindowUtc: window,
        explanation: explain(memberList, window, minOverlapHours),
      };
    });

  const unassignedObjects = unassigned
    .slice()
    .sort((a, b) => a - b)
    .map((i) => {
      const p = participants[i];
      let reason;
      if (compatCount[i] < minSize - 1) {
        reason =
          `only ${compatCount[i]} other participant(s) share >= ${minOverlapHours}h of ` +
          `daily availability overlap; a team of ${minSize} needs at least ${minSize - 1}`;
      } else {
        reason = 'no valid team assignment found without violating size or overlap constraints';
      }
      return { id: p.id, name: p.name, timezone: p.timezone, reason };
    });

  const assignedCount = teamObjects.reduce((s, t) => s + t.members.length, 0);
  const meanScore =
    teamObjects.length > 0
      ? round3(teamObjects.reduce((s, t) => s + t.score.total, 0) / teamObjects.length)
      : 0;

  return {
    teams: teamObjects,
    unassigned: unassignedObjects,
    stats: {
      totalParticipants: participants.length,
      assigned: assignedCount,
      unassigned: unassignedObjects.length,
      teamCount: teamObjects.length,
      meanTeamScore: meanScore,
      seed,
      teamSize: { min: opts.minSize, max: opts.maxSize },
      minOverlapHours,
    },
  };
}

function commonWindow(idxs, intervals) {
  let common = intervals[idxs[0]];
  for (let k = 1; k < idxs.length; k++) {
    common = intersectIntervals(common, intervals[idxs[k]]);
    if (common.length === 0) return null;
  }
  // Report the longest shared block.
  let best = common[0];
  for (const iv of common) {
    if (iv[1] - iv[0] > best[1] - best[0]) best = iv;
  }
  return `${formatHourUtc(best[0])}–${formatHourUtc(best[1])} UTC`;
}

function explain(memberList, window, minOverlapHours) {
  // Interests shared by at least two members, most common first.
  const counts = new Map();
  for (const m of memberList) {
    for (const interest of new Set(m.interests ?? [])) {
      counts.set(interest, (counts.get(interest) ?? 0) + 1);
    }
  }
  const shared = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([interest]) => interest);

  const roles = [...new Set(memberList.flatMap((m) => m.roles ?? []))].sort();

  const matchedOn = shared.length > 0 ? shared.join(', ') : 'complementary interests';
  const windowText = window
    ? `Overlap window: ${window}.`
    : `Pairwise overlap >= ${minOverlapHours}h (no single window shared by all members).`;
  return `Matched on: ${matchedOn}. Roles: ${roles.join(', ')}. ${windowText}`;
}
