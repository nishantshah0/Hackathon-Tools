import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStore } from '../src/store.js';
import { normalizeConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const CONFIG = normalizeConfig({
  teams: [{ id: 'team-1', name: 'Byte Bandits', repos: [], members: [] }],
  // one commit (weight 3) is enough to be "active" in this fixture
  thresholds: { active: 2, dark: 0.5, darkAfterMinutes: 120 },
});

function startApp(opts = {}) {
  const store = createStore();
  const server = createApp({ store, config: CONFIG, heartbeatMs: 250, ...opts });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => { server.close(r); store.close(); }),
      });
    });
  });
}

/**
 * Open /stream and collect parsed SSE frames [{event, data}] into `frames`.
 * Resolves once connected; returns a disconnect function.
 */
function connectStream(base, frames) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/stream`, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame = { event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data += line.slice(6);
          }
          if (frame.data) frame.json = JSON.parse(frame.data);
          frames.push(frame);
        }
      });
      resolve(() => req.destroy());
    });
    req.on('error', reject);
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('SSE: snapshot on connect, update frame after POST /events, heartbeats flow', async () => {
  const app = await startApp();
  const frames = [];
  const disconnect = await connectStream(app.base, frames);
  try {
    assert.ok(await waitFor(() => frames.some((f) => f.event === 'snapshot')), 'no snapshot frame');
    const snap = frames.find((f) => f.event === 'snapshot').json;
    assert.equal(snap.teams.length, 1);
    assert.equal(snap.teams[0].status, 'new');

    const res = await fetch(`${app.base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team: 'team-1', type: 'commit' }),
    });
    assert.equal(res.status, 201);

    assert.ok(await waitFor(() => frames.some((f) => f.event === 'update')), 'no update frame after event');
    const update = frames.findLast((f) => f.event === 'update').json;
    const team = update.teams[0];
    assert.equal(team.id, 'team-1');
    assert.equal(team.status, 'active');
    assert.ok(team.score >= 2.9, `score in update frame should reflect the commit, got ${team.score}`);
    assert.ok(team.lastSeen.commit, 'update frame carries lastSeen.commit');

    assert.ok(
      await waitFor(() => frames.some((f) => f.event === 'heartbeat')),
      'no heartbeat frame (heartbeatMs=250)'
    );
  } finally {
    disconnect();
    await app.close();
  }
});
