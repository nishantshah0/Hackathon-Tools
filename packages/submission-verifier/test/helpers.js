// Fixture-repo builder for tests: throwaway git repos in fs.mkdtemp dirs
// with fully controlled author/committer identities and dates.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const START = new Date('2026-07-04T09:00:00Z');
export const END = new Date('2026-07-05T21:00:00Z');

export function git(cwd, args, env = {}) {
  const res = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res.stdout;
}

/** Create a temp dir containing a fresh git repo. Returns its path. */
export async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'subver-fixture-'));
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Create a commit in `dir`.
 *   files: { 'relative/path': 'content' }   (written/overwritten then `git add -A`)
 *   date: Date|string — used for both author and committer date unless overridden
 *   authorDate / committerDate: Date|string overrides
 *   name / email: author+committer identity (default Test User <test@example.com>)
 *   message: commit message
 */
export async function commit(dir, {
  files = {},
  message = 'commit',
  date = new Date(),
  authorDate = null,
  committerDate = null,
  name = 'Test User',
  email = 'test@example.com',
} = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const iso = (d) => (d instanceof Date ? d.toISOString() : d);
  const env = {
    GIT_AUTHOR_DATE: iso(authorDate ?? date),
    GIT_COMMITTER_DATE: iso(committerDate ?? date),
  };
  git(dir, ['add', '-A'], env);
  git(
    dir,
    ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', message],
    env,
  );
}

/** Content with n lines. */
export function lines(n, prefix = 'line') {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';
}

/** Minutes/hours offsets from a base date. */
export function at(base, { hours = 0, minutes = 0 } = {}) {
  return new Date(base.getTime() + hours * 3600_000 + minutes * 60_000);
}

/**
 * A clean 5-commit fixture: single author, small commits, monotonically
 * increasing distinct in-window timestamps spread across the window,
 * every file later edited. Should produce zero findings (without --team-size).
 */
export async function makeCleanRepo() {
  const dir = await makeRepo();
  await commit(dir, { files: { 'README.md': '# project\n' }, message: 'init', date: at(START, { hours: 1 }) });
  await commit(dir, { files: { 'src/app.js': lines(80) }, message: 'app skeleton', date: at(START, { hours: 5 }) });
  await commit(dir, { files: { 'src/db.js': lines(60) }, message: 'db layer', date: at(START, { hours: 12 }) });
  await commit(dir, { files: { 'src/app.js': lines(120), 'src/db.js': lines(90) }, message: 'features', date: at(START, { hours: 20 }) });
  await commit(dir, { files: { 'README.md': '# project\n\ndocs\n', 'src/app.js': lines(130) }, message: 'polish', date: at(START, { hours: 30 }) });
  return dir;
}
