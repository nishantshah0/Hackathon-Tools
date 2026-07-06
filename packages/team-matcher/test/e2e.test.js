import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { matchTeams, participantUtcIntervals, overlapHours } from '../src/index.js';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examplePath = path.join(pkgRoot, 'examples', 'participants.json');
const cliPath = path.join(pkgRoot, 'bin', 'cli.js');
const participants = JSON.parse(readFileSync(examplePath, 'utf8'));

test('end-to-end: matcher on sample data produces valid, explained teams', () => {
  const result = matchTeams(participants, { seed: 42 });
  const byId = new Map(participants.map((p) => [p.id, p]));

  assert.ok(result.teams.length >= 4, 'expected several teams from 24 participants');

  const seen = new Set();
  for (const team of result.teams) {
    assert.ok(team.members.length >= 3 && team.members.length <= 4);
    const intervals = team.members.map((m) => participantUtcIntervals(byId.get(m.id)));
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        assert.ok(overlapHours(intervals[i], intervals[j]) >= 4 - 1e-9);
      }
    }
    for (const m of team.members) {
      assert.ok(!seen.has(m.id));
      seen.add(m.id);
    }
    // Score breakdown and explanation present.
    assert.ok(team.score.total >= 0 && team.score.total <= 1);
    assert.match(team.explanation, /^Matched on: .+ Roles: .+/);
    for (const key of ['roleCoverage', 'interestCohesion', 'skillComplementarity', 'experienceBalance']) {
      assert.equal(typeof team.score[key], 'number');
    }
  }

  // The deliberately narrow-window participant (p24, 22:00-24:00 local) is unassigned.
  const isla = result.unassigned.find((u) => u.id === 'p24');
  assert.ok(isla, 'p24 should be unassigned (2h window < 4h required overlap)');
  assert.match(isla.reason, /only \d+ other participant/);

  assert.equal(
    result.stats.assigned + result.stats.unassigned,
    result.stats.totalParticipants
  );
  // Most people should be placed.
  assert.ok(result.stats.assigned >= 20);
});

test('CLI --json output is parseable and matches the library result', () => {
  const stdout = execFileSync(
    process.execPath,
    [cliPath, 'match', examplePath, '--team-size', '3-4', '--min-overlap', '4', '--seed', '42', '--json'],
    { encoding: 'utf8' }
  );
  const cliResult = JSON.parse(stdout);
  const libResult = matchTeams(participants, {
    minSize: 3,
    maxSize: 4,
    minOverlapHours: 4,
    seed: 42,
  });
  assert.deepEqual(cliResult, libResult);
});

test('CLI pretty output renders team tables and a summary line', () => {
  const stdout = execFileSync(
    process.execPath,
    [cliPath, 'match', examplePath, '--seed', '42'],
    { encoding: 'utf8' }
  );
  assert.match(stdout, /team-1\s+\(score \d\.\d{3}\)/);
  assert.match(stdout, /Matched on:/);
  assert.match(stdout, /member\s+roles\s+timezone\s+experience/);
  assert.match(stdout, /teams \| \d+\/24 assigned/);
  assert.match(stdout, /Unassigned:/);
});

test('CLI errors cleanly on bad input', () => {
  assert.throws(() =>
    execFileSync(process.execPath, [cliPath, 'match', 'no-such-file.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  assert.throws(() =>
    execFileSync(process.execPath, [cliPath, 'shuffle', examplePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
});
