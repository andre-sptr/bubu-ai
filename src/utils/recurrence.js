const WEEKDAY_MAP = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
});

const RECURRENCE_INTERVAL_RE = /^every:(\d{1,3})(m|h|d)$/;
const INTERVAL_UNIT_MS = Object.freeze({
  m: 60000,
  h: 3600000,
  d: 86400000
});

/**
 * Validate and normalize a reminder recurrence rule.
 */
function normalizeRecurrence(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const raw = String(value).trim().toLowerCase();
  if (['daily', 'weekdays', 'weekly', 'monthly'].includes(raw)) {
    return raw;
  }
  const match = raw.match(RECURRENCE_INTERVAL_RE);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const totalMinutes = unit === 'm' ? amount : unit === 'h' ? amount * 60 : amount * 1440;
    if (totalMinutes >= 5 && totalMinutes <= 365 * 1440) {
      return `every:${amount}${unit}`;
    }
  }
  throw new Error('Unsupported recurrence pattern. Use daily, weekdays, weekly, monthly, or every:<N><m|h|d>.');
}

/**
 * Return local wall-clock calendar components for a UTC timestamp in the given IANA timezone.
 */
function getLocalDateParts(ms = Date.now(), timezone = 'Asia/Jakarta') {
  const safeMs = Number.isFinite(Number(ms)) ? Number(ms) : Date.now();
  const build = (tz) => {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23'
    });
    const map = Object.fromEntries(dtf.formatToParts(new Date(safeMs)).map((part) => [part.type, part.value]));
    const year = Number(map.year);
    const month = Number(map.month);
    const day = Number(map.day);
    const rawHour = Number(map.hour);
    const hour = rawHour === 24 ? 0 : rawHour;
    const minute = Number(map.minute);
    const second = Number(map.second);
    const weekdayShort = map.weekday || 'Sun';
    const weekdayIndex = WEEKDAY_MAP[weekdayShort] ?? 0;
    const dateKey = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { year, month, day, hour, minute, second, weekdayShort, weekdayIndex, dateKey };
  };

  try {
    return build(String(timezone || 'Asia/Jakarta').trim() || 'Asia/Jakarta');
  } catch {
    return build('Asia/Jakarta');
  }
}

/**
 * Resolve a local wall-clock calendar tuple into UTC milliseconds for the given timezone.
 */
function localWallClockToUtcMs({ year, month, day, hour, minute, second = 0 }, timezone = 'Asia/Jakarta') {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i++) {
    const actual = getLocalDateParts(guess, timezone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = desiredUtc - actualUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Compute the next UTC ISO timestamp strictly after `nowMs` for a recurring reminder.
 */
function computeNextRecurrenceIso(fromIso, recurrence, { nowMs = Date.now(), timezone = 'Asia/Jakarta' } = {}) {
  const spec = normalizeRecurrence(recurrence);
  if (!spec) return null;

  const parsedBase = Date.parse(fromIso);
  const baseMs = Number.isFinite(parsedBase) ? parsedBase : nowMs;

  if (spec.startsWith('every:')) {
    const match = spec.match(RECURRENCE_INTERVAL_RE);
    const amount = Number(match[1]);
    const stepMs = amount * INTERVAL_UNIT_MS[match[2]];
    if (baseMs > nowMs) {
      return new Date(baseMs + stepMs).toISOString();
    }
    const steps = Math.floor((nowMs - baseMs) / stepMs) + 1;
    return new Date(baseMs + steps * stepMs).toISOString();
  }

  const origin = getLocalDateParts(baseMs, timezone);
  const anchorDay = origin.day;

  if (spec === 'monthly') {
    for (let monthOffset = 1; monthOffset <= 120; monthOffset++) {
      const totalMonths = origin.year * 12 + (origin.month - 1) + monthOffset;
      const targetYear = Math.floor(totalMonths / 12);
      const targetMonth = (totalMonths % 12) + 1;
      const targetDay = Math.min(anchorDay, daysInMonth(targetYear, targetMonth));
      const candidateMs = localWallClockToUtcMs({
        year: targetYear,
        month: targetMonth,
        day: targetDay,
        hour: origin.hour,
        minute: origin.minute,
        second: origin.second
      }, timezone);
      if (candidateMs > nowMs) {
        return new Date(candidateMs).toISOString();
      }
    }
    return null;
  }

  const dayStep = spec === 'weekly' ? 7 : 1;
  const cursor = new Date(Date.UTC(origin.year, origin.month - 1, origin.day));
  for (let i = 0; i < 1000; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + dayStep);
    const candidateMs = localWallClockToUtcMs({
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
      hour: origin.hour,
      minute: origin.minute,
      second: origin.second
    }, timezone);
    if (candidateMs <= nowMs) continue;
    if (spec === 'weekdays') {
      const parts = getLocalDateParts(candidateMs, timezone);
      if (parts.weekdayIndex === 0 || parts.weekdayIndex === 6) continue;
    }
    return new Date(candidateMs).toISOString();
  }
  return null;
}

/**
 * Parse a `HH:MM` wall-clock string into the next future ISO timestamp in `timezone`.
 */
function parseNextWallClockIso(hhmm, { nowMs = Date.now(), timezone = 'Asia/Jakarta', weekdaysOnly = false } = {}) {
  const match = String(hhmm || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const targetHour = Number(match[1]);
  const targetMinute = Number(match[2]);
  const nowParts = getLocalDateParts(nowMs, timezone);
  const cursor = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));

  for (let i = 0; i < 14; i++) {
    const candidateMs = localWallClockToUtcMs({
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
      hour: targetHour,
      minute: targetMinute,
      second: 0
    }, timezone);
    if (candidateMs > nowMs) {
      const candidateParts = getLocalDateParts(candidateMs, timezone);
      if (!weekdaysOnly || (candidateParts.weekdayIndex >= 1 && candidateParts.weekdayIndex <= 5)) {
        return new Date(candidateMs).toISOString();
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

module.exports = {
  RECURRENCE_INTERVAL_RE,
  normalizeRecurrence,
  getLocalDateParts,
  localWallClockToUtcMs,
  computeNextRecurrenceIso,
  parseNextWallClockIso
};
