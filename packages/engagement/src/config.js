// Config loading + normalization.

import { readFileSync, existsSync } from 'node:fs';
import { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, DEFAULT_HALF_LIFE_MS } from './score.js';

/**
 * Normalize a raw config object:
 * {
 *   teams: [{ id, name?, repos?: ["org/repo"], members?: [] }],
 *   thresholds: { active, dark, darkAfterMinutes },
 *   halfLifeHours: 3,
 *   weights: { commit, discord_message, portal_login, checkin, ... }
 * }
 */
export function normalizeConfig(raw = {}) {
  const teams = (raw.teams ?? []).map((t) => ({
    id: String(t.id),
    name: t.name ?? String(t.id),
    repos: t.repos ?? [],
    members: t.members ?? [],
  }));
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const repoToTeam = new Map();
  for (const t of teams) {
    for (const repo of t.repos) repoToTeam.set(repo.toLowerCase(), t.id);
  }
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) };
  const halfLifeMs =
    typeof raw.halfLifeHours === 'number' && raw.halfLifeHours > 0
      ? raw.halfLifeHours * 3_600_000
      : DEFAULT_HALF_LIFE_MS;
  const weights = { ...DEFAULT_WEIGHTS, ...(raw.weights ?? {}) };
  return { teams, teamsById, repoToTeam, thresholds, halfLifeMs, weights };
}

export function loadConfig(path) {
  if (!path || !existsSync(path)) return normalizeConfig({});
  return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')));
}
