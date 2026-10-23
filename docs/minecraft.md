# Minecraft: design notes

Shiro plays Minecraft (Java Edition) **on her own**. The owner does not join the server: she sets her own goals,
survives, and plays; the owner sees what she is doing through a first-person viewer, her avatar's emotions and
Discord. How to run the bot is in [`minecraft/README.md`](../minecraft/README.md); this document is why it is built
the way it is.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Edition | Java, **vanilla** | The bot library, mineflayer, only really supports Java. |
| Modpacks | **No** | Forge/NeoForge modpacks fail the handshake, and mods that add blocks or items make the bot misread the world. Paper plugins, datapacks and server-only mods are fine. |
| Version | **26.1 line** | The newest is 26.3, but the last version mineflayer 4.39.0 lists as tested is `26.1`. 26.1.2 shares 26.1's protocol, so the server runs 26.1.2 and the bot pins `26.1`. |
| Server | Paper, **on the PC that plays**, not on the always-on server | If the PC is off, Shiro cannot play Minecraft — an accepted limit. |
| Account | **Offline mode** (`online-mode=false`), just a name | No Microsoft account token is ever stored on disk. |
| Network | The server binds to **`127.0.0.1` only**; the port is never forwarded | Offline mode lets anyone join under any name, so it must be local. |
| Java | **Java 25** (required by 26.x), installed only where the server runs | |

## Architecture

```
[Paper server] <-mineflayer-> [PC: bot] <-bridge WebSocket-> [server: orchestrator + Gemini]
                                 |- reflexes (plain code, no LLM): eat, flee, fight back, go to bed
                                 |- skills: mine, craft, equip tools, move (pathfinder)
                                 `- prismarine-viewer: her point of view on localhost:3007
                                                                      |- picks goals (every few minutes, or on an event)
                                                                      |- answers in-game chat
                                                                      `- emotion -> avatar, events -> long-term memory
```

- **Two layers.** The language model is not called every tick. Survival reactions run in the bot's own code, and
  Gemini is only asked what to do *next* (a short list of skill calls). This is the approach of Voyager and Mindcraft.
- **Judgement stays on the server.** Gemini credentials, persona, memory and usage caps live in one place. The PC
  bot never calls Gemini directly. Planning calls are occasional, so the round trip does not matter.
- **The bot follows the dev worker's pattern.** A Node process independent of the avatar window that connects to the
  bridge itself, so she keeps playing with the avatar closed: reconnect backoff, an outbox, log rotation.
- **Control and judgement are separated cleanly,** so that a later move to a modded client only swaps the control
  side.

## Rules

- **Everything said in the game is a guest.** Nobody in the game is the owner. The in-game chat path gets Minecraft
  action tools only — never personal-data tools or search grounding.
- **Planner calls are capped per hour,** so leaving her running cannot leak money. They are recorded in the usage
  table like everything else.
- **Fail-closed.** Without a bridge token the bot does not connect.
- Worlds, server jars, JDKs and logs are never committed.

## Order of work

1. **Server and connection.** Java 25, a Paper 26.1 server in offline mode bound to localhost, a mineflayer bot that
   joins and reacts to chat. *(done)*
2. **Reflexes and a skill library.** Auto-eat, fighting back and fleeing, going to bed; skills for mining wood and
   stone, crafting basic tools, and moving. *(done)*
3. **The Gemini planner.** The server picks a goal and sends the bot an order of skills; if one fails, it re-plans
   with the reason. *(code in place; surviving a whole night is still open)*
4. **Memory, emotion, Discord.** Events (finding diamonds, dying) go to long-term memory and emotion goes to the
   avatar; she can answer "what did you do in Minecraft?" in Discord. *(not started)*
