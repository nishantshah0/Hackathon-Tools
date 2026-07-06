import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/index.js';
import { START, END, at, cleanup, commit, lines, makeCleanRepo, makeRepo } from './helpers.js';

const run = (dir) => verify(dir, { start: START, end: END });
const vendored = (r) => r.findings.filter((f) => f.check === 'vendored');

function tree(dirName, count) {
  const files = {};
  for (let i = 0; i < count; i++) files[`${dirName}/file${i}.js`] = lines(5, `f${i}`);
  return files;
}

test('a dropped-in tree of many files never edited again is flagged', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: { 'src/app.js': lines(20) }, message: 'start', date: at(START, { hours: 1 }) });
    await commit(dir, { files: tree('thirdparty', 20), message: 'import lib', date: at(START, { hours: 3 }) });
    await commit(dir, { files: { 'src/app.js': lines(40) }, message: 'more work', date: at(START, { hours: 8 }) });
    const result = await run(dir);
    const f = vendored(result);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'warn');
    assert.match(f[0].message, /20-file tree under "thirdparty\/"/);
    assert.match(f[0].evidence[0], /"import lib"/);
  } finally {
    await cleanup(dir);
  }
});

test('a large tree that gets subsequent edits is not flagged', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: tree('lib', 20), message: 'scaffold', date: at(START, { hours: 1 }) });
    await commit(dir, { files: { 'lib/file0.js': lines(30, 'edited') }, message: 'iterate on lib', date: at(START, { hours: 8 }) });
    const result = await run(dir);
    assert.deepEqual(vendored(result), []);
  } finally {
    await cleanup(dir);
  }
});

test('small directory additions are not flagged', async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { files: tree('utils', 10), message: 'utils', date: at(START, { hours: 1 }) });
    await commit(dir, { files: { 'a.js': 'a\n' }, message: 'later', date: at(START, { hours: 8 }) });
    assert.deepEqual(vendored(await run(dir)), []);
  } finally {
    await cleanup(dir);
  }
});

test('clean repo has no vendored findings', async () => {
  const dir = await makeCleanRepo();
  try {
    assert.deepEqual(vendored(await run(dir)), []);
  } finally {
    await cleanup(dir);
  }
});
