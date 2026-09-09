import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRunAfter } from './next-run.js';
import type { ScheduleTrigger } from './types.js';

test('one-time schedules only return an occurrence strictly in the future', () => {
  const trigger = { kind: 'once', runAt: '2026-09-09T12:00:00.000Z' } satisfies ScheduleTrigger;
  assert.equal(nextRunAfter(trigger, new Date('2026-09-09T11:59:59.999Z'))?.toISOString(), trigger.runAt);
  assert.equal(nextRunAfter(trigger, new Date(trigger.runAt)), null);
});

test('interval schedules stay anchored instead of drifting from the current time', () => {
  const trigger = { kind: 'interval', everyMinutes: 15, anchorAt: '2026-09-09T12:00:00.000Z' } satisfies ScheduleTrigger;
  assert.equal(
    nextRunAfter(trigger, new Date('2026-09-09T12:37:00.000Z'))?.toISOString(),
    '2026-09-09T12:45:00.000Z',
  );
});

test('weekly schedules calculate wall-clock time in the approved IANA time zone', () => {
  const trigger = {
    kind: 'weekly',
    daysOfWeek: [1],
    time: '08:00',
    timeZone: 'America/New_York',
  } satisfies ScheduleTrigger;
  assert.equal(
    nextRunAfter(trigger, new Date('2026-09-06T12:00:00.000Z'))?.toISOString(),
    '2026-09-07T12:00:00.000Z',
  );
});

test('weekly schedules skip a wall-clock minute that does not exist during DST', () => {
  const trigger = {
    kind: 'weekly',
    daysOfWeek: [0],
    time: '02:30',
    timeZone: 'America/New_York',
  } satisfies ScheduleTrigger;
  assert.equal(
    nextRunAfter(trigger, new Date('2026-03-07T12:00:00.000Z'))?.toISOString(),
    '2026-03-15T06:30:00.000Z',
  );
});
