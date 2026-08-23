export interface Rfc3339Instant {
  epochMilliseconds: number;
  orderingSecond: number;
  orderingPhase: -1 | 0;
  fraction: string;
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-](\d{2}):(\d{2}))$/;

export function parseRfc3339Instant(value: string): Rfc3339Instant | undefined {
  const match = RFC3339.exec(value);
  if (!match) return undefined;
  const [
    , yearText, monthText, dayText, hourText, minuteText, secondText, fractionText = "", zone,
    offsetHourText, offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) {
    return undefined;
  }
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;

  const offsetSign = zone.startsWith("+") ? 1 : zone.startsWith("-") ? -1 : 0;
  const offsetMilliseconds = offsetSign * ((offsetHour * 60) + offsetMinute) * 60_000;
  const base = new Date(0);
  base.setUTCFullYear(year, month - 1, day);
  base.setUTCHours(hour, minute, Math.min(second, 59), 0);
  const baseMilliseconds = base.getTime() - offsetMilliseconds;
  if (!Number.isFinite(baseMilliseconds)) return undefined;

  const leapSecond = second === 60;
  if (leapSecond) {
    const utcBoundary = new Date(baseMilliseconds);
    const isLeapBoundary = (utcBoundary.getUTCMonth() === 5 && utcBoundary.getUTCDate() === 30) ||
      (utcBoundary.getUTCMonth() === 11 && utcBoundary.getUTCDate() === 31);
    if (!isLeapBoundary || utcBoundary.getUTCHours() !== 23 || utcBoundary.getUTCMinutes() !== 59) return undefined;
  }

  const normalizedFraction = fractionText.replace(/0+$/, "");
  const fractionMilliseconds = fractionText === "" ? 0 : Number(`${fractionText}00`.slice(0, 3));
  const orderingSecond = (baseMilliseconds / 1000) + (leapSecond ? 1 : 0);
  return {
    epochMilliseconds: leapSecond ? orderingSecond * 1000 : baseMilliseconds + fractionMilliseconds,
    orderingSecond,
    orderingPhase: leapSecond ? -1 : 0,
    fraction: normalizedFraction,
  };
}

export function isRfc3339DateTime(value: string): boolean {
  return parseRfc3339Instant(value) !== undefined;
}

function compareFraction(left: string, right: string): number {
  const length = Math.max(left.length, right.length);
  const normalizedLeft = left.padEnd(length, "0");
  const normalizedRight = right.padEnd(length, "0");
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

export function compareRfc3339Instants(left: Rfc3339Instant, right: Rfc3339Instant): number {
  if (left.orderingSecond !== right.orderingSecond) return left.orderingSecond < right.orderingSecond ? -1 : 1;
  if (left.orderingPhase !== right.orderingPhase) return left.orderingPhase < right.orderingPhase ? -1 : 1;
  return compareFraction(left.fraction, right.fraction);
}
