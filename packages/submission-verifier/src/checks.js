// The seven forensic checks. Each check takes the commit list plus context
// and returns an array of findings:
//   { check, severity: 'info'|'warn'|'high', message, evidence: [string] }
import { countedAddedLines, isIgnoredPath } from './ignore.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function fmtDate(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Evidence line: `a1b2c3d 2026-07-04T02:11:00Z +12431 lines "initial commit"` */
export function evidenceLine(c, extra = null) {
  const added = extra ?? `+${countedAddedLines(c)} lines`;
  return `${c.short} ${fmtDate(c.committerDate)} ${added} "${c.subject}"`;
}

function inWindow(date, start, end) {
  return date >= start && date <= end;
}

/** 1. Commits outside the event window (author OR committer date). */
export function checkWindow(commits, { start, end, graceMinutes }) {
  const findings = [];
  const graceEnd = new Date(end.getTime() + graceMinutes * 60_000);
  const pre = [];
  const post = [];
  for (const c of commits) {
    if (c.authorDate < start || c.committerDate < start) {
      const which = c.authorDate < start ? `author-date ${fmtDate(c.authorDate)}` : `committer-date ${fmtDate(c.committerDate)}`;
      pre.push(evidenceLine(c, `pre-window (${which})`));
    } else if (c.authorDate > graceEnd || c.committerDate > graceEnd) {
      const which = c.committerDate > graceEnd ? `committer-date ${fmtDate(c.committerDate)}` : `author-date ${fmtDate(c.authorDate)}`;
      post.push(evidenceLine(c, `post-deadline (${which})`));
    }
  }
  if (pre.length) {
    findings.push({
      check: 'window',
      severity: 'high',
      message: `${pre.length} commit(s) dated before the event start (${fmtDate(start)})`,
      evidence: pre,
    });
  }
  if (post.length) {
    findings.push({
      check: 'window',
      severity: 'warn',
      message: `${post.length} commit(s) dated after the deadline + ${graceMinutes}min grace (${fmtDate(graceEnd)})`,
      evidence: post,
    });
  }
  return findings;
}

/** 2. Oversized first in-window commit (lockfiles/vendored paths excluded). */
export function checkInitialSize(commits, { start, end, graceMinutes, warnLines, highLines }) {
  const graceEnd = new Date(end.getTime() + graceMinutes * 60_000);
  const first = commits.find((c) => inWindow(c.committerDate, start, graceEnd));
  if (!first) return [];
  const added = countedAddedLines(first);
  const nFiles = first.files.filter((f) => !isIgnoredPath(f.path) && f.added > 0).length;
  if (added <= warnLines) return [];
  const severity = added > highLines ? 'high' : 'warn';
  return [{
    check: 'initial-size',
    severity,
    message: `First in-window commit adds ${added} lines across ${nFiles} files (excluding lockfiles/vendored paths); threshold warn>${warnLines}, high>${highLines}`,
    evidence: [evidenceLine(first, `+${added} lines, ${nFiles} files`)],
  }];
}

/** 3. Author-date vs committer-date gaps > 24h (rebase/import of older work). */
export function checkDateMismatch(commits, { mismatchHours = 24 } = {}) {
  const bad = [];
  for (const c of commits) {
    const gapMs = Math.abs(c.committerDate - c.authorDate);
    if (gapMs > mismatchHours * HOUR) {
      const gapH = (gapMs / HOUR).toFixed(1);
      bad.push(evidenceLine(c, `author ${fmtDate(c.authorDate)} vs committer ${fmtDate(c.committerDate)} (${gapH}h gap)`));
    }
  }
  if (!bad.length) return [];
  return [{
    check: 'date-mismatch',
    severity: 'warn',
    message: `${bad.length} commit(s) with >24h gap between author date and commit date (suggests rebased/imported pre-existing work)`,
    evidence: bad,
  }];
}

