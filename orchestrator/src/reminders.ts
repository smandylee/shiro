import { db } from "./memory/db.js";
import { getSetting } from "./memory/settings.js";
import { listUpcomingEventsRaw } from "./google/calendar.js";
import { parseEmotionTag } from "./persona.js";
import { say as avatarSay } from "./avatar/bridge.js";

const REMINDER_WINDOW_MS = 60 * 60 * 1000; // 1 hour ahead

const isNotifiedStmt = db.prepare("SELECT 1 FROM notified_events WHERE event_id = ?");
const markNotifiedStmt = db.prepare(
  "INSERT OR IGNORE INTO notified_events (event_id, notified_at) VALUES (?, ?)"
);
// Past events can't come back around, so old rows are dead weight.
const pruneNotifiedStmt = db.prepare("DELETE FROM notified_events WHERE notified_at < ?");
const NOTIFIED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type SendableChannel = { send: (content: string) => Promise<unknown> };

export async function checkReminders(
  getChannel: (channelId: string) => Promise<SendableChannel | null>
): Promise<void> {
  const channelId = getSetting("ownerChannelId");
  if (!channelId) return;

  let events;
  try {
    // All-day events are filtered out downstream but still consume slots here,
    // so ask for more than the handful we actually expect to act on.
    events = await listUpcomingEventsRaw(50);
  } catch (err) {
    console.error("[reminders] failed to fetch calendar events:", err);
    return;
  }

  const now = Date.now();
  pruneNotifiedStmt.run(now - NOTIFIED_RETENTION_MS);

  for (const event of events) {
    const startMs = new Date(event.startIso).getTime();
    const msUntil = startMs - now;
    if (msUntil < 0 || msUntil > REMINDER_WINDOW_MS) continue;

    const already = isNotifiedStmt.get(event.id);
    if (already) continue;

    const channel = await getChannel(channelId);
    if (!channel) continue;

    const minutesUntil = Math.round(msUntil / 60000);
    const { emotion, text } = parseEmotionTag(
      `[emotion:thinking] 주인님, ${minutesUntil}분 후에 "${event.summary}" 일정 시작이야! 잊지 말고 준비해`
    );
    try {
      avatarSay(emotion, text);
      await channel.send(text);
      markNotifiedStmt.run(event.id, now);
      console.log(`[reminders] notified for event ${event.id} (${event.summary})`);
    } catch (err) {
      console.error(`[reminders] failed to send reminder for ${event.id}:`, err);
    }
  }
}
