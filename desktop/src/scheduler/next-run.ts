import { Effect } from 'effect';
import type { ScheduleTrigger, WeeklyTrigger } from './types.js';

const MINUTE_MS = 60_000;
const MAX_WEEKLY_SEARCH_MINUTES = 9 * 24 * 60;
const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export class InvalidScheduleTriggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleTriggerError';
  }
}

/** Returns the first occurrence strictly after `after`. */
export function nextRunAfter(trigger: ScheduleTrigger, after: Date): Date | null {
  if (!Number.isFinite(after.getTime())) throw new InvalidScheduleTriggerError('comparison time must be valid');

  switch (trigger.kind) {
    case 'once': {
      const runAt = parseInstant(trigger.runAt, 'runAt');
      return runAt.getTime() > after.getTime() ? runAt : null;
    }
    case 'interval': {
      if (!Number.isInteger(trigger.everyMinutes) || trigger.everyMinutes < 1 || trigger.everyMinutes > 525_600) {
        throw new InvalidScheduleTriggerError('everyMinutes must be an integer between 1 and 525600');
      }
      const anchor = parseInstant(trigger.anchorAt, 'anchorAt');
      if (anchor.getTime() > after.getTime()) return anchor;
      const period = trigger.everyMinutes * MINUTE_MS;
      const elapsedPeriods = Math.floor((after.getTime() - anchor.getTime()) / period) + 1;
      return new Date(anchor.getTime() + elapsedPeriods * period);
    }
    case 'weekly':
      return nextWeeklyRun(trigger, after);
  }
}

/** Validates a trigger without requiring it to have a future occurrence. */
export function validateTrigger(trigger: ScheduleTrigger): void {
  if (!trigger || typeof trigger !== 'object') throw new InvalidScheduleTriggerError('trigger is required');
  switch (trigger.kind) {
    case 'once':
      parseInstant(trigger.runAt, 'runAt');
      return;
    case 'interval':
      if (!Number.isInteger(trigger.everyMinutes) || trigger.everyMinutes < 1 || trigger.everyMinutes > 525_600) {
        throw new InvalidScheduleTriggerError('everyMinutes must be an integer between 1 and 525600');
      }
      parseInstant(trigger.anchorAt, 'anchorAt');
      return;
    case 'weekly':
      validateWeeklyTrigger(trigger);
      return;
    default:
      throw new InvalidScheduleTriggerError('unsupported trigger kind');
  }
}

function nextWeeklyRun(trigger: WeeklyTrigger, after: Date): Date {
  const { hour, minute, days } = validateWeeklyTrigger(trigger);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: trigger.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  // Searching real instants rather than synthesizing a UTC offset makes DST
  // gaps skip naturally and chooses the first occurrence when a minute repeats.
  let instant = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let index = 0; index < MAX_WEEKLY_SEARCH_MINUTES; index += 1, instant += MINUTE_MS) {
    const parts = formatter.formatToParts(new Date(instant));
    const weekday = WEEKDAYS[parts.find((part) => part.type === 'weekday')?.value ?? ''];
    if (weekday === undefined) throw new InvalidScheduleTriggerError(`cannot read weekdays in time zone '${trigger.timeZone}'`);
    const localHour = Number(parts.find((part) => part.type === 'hour')?.value);
    const localMinute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (days.has(weekday) && localHour === hour && localMinute === minute) {
      return new Date(instant);
    }
  }

  throw new InvalidScheduleTriggerError(`could not find the next occurrence in time zone '${trigger.timeZone}'`);
}

function validateWeeklyTrigger(trigger: WeeklyTrigger): { hour: number; minute: number; days: Set<number> } {
  if (!Array.isArray(trigger.daysOfWeek) || trigger.daysOfWeek.length === 0) {
    throw new InvalidScheduleTriggerError('daysOfWeek must contain at least one day');
  }
  const days = new Set<number>();
  for (const day of trigger.daysOfWeek) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new InvalidScheduleTriggerError('daysOfWeek values must be integers from 0 through 6');
    }
    days.add(day);
  }

  if (typeof trigger.time !== 'string') throw new InvalidScheduleTriggerError('time must use HH:mm format');
  const match = /^(\d{2}):(\d{2})$/.exec(trigger.time);
  if (!match) throw new InvalidScheduleTriggerError('time must use HH:mm format');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new InvalidScheduleTriggerError('time must be a valid 24-hour time');

  if (typeof trigger.timeZone !== 'string' || !trigger.timeZone.trim()) {
    throw new InvalidScheduleTriggerError('timeZone is required');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trigger.timeZone }).format(0);
  } catch {
    throw new InvalidScheduleTriggerError(`unknown time zone '${trigger.timeZone}'`);
  }

  return { hour, minute, days };
}

function parseInstant(value: string, field: string): Date {
  if (typeof value !== 'string' || value.trim() === '') throw new InvalidScheduleTriggerError(`${field} is required`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new InvalidScheduleTriggerError(`${field} must be a valid ISO-8601 instant`);
  return parsed;
}

// Effect wrappers (additive): pure cron math stays untouched above; timer and
// dispatch code composes these Effects instead of try/catch around the
// throwing functions.
export function nextRunAfterEffect(
  trigger: ScheduleTrigger,
  after: Date,
): Effect.Effect<Date | null, InvalidScheduleTriggerError> {
  return Effect.try({
    try: () => nextRunAfter(trigger, after),
    catch: (error) =>
      error instanceof InvalidScheduleTriggerError
        ? error
        : new InvalidScheduleTriggerError(String(error)),
  });
}

export function validateTriggerEffect(
  trigger: ScheduleTrigger,
): Effect.Effect<void, InvalidScheduleTriggerError> {
  return Effect.try({
    try: () => validateTrigger(trigger),
    catch: (error) =>
      error instanceof InvalidScheduleTriggerError
        ? error
        : new InvalidScheduleTriggerError(String(error)),
  });
}