/** 4. Timestamp anomalies: dates going backwards in first-parent order; many identical timestamps. */
export function checkTimestampAnomalies(commits, firstParentHashes) {
  const findings = [];
  const byHash = new Map(commits.map((c) => [c.hash, c]));

  const backwards = [];
  let prev = null;
  for (const hash of firstParentHashes) {
    const c = byHash.get(hash);
    if (!c) continue;
    if (prev && c.committerDate < prev.committerDate) {
      backwards.push(evidenceLine(c, `committer-date earlier than parent ${prev.short} (${fmtDate(prev.committerDate)})`));
    }
    prev = c;
  }
  if (backwards.length) {
    findings.push({
      check: 'timestamps',
      severity: 'warn',
      message: `${backwards.length} commit(s) whose committer date goes backwards along the first-parent chain (history rewrite)`,
      evidence: backwards,
    });
  }

  const groups = new Map();
  for (const c of commits) {
    const key = fmtDate(c.committerDate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const [key, group] of groups) {
    if (group.length >= 3) {
      findings.push({
        check: 'timestamps',
        severity: 'warn',
        message: `${group.length} commits share the identical timestamp ${key} (scripted history)`,
        evidence: group.map((c) => evidenceLine(c)),
      });
    }
  }
  return findings;
}

/**
 * 5. Burstiness: commits-per-hour histogram; a single hour bucket holding
 * >80% of all counted line additions in the late half of the window = warn.
 * Returns { findings, histogram } so reports can print the profile.
 */
export function checkBurstiness(commits, { start, end }) {
  const inWin = commits.filter((c) => c.committerDate >= start && c.committerDate <= end);
  const buckets = new Map(); // hourIndex -> { commits, added }
  let totalAdded = 0;
  for (const c of inWin) {
    const idx = Math.floor((c.committerDate - start) / HOUR);
    if (!buckets.has(idx)) buckets.set(idx, { commits: 0, added: 0 });
    const b = buckets.get(idx);
    b.commits += 1;
    const added = countedAddedLines(c);
    b.added += added;
    totalAdded += added;
  }
  const histogram = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => ({
      hour: idx,
      bucketStart: fmtDate(new Date(start.getTime() + idx * HOUR)),
      commits: b.commits,
      addedLines: b.added,
    }));

  const findings = [];
  if (inWin.length >= 3 && totalAdded > 0) {
    let maxIdx = -1;
    let maxAdded = -1;
    for (const [idx, b] of buckets) {
      if (b.added > maxAdded) { maxAdded = b.added; maxIdx = idx; }
    }
    const share = maxAdded / totalAdded;
    const bucketStart = new Date(start.getTime() + maxIdx * HOUR);
    const midpoint = new Date((start.getTime() + end.getTime()) / 2);
    if (share > 0.8 && bucketStart >= midpoint) {
      findings.push({
        check: 'burstiness',
        severity: 'warn',
        message: `A single one-hour burst at ${fmtDate(bucketStart)} contains ${(share * 100).toFixed(0)}% of all line additions, late in the event`,
        evidence: inWin
          .filter((c) => Math.floor((c.committerDate - start) / HOUR) === maxIdx)
          .map((c) => evidenceLine(c)),
      });
    }
  }
  return { findings, histogram };
}

/** 6. Contributor analysis: authors vs declared team size; drive-by authors. */
export function checkContributors(commits, { teamSize = null } = {}) {
  const findings = [];
  const byAuthor = new Map(); // email -> { name, count }
  for (const c of commits) {
    const key = c.authorEmail.toLowerCase();
    if (!byAuthor.has(key)) byAuthor.set(key, { name: c.authorName, email: c.authorEmail, count: 0 });
    byAuthor.get(key).count += 1;
  }
  const authors = [...byAuthor.values()].sort((a, b) => b.count - a.count);

  if (teamSize && authors.length < teamSize) {
    findings.push({
      check: 'contributors',
      severity: 'info',
      message: `${authors.length} distinct author(s) for a declared team of ${teamSize}`,
      evidence: authors.map((a) => `${a.name} <${a.email}> — ${a.count} commit(s)`),
    });
  }

  if (commits.length >= 6) {
    const driveBy = authors.filter((a) => a.count === 1);
    if (driveBy.length && driveBy.length < authors.length) {
      findings.push({
        check: 'contributors',
        severity: 'info',
        message: `${driveBy.length} drive-by author(s) with a single commit (verify these emails belong to registered team members)`,
        evidence: driveBy.map((a) => `${a.name} <${a.email}> — 1 commit`),
      });
    }
  }
  return findings;
}

/**
 * 7. Vendored-code heuristic: an in-window commit adds a whole directory
 * tree (>= minTreeFiles files under one top-level dir) that is never touched
 * again by any later commit.
 */
export function checkVendored(commits, addedFilesByHash, { start, end, graceMinutes, minTreeFiles = 15 }) {
  const graceEnd = new Date(end.getTime() + graceMinutes * 60_000);
  const findings = [];
  const sorted = [...commits].sort((a, b) => a.committerDate - b.committerDate);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.committerDate < start || c.committerDate > graceEnd) continue;
    const added = addedFilesByHash.get(c.hash) || [];
    const byDir = new Map();
    for (const path of added) {
      const slash = path.indexOf('/');
      if (slash === -1) continue;
      const dir = path.slice(0, slash);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(path);
    }
    for (const [dir, paths] of byDir) {
      if (paths.length < minTreeFiles) continue;
      const laterTouches = sorted
        .slice(i + 1)
        .some((later) => later.files.some((f) => f.path.startsWith(`${dir}/`)));
      if (!laterTouches) {
        findings.push({
          check: 'vendored',
          severity: 'warn',
          message: `Commit drops a ${paths.length}-file tree under "${dir}/" that is never edited afterwards (looks vendored/imported)`,
          evidence: [evidenceLine(c, `${paths.length} files under ${dir}/`)],
        });
      }
    }
  }
  return findings;
}
