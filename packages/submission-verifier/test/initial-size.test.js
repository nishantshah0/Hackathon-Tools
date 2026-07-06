import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/index.js';
import { START, END, at, cleanup, commit, lines, makeCleanRepo, makeRepo } from './helpers.js';

const run = (dir, extra = {}) => verify(dir, { start: START, end: END, ...extra });
const sizeFindings = (r) => r.findings.filter((f) => f.check === 'initial-size');

test('first in-window commit over warn threshold is flagged warn', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'src/big.js': lines(2500) }, message: 'kickoff dump', date: at(START, { hours: 1 }) });
    const result = await run(dir);
    const f = sizeFindings(result);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'warn');
    assert.match(f[0].message, /adds 2500 lines/);
  } finally {
    await cleanup(dir);
  }
});

test('first in-window commit over high threshold is flagged high', async () => {
  const dir = await makeRepo();
  try {
    const files = {};
    for (let i = 0; i < 6; i++) files[`src/part${i}.js`] = lines(2000, `p${i}`);
    await commit(dir, { files, message: 'mega dump', date: at(START, { hours: 1 }) });
    const result = await run(dir);
    const f = sizeFindings(result);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'high');
    assert.match(f[0].message, /adds 12000 lines/);
  } finally {
    await cleanup(dir);
  }
});

test('thresholds are configurable', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'src/a.js': lines(500) }, message: 'medium', date: at(START, { hours: 1 }) });
    const strict = await run(dir, { warnLines: 100, highLines: 400 });
    assert.equal(sizeFindings(strict)[0].severity, 'high');
    const lax = await run(dir, { warnLines: 1000 });
    assert.deepEqual(sizeFindings(lax), []);
  } finally {
    await cleanup(dir);
  }
});

test('ignore list excludes lockfiles and vendored paths from size counts', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, {
      files: {
        'src/app.js': lines(300),
        'package-lock.json': lines(8000, 'lock'),
        'node_modules/dep/index.js': lines(5000, 'dep'),
        'dist/bundle.min.js': lines(4000, 'min'),
      },
      message: 'init with lockfile',
      date: at(START, { hours: 1 }),
    });
    const result = await run(dir);
    assert.deepEqual(sizeFindings(result), []);
  } finally {
    await cleanup(dir);
  }
});

test('uses the first IN-WINDOW commit, not a pre-window one', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'old.js': lines(50) }, message: 'pre-window', date: at(START, { hours: -48 }) });
    await commit(dir, { files: { 'src/dump.js': lines(3000) }, message: 'first in window', date: at(START, { hours: 1 }) });
    const result = await run(dir);
    const f = sizeFindings(result);
    assert.equal(f.length, 1);
    assert.match(f[0].evidence[0], /"first in window"/);
  } finally {
    await cleanup(dir);
  }
});

test('clean repo has no initial-size findings', async () => {
  const dir = await makeCleanRepo();
  try {
    assert.deepEqual(sizeFindings(await run(dir)), []);
  } finally {
    await cleanup(dir);
  }
});
