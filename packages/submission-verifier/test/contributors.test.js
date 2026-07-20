import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/index.js';
import { START, END, at, cleanup, commit, makeCleanRepo, makeRepo } from './helpers.js';

const contrib = (r) => r.findings.filter((f) => f.check === 'contributors');

test('single author for a declared 4-person team is an info finding', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'a', date: at(START, { hours: 1 }) });
    await commit(dir, { files: { 'b.js': 'b\n' }, message: 'b', date: at(START, { hours: 2 }) });
    const result = await verify(dir, { start: START, end: END, teamSize: 4 });
    const f = contrib(result);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'info');
    assert.match(f[0].message, /1 distinct author\(s\) for a declared team of 4/);
    assert.match(f[0].evidence[0], /test@example\.com/);
  } finally {
    await cleanup(dir);
  }
});

test('no contributor finding without --team-size', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'a', date: at(START, { hours: 1 }) });
    const result = await verify(dir, { start: START, end: END });
    assert.deepEqual(contrib(result), []);
  } finally {
    await cleanup(dir);
  }
});

test('drive-by single-commit author is an info finding', async () => {
  const dir = await makeRepo();
  try {
    for (let i = 0; i < 6; i++) {
      await commit(dir, {
        files: { [`f${i}.js`]: `${i}\n` },
        message: `work ${i}`,
        date: at(START, { hours: i + 1 }),
        name: 'Alice',
        email: 'alice@team.example',
      });
    }
    await commit(dir, {
      files: { 'x.js': 'x\n' },
      message: 'mystery commit',
      date: at(START, { hours: 10 }),
      name: 'Rando',
      email: 'rando@unknown.example',
    });
    const result = await verify(dir, { start: START, end: END });
    const driveBy = contrib(result).filter((f) => /drive-by/.test(f.message));
    assert.equal(driveBy.length, 1);
    assert.equal(driveBy[0].severity, 'info');
    assert.match(driveBy[0].evidence[0], /rando@unknown\.example/);
  } finally {
    await cleanup(dir);
  }
});

test('clean single-author repo without team size has no contributor findings', async () => {
  const dir = await makeCleanRepo();
  try {
    const result = await verify(dir, { start: START, end: END });
    assert.deepEqual(contrib(result), []);
  } finally {
    await cleanup(dir);
  }
});
