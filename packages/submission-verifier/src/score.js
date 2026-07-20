// Transparent scoring: start from 100, subtract a fixed weight per finding,
// with a per-check deduction cap so no single check can zero the score alone.

export const WEIGHTS = { high: 25, warn: 10, info: 3 };
export const PER_CHECK_CAP = 30;

/**
 * Returns { score, deductions: [{ check, findings, rawDeduction, deduction }] }
 */
export function scoreFindings(findings) {
  const byCheck = new Map();
  for (const f of findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check).push(f);
  }
  const deductions = [];
  let total = 0;
  for (const [check, list] of byCheck) {
    const raw = list.reduce((sum, f) => sum + WEIGHTS[f.severity], 0);
    const capped = Math.min(raw, PER_CHECK_CAP);
    total += capped;
    deductions.push({ check, findings: list.length, rawDeduction: raw, deduction: capped });
  }
  return { score: Math.max(0, 100 - total), deductions };
}
