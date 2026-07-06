import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { START, END, at, cleanup, commit, lines, makeCleanRepo, makeRepo } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const windowArgs = ['--start', START.toISOString(), '--end', END.toISOString()];

test('--json output matches the documented schema', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'old.js': lines(10) }, message: 'pre-window', date: at(START, { hours: -30 }) });
    await commit(dir, { files: { 'src/a.js': lines(2500) }, message: 'dump', date: at(START, { hours: 2 }) });
    const res = runCli(['verify', dir, ...windowArgs, '--team-size', '3']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(runCli(['verify', dir, ...windowArgs, '--team-size', '3', '--json']).stdout);

    assert.equal(typeof out.repo, 'string');
    assert.equal(out.window.start, START.toISOString());
    assert.equal(out.window.end, END.toISOString());
    assert.equal(out.window.graceMinutes, 15);
    assert.equal(out.totalCommits, 2);
    assert.ok(Array.isArray(out.findings) && out.findings.length >= 2);
    for (const f of out.findings) {
      assert.equal(typeof f.check, 'string');
      assert.ok(['info', 'warn', 'high'].includes(f.severity));
      assert.equal(typeof f.message, 'string');
      assert.ok(Array.isArray(f.evidence));
      for (const ev of f.evidence) assert.equal(typeof ev, 'string');
    }
    assert.ok(Number.isInteger(out.score) && out.score >= 0 && out.score <= 100);
    assert.deepEqual(out.scoring.weights, { high: 25, warn: 10, info: 3 });
    assert.equal(typeof out.scoring.perCheckCap, 'number');
    assert.ok(Array.isArray(out.scoring.deductions));
    assert.ok(Array.isArray(out.histogram));
  } finally {
    await cleanup(dir);
  }
});

test('clean repo scores 100 with no findings', async () => {
  const dir = await makeCleanRepo();
  try {
    const out = JSON.parse(runCli(['verify', dir, ...windowArgs, '--json']).stdout);
    assert.deepEqual(out.findings, []);
    assert.equal(out.score, 100);
  } finally {
    await cleanup(dir);
  }
});

test('suspicious repo scores below a clean one and terminal report shows sections', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'old.js': lines(10) }, message: 'pre-window', date: at(START, { hours: -30 }) });
    await commit(dir, {
      files: { 'src/a.js': lines(11000) },
      message: 'huge dump',
      authorDate: at(START, { hours: -40 }),
      committerDate: at(START, { hours: 2 }),
    });
    const res = runCli(['verify', dir, ...windowArgs]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /INTEGRITY SCORE: \d+\/100/);
    assert.match(res.stdout, /Commits outside event window/);
    assert.match(res.stdout, /Oversized initial commit/);
    assert.match(res.stdout, /\[HIGH\]/);
    const out = JSON.parse(runCli(['verify', dir, ...windowArgs, '--json']).stdout);
    assert.ok(out.score < 60, `expected suspicious score, got ${out.score}`);
  } finally {
    await cleanup(dir);
  }
});

test('--markdown writes a report file', async () => {
  const dir = await makeCleanRepo();
  try {
    const mdPath = join(dir, 'report.md');
    const res = runCli(['verify', dir, ...windowArgs, '--markdown', '--markdown-file', mdPath]);
    assert.equal(res.status, 0, res.stderr);
    const md = await readFile(mdPath, 'utf8');
    assert.match(md, /^# Submission verification report/);
    assert.match(md, /Integrity score:\*\* \*\*100\/100/);
    assert.match(md, /\| Check \| Findings \| Deduction \|/);
  } finally {
    await cleanup(dir);
  }
});

test('errors cleanly on bad input', async () => {
  const missingDates = runCli(['verify', '/nonexistent']);
  assert.equal(missingDates.status, 2);
  assert.match(missingDates.stderr, /--start and --end are required/);

  const badRepo = runCli(['verify', '/nonexistent', ...windowArgs]);
  assert.equal(badRepo.status, 2);
  assert.match(badRepo.stderr, /Not a git repository/);

  const badDate = runCli(['verify', '.', '--start', 'nope', '--end', END.toISOString()]);
  assert.equal(badDate.status, 2);
  assert.match(badDate.stderr, /Invalid --start/);

  const badCommand = runCli(['frobnicate', '.']);
  assert.equal(badCommand.status, 2);
  assert.match(badCommand.stderr, /unknown command/);
});
