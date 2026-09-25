import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { EMOTIONS } from "./persona.js";
import { startAvatarBridge, setJobListener } from "./avatar/bridge.js";
import { storeJobPostings } from "./memory/jobs.js";
import { getSetting, setSetting } from "./memory/settings.js";
import { checkReminders } from "./reminders.js";
import { checkProactive } from "./proactive.js";
import { startWatchCommentary } from "./watch.js";
import { startVoiceInput } from "./voice.js";
import { startDevTasks } from "./dev.js";
import { startMinecraft } from "./minecraft/agent.js";
import { warmMemory } from "./memory/longterm.js";
import { setDiscordClient } from "./discord/actions.js";
import { runExclusive, runTurn, type TurnChannel } from "./turn.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  throw new Error("DISCORD_BOT_TOKEN is not set");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Fail closed: without this, every Discord user would be treated as the owner
// and handed the Gmail/Calendar/Drive tools.
const OWNER_USER_ID = process.env.DISCORD_OWNER_USER_ID;
if (!OWNER_USER_ID) {
  throw new Error("DISCORD_OWNER_USER_ID is not set");
}

const REMINDER_CHECK_INTERVAL_MS = 5 * 60 * 1000;

client.once(Events.ClientReady, async (c) => {
  console.log(`logged in as ${c.user.tag}`);
  setDiscordClient(client);
  // A batch from the PC-side JobSpy crawler, relayed through the avatar; stored
  // for check_jobs to hand out on request, never announced on its own.
  setJobListener((postings) => {
    const added = storeJobPostings(
      postings.map((p) => ({
        jobUrl: p.jobUrl,
        title: p.title,
        company: p.company,
        location: p.location ?? null,
        datePosted: p.datePosted ?? null,
        site: p.site,
        query: p.query ?? null,
      }))
    );
    console.log(`[jobs] received ${postings.length} posting(s), ${added} new`);
  });
  startAvatarBridge(EMOTIONS);

  const ownerUserId = process.env.DISCORD_OWNER_USER_ID;
  if (ownerUserId) {
    try {
      const owner = await client.users.fetch(ownerUserId);
      const dm = await owner.createDM();
      setSetting("ownerChannelId", dm.id);
      console.log(`[reminders] owner DM channel ready: ${dm.id}`);
    } catch (err) {
      console.error("[reminders] failed to open owner DM channel:", err);
    }
  }

  const getChannel = async (channelId: string) => {
    const channel = await client.channels.fetch(channelId);
    return channel?.isSendable() ? channel : null;
  };

  void warmMemory();
  startWatchCommentary(getChannel);
  startDevTasks(getChannel);
  startMinecraft(getChannel);
  startVoiceInput({
    ownerUserId: OWNER_USER_ID,
    getChannel: async (channelId): Promise<TurnChannel | null> => {
      const channel = await getChannel(channelId);
      return channel && "sendTyping" in channel ? channel : null;
    },
  });

  const runReminderCheck = () => {
    checkReminders(getChannel).catch((err) => {
      console.error("[reminders] check failed:", err);
    });
    checkProactive(getChannel).catch((err) => {
      console.error("[proactive] check failed:", err);
    });
  };

  runReminderCheck();
  setInterval(runReminderCheck, REMINDER_CHECK_INTERVAL_MS);
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  if (message.guild) return;

  const channelId = message.channelId;
  const isOwner = message.author.id === OWNER_USER_ID;

  if (isOwner && getSetting("ownerChannelId") !== channelId) {
    setSetting("ownerChannelId", channelId);
  }

  runExclusive(channelId, () =>
    runTurn({
      channel: message.channel,
      channelId,
      isOwner,
      authorId: message.author.id,
      authorName: isOwner ? message.author.tag : message.author.username,
      content: message.content,
      attachments: message.attachments.values(),
    })
  );
});

client.login(token);
