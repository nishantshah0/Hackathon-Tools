#!/usr/bin/env node
// Demo: build a deliberately suspicious fixture repo in a tmp dir, then run
// the verifier on it against a 36-hour event window.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

const START = new Date('2026-07-04T09:00:00Z');
const END = new Date('2026-07-05T21:00:00Z');
const at = (base, h) => new Date(base.getTime() + h * 3600_000);

function git(cwd, args, dates = {}) {
  const env = { ...process.env };
  if (dates.author) env.GIT_AUTHOR_DATE = dates.author.toISOString();
  if (dates.committer) env.GIT_COMMITTER_DATE = dates.committer.toISOString();
  const res = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

async function write(dir, rel, content) {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function commit(dir, { files = {}, message, author, committer, name = 'Alice Dev', email = 'alice@example.com' }) {
  for (const [rel, content] of Object.entries(files)) await write(dir, rel, content);
  const dates = { author, committer: committer ?? author };
  git(dir, ['add', '-A'], dates);
  git(dir, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', message], dates);
}

const lines = (n, p = 'code') => Array.from({ length: n }, (_, i) => `${p} line ${i}`).join('\n') + '\n';

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'subver-demo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  console.log(`building suspicious fixture repo in ${dir}\n`);

  // 1. Work started days BEFORE the event window.
  await commit(dir, {
    files: { 'src/core.js': lines(400), 'README.md': '# totally fresh project\n' },
    message: 'initial commit', author: at(START, -72),
  });
  await commit(dir, {
    files: { 'src/api.js': lines(250) },
    message: 'api endpoints', author: at(START, -48),
  });

  // 2. Backdated author date: rebased pre-existing work, committed in-window.
  await commit(dir, {
    files: { 'src/auth.js': lines(300) },
    message: 'add auth', author: at(START, -60), committer: at(START, 2),
  });

  // 3. Giant in-window code dump: 15k lines of "own" code + a vendored tree
  //    that is never touched again, plus a lockfile (excluded from counts).
  const dump = { 'package-lock.json': lines(4000, 'lock') };
  for (let i = 0; i < 25; i++) dump[`src/generated/module${i}.js`] = lines(600, `m${i}`);
  for (let i = 0; i < 20; i++) dump[`third_party/lib/file${i}.js`] = lines(50, `v${i}`);
  await commit(dir, { files: dump, message: 'add project code', author: at(END, -1.5) });

  // 4. Scripted history: identical timestamps late in the window.
  const stamp = at(END, -1);
  for (let i = 0; i < 3; i++) {
    await commit(dir, { files: { [`notes${i}.md`]: `note ${i}\n` }, message: `progress ${i}`, author: stamp });
  }

  // 5. Drive-by author + post-deadline commit.
  await commit(dir, {
    files: { 'demo.md': 'demo script\n' }, message: 'fix demo',
    author: at(END, 1), name: 'Rando Helper', email: 'rando@unknown.example',
  });

  console.log('running: submission-verifier verify <fixture> ' +
    `--start ${START.toISOString()} --end ${END.toISOString()} --team-size 4\n`);
  const res = spawnSync(process.execPath, [
    CLI, 'verify', dir,
    '--start', START.toISOString(),
    '--end', END.toISOString(),
    '--team-size', '4',
  ], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
