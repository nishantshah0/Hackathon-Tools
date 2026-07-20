# submission-verifier

Git forensics for hackathon rule enforcement. Remote hackathons attract rule-gaming: pre-built projects, code written before kickoff, single massive code-dumps minutes before the deadline. This CLI analyzes a submitted git repository against the event window and produces an integrity risk report for organizers and judges.

Zero dependencies. Plain Node 22 ESM. Reads history by spawning `git log` / `git rev-list` with machine-parseable formats (`--pretty=format:` with field separators, `--numstat`) — no git libraries.

## Checks

| # | Check | What it looks for | Severity |
|---|-------|-------------------|----------|
| 1 | `window` | Commits whose author-date **or** committer-date fall before the event start, or after the deadline plus a grace period (`--grace-minutes`, default 15) | high (pre) / warn (post) |
| 2 | `initial-size` | First in-window commit adding a huge number of lines. Lockfiles and vendored paths (`node_modules/`, `dist/`, `vendor/`, `*.min.js`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, ...) are excluded from the count | warn >2000 lines, high >10000 (configurable) |
| 3 | `date-mismatch` | Gaps >24h between author date and commit date — the signature of rebasing/rewriting pre-existing work into the window | warn |
| 4 | `timestamps` | Committer dates that go backwards along the first-parent chain; 3+ commits sharing an identical timestamp (scripted history) | warn |
| 5 | `burstiness` | Commits-per-hour histogram; a single one-hour burst holding >80% of all counted line-additions in the late half of the event | warn |
| 6 | `contributors` | Distinct authors vs. declared team size (`--team-size N`); single-commit "drive-by" authors whose emails should be checked against the roster | info |
| 7 | `vendored` | In-window commits that drop a whole directory tree (15+ files) that is never edited again afterwards | warn |

## Usage

```
submission-verifier verify <path-to-repo> --start <ISO datetime> --end <ISO datetime> [options]

Options:
  --start <iso>          Event start (required), e.g. 2026-07-04T09:00:00Z
  --end <iso>            Event end / submission deadline (required)
  --grace-minutes <n>    Post-deadline grace period (default 15)
  --team-size <n>        Declared team size, enables contributor comparison
  --warn-lines <n>       Initial-commit warn threshold in added lines (default 2000)
  --high-lines <n>       Initial-commit high threshold in added lines (default 10000)
  --json                 Machine-readable JSON to stdout
  --markdown             Write a markdown report (default file: report.md; override with --markdown-file <path>)
```

Example:

```sh
node bin/cli.js verify ./team42-submission \
  --start 2026-07-04T09:00:00Z --end 2026-07-05T21:00:00Z \
  --team-size 4 --markdown
```

Try it on a synthetic suspicious repo:

```sh
npm run demo
```

## Scoring

The report aggregates findings into a 0–100 integrity score (100 = clean). Weights are fixed and printed in every report: **high −25, warn −10, info −3**, with each check's total deduction capped at 30 so no single check can zero the score on its own. The score is a triage signal, not a verdict.

## Sample report excerpt

```
## Commits outside event window
   [HIGH] 3 commit(s) dated before the event start (2026-07-04T09:00:00Z)
      2166f8f 2026-07-01T09:00:00Z +401 lines "initial commit"
      d9dcae4 2026-07-02T09:00:00Z +250 lines "api endpoints"

## Oversized initial commit
   [HIGH] First in-window commit adds 15000 lines across 25 files (excluding
   lockfiles/vendored paths); threshold warn>2000, high>10000
      b57a41c 2026-07-05T19:30:00Z +15000 lines, 25 files "add project code"

================================================================
INTEGRITY SCORE: 12/100 — HIGH RISK
Score raises flags for human review; it does not convict.
================================================================
```

## Limitations — read this before accusing anyone

Git history is entirely forgeable: dates, authors, and hashes can all be rewritten, and a determined cheater can craft a history this tool scores 100/100. Conversely, honest teams trip flags all the time — importing a starter template, squash-rebasing before submission, committing from a misconfigured clock, or pairing on one laptop. **This tool raises flags for human review; it does not convict.** Use the evidence lines as conversation starters with the team, not as proof.
