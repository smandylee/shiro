// What day and time it is, in words the model can count from. No database, no network.
//
// The chat model was never told the date: briefings and her own questions carried it, but an
// ordinary conversation did not, so "내일", "이번 주 금요일" or a "내일 시험이야" said last night
// were reckoned from a guess. Every conversation now ends with the current time, and the history
// marks where a new day (or a long gap) begins.

const TZ = process.env.SHIRO_TZ ?? "Asia/Hong_Kong";

/** "2026년 11월 27일 금요일 오후 12:05" in the owner's time zone. */
export function nowText(ms: number, tz = TZ): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("ko-KR", { timeZone: tz, year: "numeric", month: "long", day: "numeric", weekday: "long" });
  const time = d.toLocaleTimeString("ko-KR", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

/** "11월 26일 (목) 오후 11:10": short, for marking the history. */
export function stampText(ms: number, tz = TZ): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("ko-KR", { timeZone: tz, month: "long", day: "numeric" });
  const wd = d.toLocaleDateString("ko-KR", { timeZone: tz, weekday: "short" });
  const time = d.toLocaleTimeString("ko-KR", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return `${date} (${wd}) ${time}`;
}

const dayOf = (ms: number, tz: string) => new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });

// A gap this long within one day also gets a mark: "아까" after six hours is not "아까".
const GAP_MS = 3 * 60 * 60 * 1000;

/**
 * The history with a `[날짜 시각]` mark in front of each user turn that starts a new day or comes
 * after a long gap (and the first one). Only there: marking every line would teach her to write
 * marks herself.
 */
export function markDays<T extends { role: "user" | "model"; text: string; at: number }>(
  turns: T[],
  tz = TZ
): { role: "user" | "model"; text: string }[] {
  let prev: number | null = null;
  return turns.map((t) => {
    const starts = prev === null || dayOf(t.at, tz) !== dayOf(prev, tz) || t.at - prev >= GAP_MS;
    prev = t.at;
    return { role: t.role, text: t.role === "user" && starts ? `[${stampText(t.at, tz)}] ${t.text}` : t.text };
  });
}
