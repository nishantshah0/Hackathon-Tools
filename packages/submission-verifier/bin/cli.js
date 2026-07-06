#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { verify } from '../src/index.js';
import { renderMarkdown, renderTerminal } from '../src/report.js';

const USAGE = `submission-verifier — git forensics for hackathon rule enforcement

Usage:
  submission-verifier verify <path-to-repo> --start <ISO datetime> --end <ISO datetime> [options]

Options:
  --start <iso>          Event start (required), e.g. 2026-07-04T09:00:00Z
  --end <iso>            Event end / submission deadline (required)
  --grace-minutes <n>    Post-deadline grace period (default 15)
  --team-size <n>        Declared team size, enables contributor comparison
  --warn-lines <n>       Initial-commit warn threshold in added lines (default 2000)
  --high-lines <n>       Initial-commit high threshold in added lines (default 10000)
  --json                 Print machine-readable JSON to stdout
  --markdown [file]      Write a markdown report (default: report.md in cwd)
  --help                 Show this help
`;

function fail(msg) {
  process.stderr.write(`error: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        start: { type: 'string' },
        end: { type: 'string' },
        'grace-minutes': { type: 'string', default: '15' },
        'team-size': { type: 'string' },
        'warn-lines': { type: 'string', default: '2000' },
        'high-lines': { type: 'string', default: '10000' },
        json: { type: 'boolean', default: false },
        markdown: { type: 'boolean', default: false },
        'markdown-file': { type: 'string', default: 'report.md' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    fail(err.message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const [command, repoArg] = positionals;
  if (command !== 'verify') fail(`unknown command "${command ?? ''}" (expected "verify")`);
  if (!repoArg) fail('missing <path-to-repo>');
  if (!values.start || !values.end) fail('--start and --end are required');

  const num = (name) => {
    if (values[name] === undefined) return null;
    const n = Number(values[name]);
    if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative number`);
    return n;
  };

  let result;
  try {
    result = await verify(resolve(repoArg), {
      start: new Date(values.start),
      end: new Date(values.end),
      graceMinutes: num('grace-minutes'),
      warnLines: num('warn-lines'),
      highLines: num('high-lines'),
      teamSize: num('team-size'),
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTerminal(result)}\n`);
  }
  if (values.markdown) {
    const outPath = resolve(values['markdown-file']);
    await writeFile(outPath, renderMarkdown(result));
    process.stderr.write(`markdown report written to ${outPath}\n`);
  }
}

main();
