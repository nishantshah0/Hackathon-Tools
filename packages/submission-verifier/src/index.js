// Orchestrator: read git data, run every check, aggregate the score.
import { isGitRepo, readAddedFiles, readCommits, readFirstParentOrder } from './git.js';
import {
  checkBurstiness,
  checkContributors,
  checkDateMismatch,
  checkInitialSize,
  checkTimestampAnomalies,
  checkVendored,
} from './checks.js';
import { PER_CHECK_CAP, WEIGHTS, scoreFindings } from './score.js';
import { checkWindow } from './checks.js';

export const CHECK_NAMES = [
  'window',
  'initial-size',
  'date-mismatch',
  'timestamps',
  'burstiness',
  'contributors',
  'vendored',
];

/**
 * Analyze a repo. Options:
 *   start, end        Date (required)
 *   graceMinutes      number, default 15
 *   warnLines         number, default 2000
 *   highLines         number, default 10000
 *   teamSize          number|null
 *
 * Returns { repo, window, totalCommits, findings, histogram, score, scoring }.
 */
export async function verify(repoPath, options) {
  const {
    start,
    end,
    graceMinutes = 15,
    warnLines = 2000,
    highLines = 10000,
    teamSize = null,
  } = options;

  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new Error('Invalid --start datetime');
  }
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid --end datetime');
  }
  if (end <= start) throw new Error('--end must be after --start');
  if (!(await isGitRepo(repoPath))) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  const [commits, firstParent, addedFiles] = await Promise.all([
    readCommits(repoPath),
    readFirstParentOrder(repoPath),
    readAddedFiles(repoPath),
  ]);

  const ctx = { start, end, graceMinutes, warnLines, highLines, teamSize };
  const burst = checkBurstiness(commits, ctx);
  const findings = [
    ...checkWindow(commits, ctx),
    ...checkInitialSize(commits, ctx),
    ...checkDateMismatch(commits),
    ...checkTimestampAnomalies(commits, firstParent),
    ...burst.findings,
    ...checkContributors(commits, ctx),
    ...checkVendored(commits, addedFiles, ctx),
  ];

  const { score, deductions } = scoreFindings(findings);

  return {
    repo: repoPath,
    window: {
      start: start.toISOString(),
      end: end.toISOString(),
      graceMinutes,
    },
    totalCommits: commits.length,
    findings,
    histogram: burst.histogram,
    score,
    scoring: {
      weights: WEIGHTS,
      perCheckCap: PER_CHECK_CAP,
      deductions,
    },
  };
}
