// Pure scoring functions. No I/O, no clocks — `now` is always injected (epoch ms).

export const DEFAULT_WEIGHTS = {
  commit: 3,
  discord_message: 1,
  portal_login: 0.5,
  checkin: 2,
};

export const DEFAULT_HALF_LIFE_MS = 3 * 60 * 60 * 1000; // 3 hours

export const DEFAULT_THRESHOLDS = {
  active: 6, // score >= active  => "active"
  dark: 2, // score >= dark    => "cooling"; below => candidate for "dark"
  darkAfterMinutes: 120, // "dark" additionally requires silence for this long
};

export const STATUS_RANK = { active: 0, new: 1, cooling: 2, dark: 3 };

/** Effective weight of a single event: explicit weight wins, then type table, then 1. */
export function eventWeight(event, weights = DEFAULT_WEIGHTS) {
  if (typeof event.weight === 'number' && Number.isFinite(event.weight)) {
    return event.weight;
  }
  return weights[event.type] ?? 1;
}

/** Exponential decay multiplier for an event `ageMs` old. Future events count fully. */
export function decayFactor(ageMs, halfLifeMs = DEFAULT_HALF_LIFE_MS) {
  if (!(ageMs > 0)) return 1;
  return 2 ** (-ageMs / halfLifeMs);
}

/**
 * Engagement score at time `now`: sum of event weights with exponential time decay.
 * events: [{ type, at (epoch ms), weight? }]
 */
export function computeScore(events, now, opts = {}) {
  const halfLifeMs = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  let score = 0;
  for (const ev of events) {
    score += eventWeight(ev, weights) * decayFactor(now - ev.at, halfLifeMs);
  }
  return score;
}

/**
 * Status band for a team.
 *  - "new":     never produced any event
 *  - "active":  score >= thresholds.active
 *  - "cooling": score >= thresholds.dark, OR low score but recent activity
 *  - "dark":    score < thresholds.dark AND silent for > darkAfterMinutes
 */
export function statusFor({ score, lastEventAt, now, thresholds = DEFAULT_THRESHOLDS }) {
  if (lastEventAt == null) return 'new';
  if (score >= thresholds.active) return 'active';
  if (score >= thresholds.dark) return 'cooling';
  const silentMinutes = (now - lastEventAt) / 60_000;
  return silentMinutes > thresholds.darkAfterMinutes ? 'dark' : 'cooling';
}

/**
 * Compare previous statuses to next statuses and emit alerts for teams that
 * worsened out of an engaged state (active→cooling, active→dark, cooling→dark).
 * prev/next: plain objects or Maps of teamId -> status.
 * Returns [{ team, from, to }].
 */
export function detectTransitions(prev, next) {
  const get = (m, k) => (m instanceof Map ? m.get(k) : m[k]);
  const keys = next instanceof Map ? [...next.keys()] : Object.keys(next);
  const alerts = [];
  for (const team of keys) {
    const from = get(prev, team);
    const to = get(next, team);
    if (!from || !to || from === to) continue;
    const worsened = (STATUS_RANK[to] ?? 0) > (STATUS_RANK[from] ?? 0);
    const wasEngaged = from === 'active' || from === 'cooling';
    if (worsened && wasEngaged && (to === 'cooling' || to === 'dark')) {
      alerts.push({ team, from, to });
    }
  }
  return alerts;
}

/**
 * Bucket events into a fixed time-series for sparklines.
 * Returns `windowHours*60/bucketMinutes` buckets ending at `now`, oldest first:
 * [{ t (bucket start, epoch ms), count, weight }]
 */
export function bucketSeries(events, now, opts = {}) {
  const bucketMinutes = opts.bucketMinutes ?? 30;
  const windowHours = opts.windowHours ?? 24;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const bucketMs = bucketMinutes * 60_000;
  const n = Math.round((windowHours * 60) / bucketMinutes);
  const start = now - n * bucketMs;
  const buckets = Array.from({ length: n }, (_, i) => ({
    t: start + i * bucketMs,
    count: 0,
    weight: 0,
  }));
  for (const ev of events) {
    if (ev.at <= start || ev.at > now) continue;
    const idx = Math.min(n - 1, Math.floor((ev.at - start) / bucketMs));
    buckets[idx].count += 1;
    buckets[idx].weight += eventWeight(ev, weights);
  }
  return buckets;
}
