import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  utcOffsetHours,
  participantUtcIntervals,
  overlapHours,
  mergeIntervals,
  intersectIntervals,
  totalHours,
  formatHourUtc,
} from '../src/index.js';

test('utcOffsetHours resolves known zones at the fixed reference date (January)', () => {
  assert.equal(utcOffsetHours('UTC'), 0);
  assert.equal(utcOffsetHours('Asia/Kolkata'), 5.5);
  assert.equal(utcOffsetHours('America/Los_Angeles'), -8);
  assert.equal(utcOffsetHours('America/New_York'), -5);
  assert.equal(utcOffsetHours('Asia/Tokyo'), 9);
  assert.equal(utcOffsetHours('Australia/Eucla'), 8.75);
});

test('utcOffsetHours throws on invalid timezone', () => {
  assert.throws(() => utcOffsetHours('Mars/Olympus_Mons'), /Invalid IANA timezone/);
});

test('participantUtcIntervals converts a simple window', () => {
  const p = { timezone: 'Asia/Kolkata', availability: [{ start: 9, end: 22 }] };
  assert.deepEqual(participantUtcIntervals(p), [[3.5, 16.5]]);
});

test('day-wrapping local window (18-26) splits across UTC midnight', () => {
  const p = { timezone: 'UTC', availability: [{ start: 18, end: 26 }] };
  assert.deepEqual(participantUtcIntervals(p), [
    [0, 2],
    [18, 24],
  ]);
});

test('window that wraps only after timezone shift', () => {
  // NY (-5): local 20-23 -> UTC 25-28 -> [1, 4)
  const p = { timezone: 'America/New_York', availability: [{ start: 20, end: 23 }] };
  assert.deepEqual(participantUtcIntervals(p), [[1, 4]]);
});

test('tricky pair: Asia/Kolkata 9-22 vs America/Los_Angeles 9-22 overlaps 2.5h', () => {
  const kolkata = participantUtcIntervals({
    timezone: 'Asia/Kolkata',
    availability: [{ start: 9, end: 22 }],
  });
  // LA 9-22 local -> UTC 17-30 -> [17,24) + [0,6)
  const la = participantUtcIntervals({
    timezone: 'America/Los_Angeles',
    availability: [{ start: 9, end: 22 }],
  });
  assert.deepEqual(la, [
    [0, 6],
    [17, 24],
  ]);
  assert.equal(overlapHours(kolkata, la), 2.5);
  assert.equal(overlapHours(la, kolkata), 2.5); // symmetric
});

test('day-wrapping windows overlap correctly across midnight', () => {
  const nightOwl = participantUtcIntervals({
    timezone: 'UTC',
    availability: [{ start: 18, end: 26 }],
  });
  const earlyBird = participantUtcIntervals({
    timezone: 'UTC',
    availability: [{ start: 0, end: 3 }],
  });
  assert.equal(overlapHours(nightOwl, earlyBird), 2); // [0,2)
});

test('multiple windows are merged before overlap computation', () => {
  const p = participantUtcIntervals({
    timezone: 'UTC',
    availability: [
      { start: 9, end: 13 },
      { start: 12, end: 15 },
    ],
  });
  assert.deepEqual(p, [[9, 15]]);
  assert.equal(totalHours(p), 6);
});

test('mergeIntervals and intersectIntervals behave on edge cases', () => {
  assert.deepEqual(mergeIntervals([]), []);
  assert.deepEqual(
    mergeIntervals([
      [5, 6],
      [1, 3],
      [2, 4],
    ]),
    [
      [1, 4],
      [5, 6],
    ]
  );
  assert.deepEqual(
    intersectIntervals(
      [
        [0, 5],
        [10, 20],
      ],
      [[4, 12]]
    ),
    [
      [4, 5],
      [10, 12],
    ]
  );
  assert.deepEqual(intersectIntervals([[0, 5]], [[5, 10]]), []);
});

test('invalid availability windows are rejected', () => {
  assert.throws(
    () =>
      participantUtcIntervals({ timezone: 'UTC', availability: [{ start: 25, end: 26 }] }),
    /Invalid availability window/
  );
  assert.throws(
    () => participantUtcIntervals({ timezone: 'UTC', availability: [{ start: 10, end: 9 }] }),
    /Invalid availability window/
  );
  assert.throws(
    () => participantUtcIntervals({ id: 'x', timezone: 'UTC', availability: [] }),
    /no availability windows/
  );
});

test('formatHourUtc renders fractional hours', () => {
  assert.equal(formatHourUtc(9), '09:00');
  assert.equal(formatHourUtc(16.5), '16:30');
  assert.equal(formatHourUtc(3.5), '03:30');
  assert.equal(formatHourUtc(24), '24:00');
});
