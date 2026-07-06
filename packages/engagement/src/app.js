// HTTP app: routing, ingest, summaries, alert bookkeeping, SSE. node:http only.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeScore, statusFor, detectTransitions, bucketSeries, eventWeight } from './score.js';
import { verifySignature, parsePushEvent } from './github.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 1_000_000; // 1 MB

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
  });
  res.end(buf);
}

/**
 * createApp({ store, config, githubSecret?, now?, heartbeatMs? }) -> http.Server
 * `config` must be a normalized config (src/config.js).
 */
export function createApp({
  store,
  config,
  githubSecret = process.env.GITHUB_WEBHOOK_SECRET || null,
  now = () => Date.now(),
  heartbeatMs = 30_000,
}) {
  const sseClients = new Set();
  const lastStatuses = new Map(); // teamId -> last observed status

  const scoreWindowMs = Math.min(Math.max(24 * 3_600_000, config.halfLifeMs * 20), 7 * 24 * 3_600_000);

  function teamSummary(team, t) {
    const events = store.eventsForTeam(team.id, { since: t - scoreWindowMs, until: t });
    const lastEventAt = store.lastEventAt(team.id);
    const score = computeScore(events, t, {
      halfLifeMs: config.halfLifeMs,
      weights: config.weights,
    });
    const status = statusFor({ score, lastEventAt, now: t, thresholds: config.thresholds });
    const lastSeenMs = store.lastSeenByType(team.id);
    const lastSeen = {};
    for (const [type, at] of Object.entries(lastSeenMs)) lastSeen[type] = iso(at);
    return {
      id: team.id,
      name: team.name,
      members: team.members,
      repos: team.repos,
      score: Math.round(score * 100) / 100,
      status,
      lastEventAt: iso(lastEventAt),
      lastSeen,
      sparkline: bucketSeries(events, t, { weights: config.weights }).map((b) => ({
        t: b.t,
        count: b.count,
        weight: Math.round(b.weight * 100) / 100,
      })),
    };
  }

  /**
   * Compute all summaries at time t, detect band transitions since the last
   * evaluation, persist alerts for worsening transitions, and return
   * { teams, totals, newAlerts }.
   */
  function evaluate(t) {
    const teams = config.teams.map((team) => teamSummary(team, t));
    const next = new Map(teams.map((s) => [s.id, s.status]));
    const transitions = detectTransitions(lastStatuses, next);
    const newAlerts = [];
    for (const tr of transitions) {
      const summary = teams.find((s) => s.id === tr.team);
      newAlerts.push(
        store.addAlert({ team: tr.team, from: tr.from, to: tr.to, at: t, score: summary?.score ?? null })
      );
    }
    for (const [id, status] of next) lastStatuses.set(id, status);
    const totals = { active: 0, cooling: 0, dark: 0, new: 0 };
    for (const s of teams) totals[s.status] = (totals[s.status] ?? 0) + 1;
    return { teams, totals, newAlerts };
  }

  function snapshot(t, extraAlerts = []) {
    const { teams, totals, newAlerts } = evaluate(t);
    return {
      generatedAt: iso(t),
      totals,
      thresholds: config.thresholds,
      teams,
      alerts: store.recentAlerts(20).map((a) => ({ ...a, at: iso(a.at) })),
      newAlerts: [...extraAlerts, ...newAlerts].map((a) => ({ ...a, at: iso(a.at) })),
    };
  }

  function broadcast(eventName, data) {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(frame);
  }

  function pushUpdate(eventName = 'update') {
    if (sseClients.size === 0 && eventName !== 'heartbeat') {
      // Still evaluate so alerts are recorded even with no listeners.
      evaluate(now());
      return;
    }
    broadcast(eventName, snapshot(now()));
  }

  // Prime lastStatuses from persisted events without generating alerts.
  evaluate(now());

  const heartbeat = setInterval(() => pushUpdate('heartbeat'), heartbeatMs);
  heartbeat.unref?.();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // --- ingest: generic events ------------------------------------------
    if (req.method === 'POST' && path === '/events') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      const { team, type } = body;
      if (!team || !type) return sendJson(res, 400, { error: 'team and type are required' });
      if (!config.teamsById.has(team)) return sendJson(res, 400, { error: `unknown team: ${team}` });
      let at = now();
      if (body.at != null) {
        const parsed = typeof body.at === 'number' ? body.at : Date.parse(body.at);
        if (!Number.isFinite(parsed)) return sendJson(res, 400, { error: 'invalid at timestamp' });
        at = parsed;
      }
      const weight =
        typeof body.weight === 'number' && Number.isFinite(body.weight) ? body.weight : null;
      const stored = store.addEvent({ team, type, at, weight, meta: body.meta ?? null });
      pushUpdate();
      return sendJson(res, 201, {
        ok: true,
        event: { ...stored, at: iso(stored.at), effectiveWeight: eventWeight(stored, config.weights) },
      });
    }

    // --- ingest: GitHub push webhook --------------------------------------
    if (req.method === 'POST' && path === '/webhooks/github') {
      const raw = await readBody(req);
      if (githubSecret) {
        const sig = req.headers['x-hub-signature-256'];
        if (!verifySignature(raw, sig, githubSecret)) {
          return sendJson(res, 401, { error: 'invalid signature' });
        }
      }
      const ghEvent = req.headers['x-github-event'];
      if (ghEvent && ghEvent !== 'push') {
        return sendJson(res, 200, { ok: true, ignored: true, reason: `event ${ghEvent} not handled` });
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      const { repo, team, events } = parsePushEvent(payload, config.repoToTeam);
      if (!team) {
        return sendJson(res, 200, { ok: true, matched: false, repo });
      }
      const t = now();
      for (const ev of events) {
        store.addEvent({ ...ev, at: Number.isFinite(ev.at) ? ev.at : t });
      }
      if (events.length > 0) pushUpdate();
      return sendJson(res, 200, { ok: true, matched: true, repo, team, ingested: events.length });
    }

    // --- API ---------------------------------------------------------------
    if (req.method === 'GET' && path === '/api/teams') {
      return sendJson(res, 200, snapshot(now()));
    }

    const detail = path.match(/^\/api\/teams\/([^/]+)$/);
    if (req.method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]);
      const team = config.teamsById.get(id);
      if (!team) return sendJson(res, 404, { error: `unknown team: ${id}` });
      const t = now();
      const summary = teamSummary(team, t);
      // Record any transition this fresh evaluation revealed.
      evaluate(t);
      return sendJson(res, 200, {
        generatedAt: iso(t),
        ...summary,
        eventCount: store.eventCount(id),
        recentEvents: store.recentEventsForTeam(id, 50).map((e) => ({
          ...e,
          at: iso(e.at),
          effectiveWeight: eventWeight(e, config.weights),
        })),
        alerts: store.alertsForTeam(id, 20).map((a) => ({ ...a, at: iso(a.at) })),
      });
    }

    // --- SSE ----------------------------------------------------------------
    if (req.method === 'GET' && path === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(now()))}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // --- dashboard -----------------------------------------------------------
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = readFileSync(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      return res.end(html);
    }

    if (req.method === 'GET' && path === '/healthz') {
      return sendJson(res, 200, { ok: true, backend: store.backend, teams: config.teams.length });
    }

    sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.statusCode ?? 500;
      if (!res.headersSent) sendJson(res, status, { error: err.message ?? 'internal error' });
      else res.end();
    });
  });

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const res of sseClients) res.end();
    sseClients.clear();
  });

  return server;
}
