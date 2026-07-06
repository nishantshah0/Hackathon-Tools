import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/index.js';
import { START, END, at, cleanup, commit, lines, makeCleanRepo, makeRepo } from './helpers.js';

const run = (dir) => verify(dir, { start: START, end: END });
const burst = (r) => r.findings.filter((f) => f.check === 'burstiness');

test('a late one-hour burst with >80% of line additions is flagged', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'a.js': lines(10) }, message: 'a', date: at(START, { hours: 2 }) });
    await commit(dir, { files: { 'b.js': lines(10) }, message: 'b', date: at(START, { hours: 5 }) });
    await commit(dir, { files: { 'c.js': lines(10) }, message: 'c', date: at(START, { hours: 8 }) });
    // window is 36h; midpoint at +18h — burst at +30h is "late"
    await commit(dir, { files: { 'src/dump.js': lines(1500) }, message: 'the dump', date: at(START, { hours: 30 }) });
    const result = await run(dir);
    const f = burst(result);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'warn');
    assert.match(f[0].message, /9\d% of all line additions/);
    assert.match(f[0].evidence[0], /"the dump"/);
  } finally {
    await cleanup(dir);
  }
});

test('an early burst is not flagged', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'src/dump.js': lines(1500) }, message: 'early dump', date: at(START, { hours: 1 }) });
    await commit(dir, { files: { 'a.js': lines(10) }, message: 'a', date: at(START, { hours: 12 }) });
    await commit(dir, { files: { 'b.js': lines(10) }, message: 'b', date: at(START, { hours: 20 }) });
    await commit(dir, { files: { 'c.js': lines(10) }, message: 'c', date: at(START, { hours: 30 }) });
    assert.deepEqual(burst(await run(dir)), []);
  } finally {
    await cleanup(dir);
  }
});

test('evenly spread work is not flagged and histogram is reported', async () => {
  const dir = await makeCleanRepo();
  try {
    const result = await run(dir);
    assert.deepEqual(burst(result), []);
    assert.ok(Array.isArray(result.histogram));
    assert.ok(result.histogram.length >= 4);
    for (const b of result.histogram) {
      assert.equal(typeof b.hour, 'number');
      assert.equal(typeof b.commits, 'number');
      assert.equal(typeof b.addedLines, 'number');
      assert.equal(typeof b.bucketStart, 'string');
    }
  } finally {
    await cleanup(dir);
  }
});
