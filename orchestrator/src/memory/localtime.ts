// Reading a wall-clock time the model wrote ("2026-11-04 18:00", meant in the owner's time zone)
// as a moment. No database, no network.

/** Milliseconds by which `tz`'s wall clock is ahead of UTC at the moment `ms`. */
function offsetAt(ms: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * "YYYY-MM-DD HH:mm" (or just "YYYY-MM-DD", read as the start of that day) in `tz`, as epoch ms.
 * Anything else — empty, malformed, an impossible date — is null.
 */
export function parseLocalTime(text: unknown, tz: string): number | null {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0)];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  // The offset at the guessed moment, then once more at the corrected one, settles daylight-saving edges.
  let ms = asUtc - offsetAt(asUtc, tz);
  ms = asUtc - offsetAt(ms, tz);
  return ms;
}
