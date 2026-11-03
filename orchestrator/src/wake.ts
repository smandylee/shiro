import { getSetting, setSetting } from "./memory/settings.js";
import { isActiveStatus, isWake, type WakeConfig } from "./wake-core.js";

// When the owner's day starts, for the morning briefing (SHIRO_BRIEFING=wake).
//
// Two signals feed it: their Discord status (needs SHIRO_PRESENCE=1 and the Presence Intent
// switched on in the developer portal) and their own messages, which also cover invisible mode
// and an install without the intent. Either one ending a long absence marks the day as started.

const TZ = process.env.SHIRO_TZ ?? "Asia/Hong_Kong";
const CFG: WakeConfig = {
  awayMs: Number(process.env.SHIRO_WAKE_AWAY_HOURS ?? 4) * 60 * 60 * 1000,
  dayStartHour: Number(process.env.SHIRO_WAKE_DAY_START ?? 5),
};

const localDate = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const localHour = (ms: number) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));

// Kept in settings so a restart in the middle of the night doesn't make the next appearance
// look like a first-ever one, or forget that the day has already started.
const LAST_ACTIVE = "ownerLastActiveAt";
const WOKE_AT = "ownerWokeAt";

let lastActive: number | null = Number(getSetting(LAST_ACTIVE)) || null;
let lastSaved = lastActive ?? 0;

function touch(now: number, force = false): void {
  lastActive = now;
  // An active owner sends many messages; the record only needs minute precision.
  if (force || now - lastSaved >= 60_000) {
    setSetting(LAST_ACTIVE, String(now));
    lastSaved = now;
  }
}

function arrive(now: number, via: string): boolean {
  const wake = !wokeToday(now) && isWake(lastActive, now, localHour(now), CFG);
  if (wake) {
    setSetting(WOKE_AT, String(now));
    const away = lastActive === null ? "unknown" : `${((now - lastActive) / 3600e3).toFixed(1)}h`;
    console.log(`[wake] the owner's day started (${via}, away ${away})`);
  }
  touch(now, wake);
  return wake;
}

/** The owner wrote something. True if that started their day. */
export function ownerMessaged(now = Date.now()): boolean {
  return arrive(now, "message");
}

/**
 * The owner's Discord status changed. True if that started their day. Going away also counts
 * as the last moment they were seen, so the absence is measured from when they left.
 */
export function ownerStatusChanged(before: string | null | undefined, after: string | null | undefined, now = Date.now()): boolean {
  const was = isActiveStatus(before);
  const is = isActiveStatus(after);
  if (is && !was) return arrive(now, `status ${before ?? "unknown"} -> ${after}`);
  if (was && !is) touch(now, true);
  return false;
}

/** Whether the owner's day has started today (local date). */
export function wokeToday(now = Date.now()): boolean {
  const at = Number(getSetting(WOKE_AT));
  return Boolean(at) && localDate(at) === localDate(now);
}
