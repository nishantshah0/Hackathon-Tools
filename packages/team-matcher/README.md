# team-matcher

Remote team formation engine for virtual hackathons.

At remote hackathons, solo participants lurk in Discord, never find teammates,
and quietly drop out. `team-matcher` takes the registration list and forms
balanced teams automatically — respecting timezones, so nobody lands on a team
whose working hours they will sleep through.

Zero dependencies. Node 22+, plain ESM JavaScript.

## How it works

**Hard constraints** (never violated):

- Team size within `[min, max]` (default 3–4).
- Every *pair* of teammates shares at least `H` hours of daily availability
  overlap (default 4h), computed in UTC from each participant's IANA timezone
  (resolved via the built-in `Intl` API at a fixed reference date) and their
  local availability windows. Windows may wrap past midnight
  (`{ "start": 18, "end": 26 }` = 18:00 → 02:00).

**Soft objectives** (weighted score per team, each in [0, 1]):

- *Role coverage* — distinct roles, with bonuses for having at least one
  frontend-ish (frontend/design/mobile) and one backend-ish (backend/infra/ml)
  member.
- *Interest cohesion* — mean pairwise Jaccard similarity of interests, so teams
  actually want to build the same thing.
- *Skill complementarity* — penalizes heavy skill duplication.
- *Experience balance* — penalizes all-novice and all-expert teams.

**Solver**: greedy seeding (hardest-to-place participants first, teams grown by
best marginal score among timezone-compatible candidates) followed by simulated
annealing with swap / move / bench-swap / place operations; any move violating
a hard constraint is rejected outright. Deterministic for a given `--seed`
(mulberry32 PRNG). Handles a few hundred participants in well under a second.

Participants who cannot be placed (e.g. a 2-hour availability window that can
never satisfy a 4-hour overlap) are reported as unassigned, with the reason.

## Usage

```sh
node bin/cli.js match examples/participants.json --team-size 3-4 --min-overlap 4 --seed 42
node bin/cli.js match examples/participants.json --json      # machine-readable
npm run demo                                                 # the first command above
```

Options: `--team-size min-max`, `--min-overlap hours`, `--seed n`,
`--iterations n`, `--json`.

As a library:

```js
import { matchTeams } from '@infrahacks-tools/team-matcher';
const result = matchTeams(participants, { minSize: 3, maxSize: 4, minOverlapHours: 4, seed: 42 });
```

## Input format

```json
{
  "id": "p17",
  "name": "Priya Sharma",
  "roles": ["frontend"],
  "skills": ["react", "typescript"],
  "interests": ["ai-agents", "devtools"],
  "timezone": "Asia/Kolkata",
  "availability": [{ "start": 10, "end": 22 }],
  "experience": 3
}
```

## Example output

```
team-2  (score 0.754)
  Matched on: ai-agents. Roles: backend, design, frontend, ml. Overlap window: 04:30–13:00 UTC.
  member        roles            timezone        experience
  ------------  ---------------  --------------  ----------
  Priya Sharma  frontend         Asia/Kolkata    exp 3
  Arjun Patel   ml               Asia/Kolkata    exp 5
  Wei Zhang     backend          Asia/Singapore  exp 4
  Min-jun Kim   design/frontend  Asia/Seoul      exp 1
  breakdown: roles 1.00 | interests 0.33 | skills 0.83 | experience 0.94

Unassigned:
  - Isla MacLeod (p24, Pacific/Auckland): only 0 other participant(s) share >= 4h of
    daily availability overlap; a team of 3 needs at least 2

6 teams | 23/24 assigned | mean score 0.720 | seed 42 | size 3-4 | min overlap 4h
```

`--json` emits the same data with per-team score breakdowns, explanations, and
unassigned reasons.

## Tests

```sh
npm test
```

Covers timezone overlap math (fractional offsets, day-wrapping windows),
scoring functions, property-style hard-constraint checks over random seeded
inputs, determinism (same seed → same teams), and CLI end-to-end runs.
