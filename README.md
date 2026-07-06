# infrahacks-tools

Organizer tooling built for [InfraHacks](https://infrahacks.org) — a remote, infrastructure-themed hackathon. Four standalone tools that attack the four hardest problems of running a hackathon online: solo hackers dropping out, teams silently going dark, rule-gaming in submissions, and slow/unfair judging.

Every package is plain Node.js (22+), ESM, tested with the built-in `node:test` runner, and dependency-free (except `judge-assist`, which uses the official Anthropic SDK — with a fully offline fallback).

| Package | Problem | Core tech |
|---|---|---|
| [`packages/team-matcher`](packages/team-matcher) | Solo participants at remote events lurk and drop out | Timezone-overlap hard constraints (Intl-based, handles fractional offsets + midnight wrap), greedy seeding + simulated annealing, seeded/deterministic |
| [`packages/engagement`](packages/engagement) | Remote hackathons silently lose 40–60% of registrants | GitHub webhook ingestion (HMAC-verified), SQLite time-series, exponential-decay scoring, live SSE dashboard with going-dark alerts |
| [`packages/submission-verifier`](packages/submission-verifier) | Pre-built projects and code committed before kickoff | Git forensics: 7 checks over commit dates/sizes/bursts/authors → 0–100 integrity score |
| [`packages/judge-assist`](packages/judge-assist) | Judging is slow and raw score averages are unfair | Claude-generated judge briefs, pairwise A/B scheduling with COI exclusion, Bradley-Terry (MM/Zermelo) ranking, per-judge z-score normalization |

## Quickstart

Each package is self-contained — `cd` in, then:

```sh
npm test        # built-in node:test suites (123 tests across the repo)
npm run demo    # runs the tool against bundled realistic sample data
```

Highlights:

```sh
# Form balanced teams from 24 participants across 15 timezones
cd packages/team-matcher && npm run demo

# Watch 10 simulated teams on the live dashboard; two go dark mid-event
cd packages/engagement && npm run demo   # then open http://localhost:3000

# Build a deliberately suspicious repo and catch it (scores 14/100)
cd packages/submission-verifier && npm run demo

# Schedule pairwise judging, simulate noisy votes, recover the true ranking
# with ~12% of the comparisons a full round-robin would need
cd packages/judge-assist && npm install && npm run demo
```

## Why these four

- **team-matcher** runs before the event: skills/interests/timezones in, balanced teams out, with per-team explanations and concrete reasons for anyone unplaceable.
- **engagement** runs during the event: commit/Discord/portal signals decay over time; organizers see who's cooling off in time to intervene.
- **submission-verifier** runs at the deadline: it raises flags with evidence (it doesn't convict — history can be forged, and the README says so).
- **judge-assist** runs at judging: AI briefs orient judges in seconds (rubric *hints*, never scores — judges score), pairwise votes replace slow rubric passes, Bradley-Terry turns sparse votes into a fair global ranking, and z-score normalization calibrates harsh vs. generous judges for events that also collect raw scores.

`judge-assist` uses `claude-opus-4-8` via `ANTHROPIC_API_KEY` when available and falls back to a deterministic heuristic brief generator when it isn't — the whole repo tests and demos with no network and no keys.
