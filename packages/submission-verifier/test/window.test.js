import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/index.js';
import { START, END, at, cleanup, commit, makeCleanRepo, makeRepo } from './helpers.js';

const run = (dir, extra = {}) => verify(dir, { start: START, end: END, ...extra });
const windowFindings = (r) => r.findings.filter((f) => f.check === 'window');

test('flags pre-window commits as high', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'too early', date: at(START, { hours: -50 }) });
    await commit(dir, { files: { 'b.js': 'b\n' }, message: 'in window', date: at(START, { hours: 2 }) });
    const result = await run(dir);
    const pre = windowFindings(result).filter((f) => f.severity === 'high');
    assert.equal(pre.length, 1);
    assert.match(pre[0].message, /before the event start/);
    assert.equal(pre[0].evidence.length, 1);
    assert.match(pre[0].evidence[0], /"too early"/);
  } finally {
    await cleanup(dir);
  }
});

test('flags pre-window author date even when committer date is in-window', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, {
      files: { 'a.js': 'a\n' },
      message: 'rebased old work',
      authorDate: at(START, { hours: -30 }),
      committerDate: at(START, { hours: 1 }),
    });
    const result = await run(dir);
    const pre = windowFindings(result).filter((f) => f.severity === 'high');
    assert.equal(pre.length, 1);
    assert.match(pre[0].evidence[0], /author-date/);
  } finally {
    await cleanup(dir);
  }
});

test('flags post-deadline commits beyond the grace period', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'in window', date: at(START, { hours: 1 }) });
    await commit(dir, { files: { 'b.js': 'b\n' }, message: 'too late', date: at(END, { minutes: 16 }) });
    const result = await run(dir); // default grace 15
    const post = windowFindings(result).filter((f) => /after the deadline/.test(f.message));
    assert.equal(post.length, 1);
    assert.match(post[0].evidence[0], /"too late"/);
    assert.equal(post[0].severity, 'warn');
  } finally {
    await cleanup(dir);
  }
});

test('boundary: commits exactly at start, at end, and within grace are not flagged', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'at start', date: START });
    await commit(dir, { files: { 'b.js': 'b\n' }, message: 'at end', date: END });
    await commit(dir, { files: { 'c.js': 'c\n' }, message: 'in grace', date: at(END, { minutes: 15 }) });
    const result = await run(dir);
    assert.deepEqual(windowFindings(result), []);
  } finally {
    await cleanup(dir);
  }
});

test('grace period is configurable', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'late-ish', date: at(END, { minutes: 45 }) });
    const strict = await run(dir, { graceMinutes: 30 });
    assert.equal(windowFindings(strict).length, 1);
    const lax = await run(dir, { graceMinutes: 60 });
    assert.deepEqual(windowFindings(lax), []);
  } finally {
    await cleanup(dir);
  }
});

test('clean repo has no window findings', async () => {
  const dir = await makeCleanRepo();
  try {
    const result = await run(dir);
    assert.deepEqual(windowFindings(result), []);
  } finally {
    await cleanup(dir);
  }
});
