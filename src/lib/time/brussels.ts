/**
 * Brussels (Europe/Brussels) timezone helpers.
 * Brussels observes CET (UTC+1) in winter and CEST (UTC+2) in summer.
 * We compute offsets dynamically using Intl API (no TZ DB required).
 */

const BRUSSELS_TZ = "Europe/Brussels";

/** Returns the current time in Brussels as a JS Date. */
export function nowInBrussels(): Date {
  const now = new Date();
  return brusselsInstant(now);
}

function brusselsInstant(d: Date): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BRUSSELS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  let hh = get("hour");
  if (hh === "24") hh = "00";
  const mi = get("minute");
  const ss = get("second");
  const brusselsWallString = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
  const offsetMin = getBrusselsOffsetMinutes(d);
  const utcMs = Date.parse(brusselsWallString + "Z") - offsetMin * 60_000;
  return new Date(utcMs);
}

/** Returns Brussels offset (in minutes) for the given date. */
export function getBrusselsOffsetMinutes(d: Date = new Date()): number {
  const brusselsParts = new Intl.DateTimeFormat("en-US", {
    timeZone: BRUSSELS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(brusselsParts.find((p) => p.type === t)?.value ?? "0");
  const utc = new Date(d.getTime());
  const utcMs = Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes());
  const brusselsMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") === 24 ? 0 : get("hour"), get("minute"));
  return Math.round((brusselsMs - utcMs) / 60_000);
}

/** Returns Brussels date string "YYYY-MM-DD" for a given Date (defaults to now). */
export function brusselsDateString(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: BRUSSELS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/** Returns Brussels kickoff time "HH:MM" for a given UTC Date. */
export function brusselsKickoffTime(utcDate: Date): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: BRUSSELS_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const s = fmt.format(utcDate);
  return s === "24:00" ? "00:00" : s;
}

/** Parses a Brussels wall-clock time on a given Brussels date and returns UTC Date. */
export function brusselsTimeToUtc(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mi] = timeStr.split(":").map(Number);
  const tentativeUtc = new Date(Date.UTC(y, m - 1, d, hh - 1, mi));
  const offsetMin = getBrusselsOffsetMinutes(tentativeUtc);
  return new Date(Date.UTC(y, m - 1, d, hh, mi) - offsetMin * 60_000);
}

/**
 * Computes the next 00:00 Brussels instant strictly after `from`.
 * Used by the daily scheduler.
 */
export function nextMidnightBrussels(from: Date = new Date()): Date {
  const dateStr = brusselsDateString(from);
  const [y, m, d] = dateStr.split("-").map(Number);
  const todayMidnightUtcApprox = new Date(Date.UTC(y, m - 1, d, -1, 0));
  const offsetMin = getBrusselsOffsetMinutes(todayMidnightUtcApprox);
  const todayMidnightUtc = new Date(Date.UTC(y, m - 1, d, 0, 0) - offsetMin * 60_000);
  if (todayMidnightUtc.getTime() > from.getTime()) {
    return todayMidnightUtc;
  }
  return new Date(todayMidnightUtc.getTime() + 24 * 60 * 60 * 1000);
}
