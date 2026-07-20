// GitHub push-webhook parsing + HMAC signature verification.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an X-Hub-Signature-256 header ("sha256=<hex>") against the raw body.
 * Constant-time comparison via crypto.timingSafeEqual.
 */
export function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Parse a GitHub push-event payload into engagement events.
 * repoToTeam: Map of lowercased "org/repo" -> teamId.
 * Returns { repo, team, events: [{ team, type:'commit', at, meta }] }.
 * `at` may be NaN when the commit timestamp is missing/invalid; caller
 * should substitute ingest time.
 */
export function parsePushEvent(payload, repoToTeam) {
  const repo = payload?.repository?.full_name ?? null;
  const team = repo ? repoToTeam.get(repo.toLowerCase()) ?? null : null;
  if (!repo || !team) return { repo, team: null, events: [] };

  const pusher = payload.pusher?.name ?? payload.pusher?.email ?? null;
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const events = commits.map((c) => ({
    team,
    type: 'commit',
    at: c.timestamp ? Date.parse(c.timestamp) : NaN,
    meta: {
      repo,
      sha: c.id ?? null,
      author: c.author?.username ?? c.author?.name ?? pusher,
      pusher,
      message: typeof c.message === 'string' ? c.message.split('\n')[0].slice(0, 140) : null,
    },
  }));
  return { repo, team, events };
}
