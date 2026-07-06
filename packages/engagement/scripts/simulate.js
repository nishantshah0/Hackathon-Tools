#!/usr/bin/env node
// Demo simulator: boots the engagement server with a 10-team demo config
// (fast decay so status changes happen in minutes, not hours), backfills 24h
// of history for the sparklines, then live-streams events. Two teams stop
// posting mid-demo and go cooling → dark; one team never starts at all.
//
// Usage:
//   npm run demo                 # spawns its own server on PORT (default 3000)
//   node scripts/simulate.js http://localhost:3000   # target a running server

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(pkgRoot, 'scripts', 'demo-config.json');
const externalUrl = process.argv[2] ?? null;
const port = Number(process.env.PORT ?? 3000);
const base = externalUrl ? externalUrl.replace(/\/$/, '') : `http://localhost:${port}`;

const TEAMS = [
  'team-01', 'team-02', 'team-03', 'team-04', 'team-05',
  'team-06', 'team-07', 'team-08', 'team-09', 'team-10',
];
const REPOS = {
  'team-02': 'infrahacks-demo/null-pointers',
};
const NEVER_STARTS = 'team-10'; // stays "new" forever
const GOES_DARK = { 'team-03': 45_000, 'team-07': 90_000 }; // stop posting at t=+45s / +90s
const MEMBERS = ['ada', 'grace', 'linus', 'margaret', 'ken', 'dennis'];

let child = null;
if (!externalUrl) {
  child = spawn(
    process.execPath,
    ['--experimental-sqlite', join(pkgRoot, 'bin', 'server.js'),
      '--config', configPath, '--db', ':memory:', '--port', String(port)],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  child.on('exit', (code) => {
    console.error(`[simulate] server exited (${code ?? 'signal'})`);
    process.exit(code ?? 1);
  });
}

async function waitForServer(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${base} did not come up`);
}

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 200 && res.status !== 201) {
    console.error(`[simulate] POST ${path} -> ${res.status}: ${await res.text()}`);
  }
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function sendEvent(team, type, at, meta) {
  return post('/events', { team, type, ...(at ? { at: new Date(at).toISOString() } : {}), ...(meta ? { meta } : {}) });
}

function sendGithubPush(team, repo, whenMs, nCommits = 1) {
  const commits = Array.from({ length: nCommits }, (_, i) => ({
    id: Math.random().toString(16).slice(2).padEnd(40, '0'),
    message: pick(['fix build', 'wire up API', 'hack hack hack', 'demo polish', 'add tests']),
    timestamp: new Date(whenMs - i * 1000).toISOString(),
    author: { name: pick(MEMBERS), username: pick(MEMBERS) },
  }));
  return post('/webhooks/github', {
    ref: 'refs/heads/main',
    repository: { full_name: repo },
    pusher: { name: commits[0].author.username },
    commits,
  });
}

async function backfill() {
  console.log('[simulate] backfilling 24h of history for sparklines...');
  const now = Date.now();
  const DAY = 24 * 3_600_000;
  for (const team of TEAMS) {
    if (team === NEVER_STARTS) continue;
    // Each team gets a distinct rhythm: bursts of discord + periodic commits.
    const burstCount = 5 + Math.floor(Math.random() * 4);
    const jobs = [];
    for (let b = 0; b < burstCount; b++) {
      const center = now - DAY + ((b + 0.5) / burstCount) * DAY * (0.85 + Math.random() * 0.15);
      for (let i = 0; i < 3 + Math.floor(Math.random() * 5); i++) {
        jobs.push(sendEvent(team, 'discord_message', center + (Math.random() - 0.5) * 40 * 60_000, { user: pick(MEMBERS) }));
      }
      jobs.push(sendEvent(team, 'commit', center + (Math.random() - 0.5) * 30 * 60_000, { repo: REPOS[team] ?? null, author: pick(MEMBERS) }));
      if (Math.random() < 0.5) jobs.push(sendEvent(team, 'portal_login', center, { user: pick(MEMBERS) }));
    }
    jobs.push(sendEvent(team, 'checkin', now - Math.random() * DAY * 0.5, { via: 'portal' }));
    await Promise.all(jobs);
  }
  console.log('[simulate] backfill done.');
}

async function liveTick(elapsedMs) {
  const jobs = [];
  for (const team of TEAMS) {
    if (team === NEVER_STARTS) continue;
    const stopAt = GOES_DARK[team];
    if (stopAt != null && elapsedMs >= stopAt) continue; // went quiet
    const r = Math.random();
    if (r < 0.35) jobs.push(sendEvent(team, 'discord_message', null, { user: pick(MEMBERS) }));
    if (Math.random() < 0.12) {
      // team-02 demos the real GitHub webhook path; everyone else uses /events.
      if (REPOS[team]) jobs.push(sendGithubPush(team, REPOS[team], Date.now(), 1 + Math.floor(Math.random() * 2)));
      else jobs.push(sendEvent(team, 'commit', null, { author: pick(MEMBERS) }));
    }
    if (Math.random() < 0.06) jobs.push(sendEvent(team, 'portal_login', null, { user: pick(MEMBERS) }));
    if (Math.random() < 0.01) jobs.push(sendEvent(team, 'checkin', null, { via: 'portal' }));
  }
  await Promise.all(jobs);
}

function shutdown() {
  console.log('\n[simulate] stopping.');
  if (child) child.kill('SIGINT');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await waitForServer();
  await backfill();
  console.log('');
  console.log('='.repeat(64));
  console.log(`  Dashboard:  ${base}/`);
  console.log('  Scenario:   7 teams stay active, Sleepless Sockets stops at');
  console.log('              +45s and Segfault Society at +90s (watch them cool');
  console.log('              and go dark over ~5 min), Ghost Shell never starts.');
  console.log('  Ctrl+C to stop.');
  console.log('='.repeat(64));
  console.log('');
  const started = Date.now();
  const announced = new Set();
  setInterval(() => {
    const elapsed = Date.now() - started;
    for (const [team, stopAt] of Object.entries(GOES_DARK)) {
      if (elapsed >= stopAt && !announced.has(team)) {
        announced.add(team);
        console.log(`[simulate] ${team} just went quiet — watch it slide to cooling, then dark.`);
      }
    }
    liveTick(elapsed).catch((err) => console.error('[simulate] tick error:', err.message));
  }, 900);
} catch (err) {
  console.error('[simulate] fatal:', err.message);
  if (child) child.kill('SIGINT');
  process.exit(1);
}
