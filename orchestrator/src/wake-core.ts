// Telling that the owner has just started their day, with no clock or database in it.
//
// Their sleep is too irregular to predict (the first message of a weekday falls anywhere from
// 8 a.m. to 3 p.m.), so instead of guessing an hour this notices the moment they come back
// after a long time away: a device of theirs connecting to Discord, or a first message.

export type WakeConfig = {
  /** Away at least this long counts as a night (or a long absence that ends like one). */
  awayMs: number;
  /** Coming back before this local hour is a late night, not a morning. */
  dayStartHour: number;
};

/**
 * The devices (desktop, mobile, web) on which someone is connected. The status word is not
 * used: an owner who always sets "idle" is idle whether at the desk or asleep, but a phone
 * opening Discord still shows up as a device that was not there before.
 */
export function connectedDevices(clientStatus: object | null | undefined): string[] {
  return Object.entries((clientStatus ?? {}) as Record<string, string | undefined>)
    .filter(([, status]) => status && status !== "offline" && status !== "invisible")
    .map(([device]) => device);
}

/** Devices in `after` that were not in `before`: someone just opened Discord there. */
export function newDevices(before: string[], after: string[]): string[] {
  return after.filter((d) => !before.includes(d));
}

/**
 * Whether being seen now, after last being seen at `lastActive`, is the start of a day.
 * With no record at all (a fresh install) any appearance in the day counts.
 */
export function isWake(lastActive: number | null, now: number, localHour: number, cfg: WakeConfig): boolean {
  if (localHour < cfg.dayStartHour) return false;
  if (lastActive === null) return true;
  return now - lastActive >= cfg.awayMs;
}
