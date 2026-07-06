# engagement — "who's going dark" dashboard

Remote hackathons silently lose 40–60% of registrants. Nobody notices until judging day
because nobody is watching for *absence* of activity. This service ingests activity
signals per team (GitHub pushes, Discord messages, portal logins, mentor check-ins),
keeps a time-series, computes a **decaying engagement score**, and serves a live
dashboard that sorts stalling teams to the top so organizers can intervene while it
still matters.

Zero npm dependencies: `node:http`, `node:sqlite`, `node:crypto`, `node:test`.

## Architecture

```
                 ingest                store                score               live
POST /webhooks/github ─┐                                 (pure fns,
POST /events ──────────┼──▶ src/store.js ──▶ src/score.js  injected `now`) ──▶ GET /api/teams
                       │    (node:sqlite,    · exp decay, half-life 3h        GET /api/teams/:id
  repo→team mapping    │     events+alerts)  · status bands                   GET /stream (SSE)
  via config.json      │                     · transition→alert               public/index.html
                       └── every event / 30s heartbeat re-evaluates & broadcasts
```

- **Ingest** (`src/app.js`): webhooks and generic events are validated, mapped to a
  team, and appended to the store.
- **Store** (`src/store.js`): the only stateful layer, hidden behind a small
  interface (`addEvent`, `eventsForTeam`, `lastSeenByType`, `addAlert`, ...).
  Backend is **`node:sqlite` (`DatabaseSync`)** — verified working on Node 22 with
  the `--experimental-sqlite` flag, which is baked into every npm script. Swap the
  backend by reimplementing that interface.
- **Score** (`src/score.js`): pure functions. Every event has a weight
  (commit 3, discord_message 1, portal_login 0.5, checkin 2 — configurable); the
  engagement score is the sum of weights with exponential time decay
  (`2^(-age/halfLife)`, half-life default 3 h). Scores are computed at query time —
  `now` is injected everywhere, `Date.now()` never appears in a pure function.
- **Status bands**: `active` (score ≥ `thresholds.active`), `cooling`
  (score ≥ `thresholds.dark`, or low score but recent activity), `dark`
  (score < `thresholds.dark` **and** silent for > `darkAfterMinutes`), `new`
  (zero events ever). Worsening transitions out of active/cooling are persisted as
  **alerts** and pushed on the stream.
- **Live** (`GET /stream`): Server-Sent Events. Full summary snapshot on connect,
  an `update` frame on every ingested event, a `heartbeat` frame every 30 s (which
  also catches decay-only transitions — a team can go dark without any event
  arriving).

## Run

```sh
npm start                                    # port 3000, ./config.json, ./data/engagement.db
PORT=8080 npm start
node --experimental-sqlite bin/server.js --config my-event.json --db ./data/ev.db --port 3000
```

Open `http://localhost:3000/` for the dashboard: team cards sorted worst-first,
big score, status color, per-signal "last commit 4h ago", 24 h SVG sparkline,
header totals, live updates via EventSource — one self-contained HTML file, no CDN.

## Demo (no real integrations needed)

```sh
npm run demo
```

Boots the server with `scripts/demo-config.json` (10 fake teams, decay half-life
compressed to ~72 s so a whole hackathon lifecycle fits in minutes), backfills 24 h
of history for the sparklines, then live-streams events: seven teams stay active,
**Sleepless Sockets** goes quiet at +45 s and **Segfault Society** at +90 s (watch
them slide active → cooling → dark and fire alerts), and **Ghost Shell** never
starts. One team's commits arrive through the real GitHub webhook endpoint with
realistic push payloads. Point it at an already-running server with
`node --experimental-sqlite scripts/simulate.js http://localhost:3000`.

## Endpoints

| Method | Path                | What                                                                                      |
| ------ | ------------------- | ----------------------------------------------------------------------------------------- |
| POST   | `/webhooks/github`  | GitHub push events. Maps `repository.full_name` → team via config; one `commit` event per commit (timestamp/author from payload). Optional HMAC (below). Non-push events are acked and ignored. |
| POST   | `/events`           | Generic signal: `{"team":"team-14","type":"discord_message","at":"<ISO, optional>","weight":<optional>,"meta":{...}}` → 201. Unknown team → 400. |
| GET    | `/api/teams`        | All teams: score, status, last-activity per signal type, 24 h sparkline (48 × 30-min buckets), totals, recent alerts. |
| GET    | `/api/teams/:id`    | Full detail: summary + last 50 events + per-team alerts.                                   |
| GET    | `/stream`           | SSE: `snapshot` on connect, `update` per ingested event, `heartbeat` every 30 s.           |
| GET    | `/`                 | Dashboard.                                                                                 |
| GET    | `/healthz`          | Liveness + backend info.                                                                   |

## Config (`config.json`, `--config path`)

```json
{
  "teams": [
    { "id": "team-1", "name": "Byte Bandits",
      "repos": ["your-org/team1-repo"], "members": ["ada", "grace"] }
  ],
  "thresholds": { "active": 6, "dark": 2, "darkAfterMinutes": 120 },
  "halfLifeHours": 3,
  "weights": { "commit": 3, "discord_message": 1, "portal_login": 0.5, "checkin": 2 }
}
```

## Wiring a real GitHub org webhook

1. Org **Settings → Webhooks → Add webhook** (one org-level hook covers every team repo).
2. Payload URL: `https://<your-host>/webhooks/github` · Content type: `application/json`
   · Events: **Just the push event**.
3. Set a secret and start the server with it:
   `GITHUB_WEBHOOK_SECRET=<secret> npm start`. Signatures
   (`X-Hub-Signature-256`) are then verified with `crypto.timingSafeEqual`;
   mismatches get 401. Without the env var, verification is skipped.
4. List each team's repos under `repos` in the config (matched case-insensitively).
   Pushes to unmapped repos are acked with `{"matched": false}` and dropped.

For Discord/portal signals, point a bot or a login hook at `POST /events`.

## Tests

```sh
npm test
```

`node:test` only. Covers: decay math (score halves after one half-life), band
transitions, alert generation (injected `now`), store round-trips + sparkline
bucketing + file persistence across reopen, HTTP ingest → query on an ephemeral
port, GitHub webhook parsing on a realistic push fixture, HMAC accept/reject, and
an SSE integration test (connect, POST an event, assert the update frame).

## Notes / limits

- Storage is `node:sqlite` — experimental in Node 22 but exercised by the test
  suite in this repo. If a future Node build drops it, reimplement `src/store.js`
  (an append-only JSONL log + replay is the intended fallback).
- Alerts are generated wherever an evaluation happens (event ingest, heartbeat,
  API reads), so decay-driven transitions are recorded within one heartbeat even
  with no traffic.
- One process, one SQLite file. That's plenty for a hackathon-sized fleet; put it
  behind a reverse proxy for TLS.
