import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDisplayDate } from '../src/lib/display-date';

test('display dates are stable across server/client time zones, including British summer time', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      assert.equal(formatDisplayDate('2026-11-03T12:53:00Z'), '3 Nov 2026, 12:53');
      assert.equal(formatDisplayDate('2026-07-03T12:53:00Z'), '3 Jul 2026, 13:53');
      assert.equal(formatDisplayDate('2026-11-03T00:00:00Z'), '3 Nov 2026, 00:00');
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('missing or invalid timestamps do not break rendering', () => {
  assert.equal(formatDisplayDate(null), 'never');
  assert.equal(formatDisplayDate('invalid'), 'unknown date');
});
