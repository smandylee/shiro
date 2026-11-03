// Telling that the owner has just started their day, with no clock or database in it.
//
// Their sleep is too irregular to predict (the first message of a weekday falls anywhere from
// 8 a.m. to 3 p.m.), so instead of guessing an hour this notices the moment they come back
// after a long time away: Discord showing them online again, or a first message.

export type WakeConfig = {
  /** Away at least this long counts as a night (or a long absence that ends like one). */
  awayMs: number;
  /** Coming back before this local hour is a late night, not a morning. */
  dayStartHour: number;
};

/** Discord statuses that mean someone is at a device now. Idle, offline and invisible do not. */
export function isActiveStatus(status: string | null | undefined): boolean {
  return status === "online" || status === "dnd";
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
