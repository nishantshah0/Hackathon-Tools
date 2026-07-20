#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { matchTeams } from '../src/index.js';

const USAGE = `team-matcher — form balanced remote hackathon teams

Usage:
  team-matcher match <participants.json> [options]

Options:
  --team-size <min-max>   team size range, e.g. 3-4 or a single number (default 3-4)
  --min-overlap <hours>   required pairwise daily availability overlap in UTC hours (default 4)
  --seed <n>              PRNG seed for deterministic output (default 42)
  --iterations <n>        annealing iterations (default: auto-scaled)
  --json                  emit machine-readable JSON instead of tables
  -h, --help              show this help
`;

function fail(message) {
  process.stderr.write(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { command: null, file: null, json: false, options: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i++;
      if (i >= argv.length) fail(`missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case '--json':
        args.json = true;
        break;
      case '--team-size': {
        const raw = next();
        const m = /^(\d+)(?:-(\d+))?$/.exec(raw);
        if (!m) fail(`--team-size expects "min-max" or a single number, got "${raw}"`);
        args.options.minSize = Number(m[1]);
        args.options.maxSize = Number(m[2] ?? m[1]);
        break;
      }
      case '--min-overlap': {
        const v = Number(next());
        if (!Number.isFinite(v)) fail('--min-overlap expects a number of hours');
        args.options.minOverlapHours = v;
        break;
      }
      case '--seed': {
        const v = Number(next());
        if (!Number.isInteger(v)) fail('--seed expects an integer');
        args.options.seed = v;
        break;
      }
      case '--iterations': {
        const v = Number(next());
        if (!Number.isInteger(v) || v < 0) fail('--iterations expects a non-negative integer');
        args.options.iterations = v;
        break;
      }
      default:
        if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }
  args.command = positional[0] ?? null;
  args.file = positional[1] ?? null;
  return args;
}

function table(rows, headers) {
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => String(r[c]).length))
  );
  const line = (cells) => cells.map((cell, c) => String(cell).padEnd(widths[c])).join('  ');
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

function printPretty(result) {
  const { teams, unassigned, stats } = result;
  const lines = [];
  for (const team of teams) {
    lines.push(`${team.id}  (score ${team.score.total.toFixed(3)})`);
    lines.push(`  ${team.explanation}`);
    lines.push(
      '  ' +
        table(
          team.members.map((m) => [
            m.name,
            m.roles.join('/'),
            m.timezone,
            `exp ${m.experience}`,
          ]),
          ['member', 'roles', 'timezone', 'experience']
        )
          .split('\n')
          .join('\n  ')
    );
    const s = team.score;
    lines.push(
      `  breakdown: roles ${s.roleCoverage.toFixed(2)} | interests ${s.interestCohesion.toFixed(2)}` +
        ` | skills ${s.skillComplementarity.toFixed(2)} | experience ${s.experienceBalance.toFixed(2)}`
    );
    lines.push('');
  }

  if (unassigned.length > 0) {
    lines.push('Unassigned:');
    for (const u of unassigned) {
      lines.push(`  - ${u.name} (${u.id}, ${u.timezone}): ${u.reason}`);
    }
    lines.push('');
  }

  lines.push(
    `${stats.teamCount} teams | ${stats.assigned}/${stats.totalParticipants} assigned | ` +
      `mean score ${stats.meanTeamScore.toFixed(3)} | seed ${stats.seed} | ` +
      `size ${stats.teamSize.min}-${stats.teamSize.max} | min overlap ${stats.minOverlapHours}h`
  );
  process.stdout.write(lines.join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== 'match') {
    fail(args.command ? `unknown command: ${args.command}` : 'missing command');
  }
  if (!args.file) fail('missing participants file');

  let participants;
  try {
    participants = JSON.parse(readFileSync(args.file, 'utf8'));
  } catch (err) {
    fail(`cannot read "${args.file}": ${err.message}`);
  }

  let result;
  try {
    result = matchTeams(participants, args.options);
  } catch (err) {
    fail(err.message);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    printPretty(result);
  }
}

main();
