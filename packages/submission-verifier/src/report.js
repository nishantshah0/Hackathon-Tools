// Render a verify() result as a terminal report or as markdown.

const CHECK_TITLES = {
  window: 'Commits outside event window',
  'initial-size': 'Oversized initial commit',
  'date-mismatch': 'Author/committer date mismatch',
  timestamps: 'Timestamp anomalies',
  burstiness: 'Burstiness profile',
  contributors: 'Contributor analysis',
  vendored: 'Vendored-code heuristic',
};

const SEV_ORDER = { high: 0, warn: 1, info: 2 };
const SEV_TAG = { high: '[HIGH]', warn: '[WARN]', info: '[INFO]' };

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const SEV_COLOR = { high: 31, warn: 33, info: 36 };

function verdict(score) {
  if (score >= 90) return 'LOW RISK';
  if (score >= 70) return 'REVIEW SUGGESTED';
  if (score >= 40) return 'SUSPICIOUS';
  return 'HIGH RISK';
}

function groupFindings(result) {
  const byCheck = new Map();
  for (const name of Object.keys(CHECK_TITLES)) byCheck.set(name, []);
  for (const f of result.findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check).push(f);
  }
  for (const list of byCheck.values()) {
    list.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  }
  return byCheck;
}

export function renderTerminal(result) {
  const lines = [];
  const rule = '='.repeat(64);
  lines.push(rule);
  lines.push('SUBMISSION VERIFIER — git forensics report');
  lines.push(rule);
  lines.push(`repo:     ${result.repo}`);
  lines.push(`window:   ${result.window.start} -> ${result.window.end} (+${result.window.graceMinutes}min grace)`);
  lines.push(`commits:  ${result.totalCommits}`);
  lines.push('');

  for (const [check, findings] of groupFindings(result)) {
    lines.push(`## ${CHECK_TITLES[check] ?? check}`);
    if (!findings.length) {
      lines.push(color(32, '   ok — nothing flagged'));
    }
    for (const f of findings) {
      lines.push(`   ${color(SEV_COLOR[f.severity], SEV_TAG[f.severity])} ${f.message}`);
      for (const ev of f.evidence) lines.push(`      ${ev}`);
    }
    lines.push('');
  }

  lines.push('## Scoring');
  lines.push(`   weights: high -${result.scoring.weights.high}, warn -${result.scoring.weights.warn}, info -${result.scoring.weights.info} (per-check deduction capped at ${result.scoring.perCheckCap})`);
  for (const d of result.scoring.deductions) {
    const cap = d.rawDeduction > d.deduction ? ` (raw -${d.rawDeduction}, capped)` : '';
    lines.push(`   ${(CHECK_TITLES[d.check] ?? d.check).padEnd(36)} -${d.deduction}${cap}`);
  }
  lines.push('');
  const v = verdict(result.score);
  lines.push(rule);
  lines.push(`INTEGRITY SCORE: ${result.score}/100 — ${v}`);
  lines.push('Score raises flags for human review; it does not convict.');
  lines.push(rule);
  return lines.join('\n');
}

export function renderMarkdown(result) {
  const lines = [];
  lines.push('# Submission verification report');
  lines.push('');
  lines.push(`- **Repo:** \`${result.repo}\``);
  lines.push(`- **Event window:** ${result.window.start} → ${result.window.end} (grace ${result.window.graceMinutes} min)`);
  lines.push(`- **Commits analyzed:** ${result.totalCommits}`);
  lines.push(`- **Integrity score:** **${result.score}/100** — ${verdict(result.score)}`);
  lines.push('');

  for (const [check, findings] of groupFindings(result)) {
    lines.push(`## ${CHECK_TITLES[check] ?? check}`);
    lines.push('');
    if (!findings.length) {
      lines.push('Nothing flagged.');
    }
    for (const f of findings) {
      lines.push(`- **${f.severity.toUpperCase()}** — ${f.message}`);
      for (const ev of f.evidence) lines.push(`  - \`${ev}\``);
    }
    lines.push('');
  }

  lines.push('## Scoring');
  lines.push('');
  lines.push(`Weights: high −${result.scoring.weights.high}, warn −${result.scoring.weights.warn}, info −${result.scoring.weights.info}; per-check deduction capped at ${result.scoring.perCheckCap}.`);
  lines.push('');
  lines.push('| Check | Findings | Deduction |');
  lines.push('|---|---|---|');
  for (const d of result.scoring.deductions) {
    lines.push(`| ${CHECK_TITLES[d.check] ?? d.check} | ${d.findings} | −${d.deduction} |`);
  }
  lines.push('');
  lines.push('> Git history can be forged. This report raises flags for human review; it does not convict.');
  lines.push('');
  return lines.join('\n');
}
