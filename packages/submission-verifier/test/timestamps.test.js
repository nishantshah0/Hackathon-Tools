import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/index.js';
import { START, END, at, cleanup, commit, makeCleanRepo, makeRepo } from './helpers.js';

const run = (dir) => verify(dir, { start: START, end: END });
const mismatch = (r) => r.findings.filter((f) => f.check === 'date-mismatch');
const anomalies = (r) => r.findings.filter((f) => f.check === 'timestamps');

test('author/committer gap over 24h is flagged', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, {
      files: { 'a.js': 'a\n' },
      message: 'rebased',
      authorDate: at(START, { hours: 1 }),
      committerDate: at(START, { hours: 27 }),
    });
    const result = await run(dir);
    const f = mismatch(result);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'warn');
    assert.match(f[0].evidence[0], /26\.0h gap/);
  } finally {
    await cleanup(dir);
  }
});

test('author/committer gap under 24h is not flagged', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, {
      files: { 'a.js': 'a\n' },
      message: 'amended',
      authorDate: at(START, { hours: 1 }),
      committerDate: at(START, { hours: 20 }),
    });
    assert.deepEqual(mismatch(await run(dir)), []);
  } finally {
    await cleanup(dir);
  }
});

test('committer dates going backwards in first-parent order are flagged', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'one', date: at(START, { hours: 10 }) });
    await commit(dir, { files: { 'b.js': 'b\n' }, message: 'two (older date)', date: at(START, { hours: 4 }) });
    const result = await run(dir);
    const back = anomalies(result).filter((f) => /backwards/.test(f.message));
    assert.equal(back.length, 1);
    assert.match(back[0].evidence[0], /"two \(older date\)"/);
  } finally {
    await cleanup(dir);
  }
});

test('three or more identical timestamps are flagged as scripted history', async () => {
  const dir = await makeRepo();
  try {
    const stamp = at(START, { hours: 6 });
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'one', date: stamp });
    await commit(dir, { files: { 'b.js': 'b\n' }, message: 'two', date: stamp });
    await commit(dir, { files: { 'c.js': 'c\n' }, message: 'three', date: stamp });
    const result = await run(dir);
    const scripted = anomalies(result).filter((f) => /identical timestamp/.test(f.message));
    assert.equal(scripted.length, 1);
    assert.equal(scripted[0].evidence.length, 3);
  } finally {
    await cleanup(dir);
  }
});

test('two identical timestamps alone are not flagged', async () => {
  const dir = await makeRepo();
  try {
    const stamp = at(START, { hours: 6 });
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'one', date: stamp });
    await commit(dir, { files: { 'b.js': 'b\n' }, message: 'two', date: stamp });
    const result = await run(dir);
    assert.deepEqual(anomalies(result).filter((f) => /identical/.test(f.message)), []);
  } finally {
    await cleanup(dir);
  }
});

test('clean repo has no date-mismatch or timestamp findings', async () => {
  const dir = await makeCleanRepo();
  try {
    const result = await run(dir);
    assert.deepEqual(mismatch(result), []);
    assert.deepEqual(anomalies(result), []);
  } finally {
    await cleanup(dir);
  }
});
