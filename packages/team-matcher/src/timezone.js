/**
 * Timezone / availability math.
 *
 * Participants declare local availability windows as hours-of-day
 * ({ start: 9, end: 22 }). A window may wrap past midnight by using an
 * end > 24 (e.g. { start: 18, end: 26 } = 18:00 -> 02:00 next day).
 *
 * All comparisons happen on a circular 24h UTC timeline, represented as a
 * merged list of half-open intervals [start, end) with 0 <= start < end <= 24.
 * UTC offsets are derived from the built-in Intl API at a fixed reference
 * date, so results are deterministic (no DST flip-flopping mid-run).
 */

// Fixed reference instant used to resolve each IANA zone's UTC offset.
export const REFERENCE_UTC_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

const offsetCache = new Map();

/**
 * UTC offset in (possibly fractional) hours for an IANA timezone at the
 * reference instant. Asia/Kolkata -> 5.5, America/Los_Angeles -> -8, etc.
 */
export function utcOffsetHours(timeZone, refMs = REFERENCE_UTC_MS) {
  const key = `${timeZone}@${refMs}`;
  if (offsetCache.has(key)) return offsetCache.get(key);

  let dtf;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (err) {
    throw new Error(`Invalid IANA timezone: "${timeZone}"`);
  }

  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(refMs))) {
    parts[type] = value;
  }
  const wallClockAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offset = (wallClockAsUtc - refMs) / 3_600_000;
  offsetCache.set(key, offset);
  return offset;
}

/** Sort + merge overlapping/touching intervals. Input: array of [s, e]. */
export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([s, e]) => e - s > 1e-9)
    .slice()
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1e-9) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

/** Intersect two merged interval lists. Returns a merged interval list. */
export function intersectIntervals(a, b) {
  const out = [];
  for (const [s1, e1] of a) {
    for (const [s2, e2] of b) {
      const s = Math.max(s1, s2);
      const e = Math.min(e1, e2);
      if (e - s > 1e-9) out.push([s, e]);
    }
  }
  return mergeIntervals(out);
}

/** Total hours covered by an interval list. */
export function totalHours(intervals) {
  return intervals.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** Hours of overlap per day between two interval lists. */
export function overlapHours(a, b) {
  return totalHours(intersectIntervals(a, b));
}

/**
 * Convert one local availability window to UTC intervals on [0, 24),
 * splitting at midnight when the shifted window wraps.
 */
function windowToUtc(window, offset) {
  const { start, end } = window;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    start < 0 ||
    start >= 24 ||
    end <= start ||
    end > start + 24
  ) {
    throw new Error(
      `Invalid availability window {start: ${start}, end: ${end}} — need 0 <= start < 24 and start < end <= start + 24`
    );
  }
  const duration = end - start;
  if (duration >= 24) return [[0, 24]];
  let s = (((start - offset) % 24) + 24) % 24;
  const e = s + duration;
  if (e <= 24) return [[s, e]];
  return [
    [s, 24],
    [0, e - 24],
  ];
}

/**
 * A participant's full availability as merged UTC intervals.
 * participant: { timezone: IANA string, availability: [{start, end}, ...] }
 */
export function participantUtcIntervals(participant) {
  const offset = utcOffsetHours(participant.timezone);
  const availability = participant.availability;
  if (!Array.isArray(availability) || availability.length === 0) {
    throw new Error(
      `Participant "${participant.id ?? participant.name}" has no availability windows`
    );
  }
  const all = [];
  for (const window of availability) {
    all.push(...windowToUtc(window, offset));
  }
  return mergeIntervals(all);
}

/** "16.5" -> "16:30", 9 -> "09:00", 24 -> "24:00". */
export function formatHourUtc(h) {
  const whole = Math.floor(h);
  const minutes = Math.round((h - whole) * 60);
  const hh = String(whole).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return `${hh}:${mm}`;
}
