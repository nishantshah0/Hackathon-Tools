// Thin wrapper over the git CLI. No git libraries: everything is spawned
// child_process with machine-parseable output formats.
import { spawn } from 'node:child_process';

const REC = '\x1e'; // record separator between commits
const FIELD = '\x1f'; // field separator inside a commit header

/**
 * Run git in a repo and resolve with stdout. Rejects on non-zero exit.
 */
export function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${err.trim()}`));
    });
  });
}

/**
 * Read every commit reachable from any ref, with per-file numstat.
 * Returns commits sorted ascending by committer date.
 *
 * Commit shape:
 * { hash, short, authorDate, committerDate, authorName, authorEmail,
 *   committerName, committerEmail, parents[], subject,
 *   files: [{ added, deleted, path }] }
 */
export async function readCommits(repoPath) {
  const pretty = `${REC}%H${FIELD}%h${FIELD}%aI${FIELD}%cI${FIELD}%an${FIELD}%ae${FIELD}%cn${FIELD}%ce${FIELD}%P${FIELD}%s`;
  const out = await runGit(
    ['log', '--all', '--numstat', '--no-renames', `--pretty=format:${pretty}`],
    repoPath,
  );
  const commits = [];
  for (const record of out.split(REC)) {
    if (!record.trim()) continue;
    const lines = record.split('\n');
    const header = lines[0].split(FIELD);
    const [hash, short, aDate, cDate, an, ae, cn, ce, parents, subject] = header;
    const files = [];
    for (const line of lines.slice(1)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files.push({
        added: m[1] === '-' ? 0 : Number(m[1]),
        deleted: m[2] === '-' ? 0 : Number(m[2]),
        path: m[3],
      });
    }
    commits.push({
      hash,
      short,
      authorDate: new Date(aDate),
      committerDate: new Date(cDate),
      authorName: an,
      authorEmail: ae,
      committerName: cn,
      committerEmail: ce,
      parents: parents ? parents.split(' ') : [],
      subject,
      files,
    });
  }
  commits.sort((a, b) => a.committerDate - b.committerDate);
  return commits;
}

/**
 * Hashes along the first-parent chain of HEAD, oldest first.
 * Returns [] for repos without a HEAD commit.
 */
export async function readFirstParentOrder(repoPath) {
  try {
    const out = await runGit(['rev-list', '--reverse', '--first-parent', 'HEAD'], repoPath);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Map of commit hash -> array of file paths ADDED (diff-filter=A) by that commit.
 */
export async function readAddedFiles(repoPath) {
  const out = await runGit(
    ['log', '--all', '--diff-filter=A', '--name-only', '--no-renames', `--pretty=format:${REC}%H`],
    repoPath,
  );
  const map = new Map();
  for (const record of out.split(REC)) {
    if (!record.trim()) continue;
    const lines = record.split('\n').filter(Boolean);
    const hash = lines[0].trim();
    map.set(hash, lines.slice(1));
  }
  return map;
}

/** Sanity check that the path is a git repository. */
export async function isGitRepo(repoPath) {
  try {
    const out = await runGit(['rev-parse', '--is-inside-work-tree'], repoPath);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}
