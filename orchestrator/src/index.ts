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
import { setGoogleAuthAlert } from "./google/client.js";
import { describeError } from "./google/errors.js";
import { handleGuildMessage, resolveOwnerHome, resolveTopicChannel, type Topic } from "./guildchat.js";
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

  // Everything she starts on her own (reminders, briefings, remarks, dev and
  // voice replies) is addressed to the owner's DM. If the owner lives in their
  // own server now, it goes there instead; the DM stays the history key.
  // "topic:canvas" / "topic:calendar" name a channel the owner set aside for that
  // kind of message; null when there is none, so the caller falls back.
  const getChannel = async (channelId: string) => {
    if (channelId.startsWith("topic:")) {
      const id = await resolveTopicChannel(client, channelId.slice(6) as Topic);
      const there = id ? await client.channels.fetch(id).catch(() => null) : null;
      return there?.isSendable() ? there : null;
    }
    if (channelId === getSetting("ownerChannelId")) {
      const home = await resolveOwnerHome(client);
      if (home) {
        try {
          const there = await client.channels.fetch(home);
          if (there?.isSendable()) return there;
        } catch (err) {
          console.error("[guild] owner home unreachable, using the DM:", describeError(err));
        }
      }
    }
    const channel = await client.channels.fetch(channelId);
    return channel?.isSendable() ? channel : null;
  };

  // If the Google token dies, say so in the owner's DM instead of failing
  // quietly every five minutes until someone notices mail has stopped.
  setGoogleAuthAlert(async (text) => {
    const channelId = getSetting("ownerChannelId");
    const channel = channelId ? await getChannel(channelId) : null;
    await channel?.send(text);
  });

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
      console.error("[reminders] check failed:", describeError(err));
    });
    checkProactive(getChannel).catch((err) => {
      console.error("[proactive] check failed:", describeError(err));
    });
  };

  runReminderCheck();
  setInterval(runReminderCheck, REMINDER_CHECK_INTERVAL_MS);
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  if (message.guild) {
    // Server chat is a different thing from a DM: many people, none of them
    // necessarily the owner, and she only speaks where it has been switched on.
    void handleGuildMessage(message);
    return;
  }

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
