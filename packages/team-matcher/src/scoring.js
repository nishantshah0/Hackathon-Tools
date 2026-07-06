/**
 * Soft-objective scoring for candidate teams.
 * Every component is normalized to [0, 1]; the total is a weighted sum
 * with weights that also sum to 1, so team scores are directly comparable.
 */

export const FRONTENDISH_ROLES = new Set(['frontend', 'design', 'mobile']);
export const BACKENDISH_ROLES = new Set(['backend', 'infra', 'ml', 'data']);

export const DEFAULT_WEIGHTS = {
  roleCoverage: 0.3,
  interestCohesion: 0.3,
  skillComplementarity: 0.2,
  experienceBalance: 0.2,
};

/** Jaccard similarity of two iterables. Both empty -> 0. */
export function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let intersection = 0;
  for (const x of sa) if (sb.has(x)) intersection++;
  const union = sa.size + sb.size - intersection;
  return intersection / union;
}

/**
 * Role coverage: rewards distinct roles across the team, with explicit
 * bonuses for having at least one frontend-ish (frontend/design/mobile)
 * and one backend-ish (backend/infra/ml/data) member.
 */
export function roleCoverage(team) {
  if (team.length === 0) return 0;
  const distinct = new Set();
  let hasFrontendish = false;
  let hasBackendish = false;
  for (const member of team) {
    for (const role of member.roles ?? []) {
      distinct.add(role);
      if (FRONTENDISH_ROLES.has(role)) hasFrontendish = true;
      if (BACKENDISH_ROLES.has(role)) hasBackendish = true;
    }
  }
  const base = Math.min(1, distinct.size / team.length);
  return 0.5 * base + (hasFrontendish ? 0.25 : 0) + (hasBackendish ? 0.25 : 0);
}

/** Interest cohesion: mean pairwise Jaccard similarity of interests. */
export function interestCohesion(team) {
  if (team.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      sum += jaccard(team[i].interests ?? [], team[j].interests ?? []);
      pairs++;
    }
  }
  return sum / pairs;
}

/**
 * Skill complementarity: unique skills / total skill mentions.
 * 1.0 when nobody duplicates a skill; approaches 1/teamSize when everyone
 * brings the identical skill set.
 */
export function skillComplementarity(team) {
  let total = 0;
  const unique = new Set();
  for (const member of team) {
    for (const skill of member.skills ?? []) {
      total++;
      unique.add(skill);
    }
  }
  if (total === 0) return 0;
  return unique.size / total;
}

/**
 * Experience balance: half the credit for spread (mix of levels), half for
 * the team mean sitting near the middle of the 1-5 scale. All-novice (all 1s)
 * and all-expert (all 5s) both score 0.
 */
export function experienceBalance(team) {
  if (team.length === 0) return 0;
  const exps = team.map((m) => m.experience ?? 3);
  const mean = exps.reduce((a, b) => a + b, 0) / exps.length;
  const spread = (Math.max(...exps) - Math.min(...exps)) / 4;
  const centered = 1 - Math.abs(mean - 3) / 2;
  const score = 0.5 * spread + 0.5 * centered;
  return Math.max(0, Math.min(1, score));
}

/** Full per-team score breakdown plus weighted total. */
export function teamScore(team, weights = DEFAULT_WEIGHTS) {
  const breakdown = {
    roleCoverage: roleCoverage(team),
    interestCohesion: interestCohesion(team),
    skillComplementarity: skillComplementarity(team),
    experienceBalance: experienceBalance(team),
  };
  let total = 0;
  for (const [key, value] of Object.entries(breakdown)) {
    total += (weights[key] ?? 0) * value;
  }
  return { ...breakdown, total };
}
