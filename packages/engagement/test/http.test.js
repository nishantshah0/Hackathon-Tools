import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createStore } from '../src/store.js';
import { normalizeConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const CONFIG = normalizeConfig({
  teams: [
    { id: 'team-1', name: 'Byte Bandits', repos: ['Acme-Org/rocket'], members: ['ada'] },
    { id: 'team-2', name: 'Null Pointers', repos: ['acme-org/teapot'], members: ['linus'] },
  ],
  thresholds: { active: 6, dark: 2, darkAfterMinutes: 120 },
  halfLifeHours: 3,
});

function startApp(opts = {}) {
  const store = createStore();
  const server = createApp({ store, config: CONFIG, heartbeatMs: 3_600_000, githubSecret: null, ...opts });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        store,
        close: () => new Promise((r) => { server.close(r); store.close(); }),
      });
    });
  });
}

const PUSH_PAYLOAD = {
  ref: 'refs/heads/main',
  before: '6113728f27ae82c7b1a177c8d03f9e96e0adf246',
  after: '59b20b8d5c6ff8d09518454d4dd8b7b30f095ab5',
  repository: {
    id: 186853002,
    name: 'rocket',
    full_name: 'acme-org/rocket',
    private: false,
  },
  pusher: { name: 'ada', email: 'ada@example.com' },
  commits: [
    {
      id: '59b20b8d5c6ff8d09518454d4dd8b7b30f095ab5',
      message: 'Fix booster separation\n\nlonger body',
      timestamp: '2026-07-04T11:58:00Z',
      author: { name: 'Ada Lovelace', email: 'ada@example.com', username: 'ada' },
    },
    {
      id: 'f95f852bd8fca8fcc58a9a2d6c842781e32a215e',
      message: 'Add telemetry endpoint',
      timestamp: '2026-07-04T11:59:30Z',
      author: { name: 'Grace Hopper', email: 'grace@example.com', username: 'grace' },
    },
  ],
};

test('POST /events then GET /api/teams reflects score, status, lastSeen', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team: 'team-1', type: 'commit' }),
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.ok, true);
    assert.equal(created.event.effectiveWeight, 3);

    await fetch(`${app.base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team: 'team-1', type: 'discord_message' }),
    });
    await fetch(`${app.base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team: 'team-1', type: 'checkin' }),
    });
    await fetch(`${app.base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team: 'team-1', type: 'portal_login' }),
    });

    const list = await (await fetch(`${app.base}/api/teams`)).json();
    assert.equal(list.teams.length, 2);
    const t1 = list.teams.find((t) => t.id === 'team-1');
    const t2 = list.teams.find((t) => t.id === 'team-2');
    // 3 + 1 + 2 + 0.5 = 6.5, minus sub-second decay
    assert.ok(Math.abs(t1.score - 6.5) < 0.05, `expected ~6.5, got ${t1.score}`);
    assert.equal(t1.status, 'active');
    assert.ok(t1.lastSeen.commit);
    assert.ok(t1.lastSeen.discord_message);
    assert.equal(t1.sparkline.length, 48);
    assert.equal(t1.sparkline.at(-1).count, 4);
    assert.equal(t2.status, 'new');
    assert.deepEqual(list.totals, { active: 1, cooling: 0, dark: 0, new: 1 });
  } finally {
    await app.close();
  }
});

test('POST /events validation: unknown team, missing fields, bad timestamp', async () => {
  const app = await startApp();
  try {
    const post = (body) =>
      fetch(`${app.base}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ team: 'ghost', type: 'checkin' })).status, 400);
    assert.equal((await post({ team: 'team-1' })).status, 400);
    assert.equal((await post({ team: 'team-1', type: 'checkin', at: 'yesterday-ish' })).status, 400);
  } finally {
    await app.close();
  }
});

test('GET /api/teams/:id returns detail with recent events and 404 for unknown', async () => {
  const app = await startApp();
  try {
    await fetch(`${app.base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team: 'team-2', type: 'portal_login', meta: { user: 'linus' } }),
    });
    const detail = await (await fetch(`${app.base}/api/teams/team-2`)).json();
    assert.equal(detail.id, 'team-2');
    assert.equal(detail.eventCount, 1);
    assert.equal(detail.recentEvents.length, 1);
    assert.equal(detail.recentEvents[0].type, 'portal_login');
    assert.deepEqual(detail.recentEvents[0].meta, { user: 'linus' });
    assert.equal((await fetch(`${app.base}/api/teams/ghost`)).status, 404);
  } finally {
    await app.close();
  }
});

test('GitHub webhook: realistic push payload maps repo to team (case-insensitive)', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify(PUSH_PAYLOAD),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      { matched: body.matched, team: body.team, ingested: body.ingested },
      { matched: true, team: 'team-1', ingested: 2 }
    );
    const events = app.store.eventsForTeam('team-1');
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'commit');
    assert.equal(events[0].at, Date.parse('2026-07-04T11:58:00Z'));
    assert.equal(events[0].meta.author, 'ada');
    assert.equal(events[0].meta.repo, 'acme-org/rocket');
    assert.equal(events[0].meta.message, 'Fix booster separation');

    // Unmapped repo: acknowledged but not ingested.
    const other = await fetch(`${app.base}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify({ ...PUSH_PAYLOAD, repository: { full_name: 'someone/else' } }),
    });
    assert.deepEqual(await other.json(), { ok: true, matched: false, repo: 'someone/else' });

    // Non-push events are ignored politely.
    const ping = await fetch(`${app.base}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
      body: '{}',
    });
    assert.equal((await ping.json()).ignored, true);
  } finally {
    await app.close();
  }
});

test('GitHub webhook HMAC: valid signature accepted, bad/missing rejected 401', async () => {
  const secret = 'hunter2';
  const app = await startApp({ githubSecret: secret });
  try {
    const raw = JSON.stringify(PUSH_PAYLOAD);
    const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

    const ok = await fetch(`${app.base}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      body: raw,
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ingested, 2);

    const bad = await fetch(`${app.base}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      },
      body: raw,
    });
    assert.equal(bad.status, 401);

    const missing = await fetch(`${app.base}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    assert.equal(missing.status, 401);
  } finally {
    await app.close();
  }
});

test('alert is recorded when a team decays out of active', async () => {
  // Drive the clock manually via injected now().
  let t = Date.parse('2026-07-04T12:00:00Z');
  const app = await startApp({ now: () => t });
  try {
    await fetch(`${app.base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team: 'team-1', type: 'commit', weight: 8 }),
    });
    let list = await (await fetch(`${app.base}/api/teams`)).json();
    assert.equal(list.teams.find((x) => x.id === 'team-1').status, 'active');

    t += 5 * 3_600_000; // 5h later: 8 * 2^(-5/3) ≈ 2.5 => cooling
    list = await (await fetch(`${app.base}/api/teams`)).json();
    const team = list.teams.find((x) => x.id === 'team-1');
    assert.equal(team.status, 'cooling');
    assert.equal(list.alerts.length, 1);
    assert.deepEqual(
      { team: list.alerts[0].team, from: list.alerts[0].from, to: list.alerts[0].to },
      { team: 'team-1', from: 'active', to: 'cooling' }
    );
  } finally {
    await app.close();
  }
});

test('GET / serves the dashboard html', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /EventSource\('\/stream'\)/);
  } finally {
    await app.close();
  }
});
