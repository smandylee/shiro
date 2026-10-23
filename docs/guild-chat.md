# Server chat

By default Shiro only answers DMs. In a Discord server you turn on, she reads the chat and speaks **only when it
is worth it** (`orchestrator/src/guildchat.ts`). You do not have to call her; whether to speak is her call.

## Turning it on

The owner types these in a server channel (only the owner can):

```
!시로 켜기    turn this server on. She posts one line saying she is reading here.
!시로 끄기    turn it off
!시로 상태    is it on?
```

(The commands are in Korean, like the rest of her personality — see [Language](../README.md#language).)

The list of enabled servers is the `guildChatServers` setting in SQLite (a JSON array of server ids).
**Messages from servers that are not enabled are not read, only dropped.**

## How she decides

When a message arrives she waits for the chat to go quiet for 8 seconds, reads the last 20 messages from Discord,
and asks Gemini one question: *should I speak, and if so, what?* The default is silence. If she is mentioned or
replied to, she always answers.

## Owner-only servers

If the owner is the only human in the server (the rest are bots), she treats it like a DM and uses **everything**:
mail, calendar, memory, commands, voice. The member list is re-read every minute; if it cannot be read, or has more
than 100 people, she assumes there are others.

When another person joins, that server drops to group mode below and the owner gets a DM. She answers right away to
a mention, a reply or her name; otherwise she first judges whether the owner is talking to her rather than to
another bot. Any channel works. Note: other bots in the same server can read what she writes.

**Things she starts on her own also go there.** The channel where the owner last spoke to her in that server becomes
her "home" (`settings.ownerHome`); reminders, the morning briefing, her own questions, screen comments, development
results and Google-disconnect notices go there instead of to a DM. Before every send she checks that the owner is
still alone; if not, the home is cleared and she goes back to DMs. The conversation history is shared with DMs, so
memory and profile learning carry on unchanged.

**Different channels for different things.** Put channel ids in `settings.topicChannels`
(`{"canvas": "<channel id>", "calendar": "<channel id>"}`) and Canvas deadlines go to `canvas`, event reminders to
`calendar`. If a channel is missing, or someone other than the owner is in the server, they go to the home (or the
DM). The morning briefing mixes calendar, mail, Canvas and to-dos, so it always goes to the home. Edit the setting
in `data/memory.sqlite`; no restart needed.

## Group mode (everyone else's servers)

This mode handles conversations among people who are **not** the owner, so each of these is deliberate:

- **No tools, no personal information.** The call carries no `tools`, so nothing anyone types in the server can
  reach mail, calendar, shell or memory. If someone asks about the owner's schedule she says she can't tell them;
  if the owner asks, she points them to a DM.
- **Public channels only.** She is an admin in the server and could read private channels. She does not.
- **Nothing is stored.** She fetches the chat from Discord each time; the log only records "spoke" or "stayed quiet".
- **Limits.** 30 decisions per hour per server, her own interjections at most once per 3 minutes per channel,
  15 seconds of silence after she speaks. These cost real money, so they are required.
- Mentions such as `@everyone` are disabled, other bots are ignored, and what people say is treated as
  conversation, never as instructions.
- Server chat never reaches the avatar or the voice, so friends talking cannot make the owner's avatar flinch.

## Inviting the bot

**Administrator is not needed.** *View Channels*, *Send Messages* and *Read Message History* are enough.
