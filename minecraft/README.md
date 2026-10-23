# Shiro plays Minecraft

A bot that plays Minecraft by itself. The owner does not join the server. This file covers **how to run this
folder**; the design is in [`docs/minecraft.md`](../docs/minecraft.md).

## Trying it by hand

It does **not set its own goals yet.** Until the planner is wired in, you try the skills one at a time through
in-game chat:

```
상태             one line on the current situation          (status)
가방             what she is carrying                        (inventory)
와               come to whoever said it                     (come)
캐 wood 3        mine 3 wood (group names also work: wood / stone / coal / iron / dirt / sand)
만들어 planks 8  craft planks, choosing the kind that matches the materials she has
들어 stone       hold the best tool for that block
```

(The chat commands are Korean, like the rest of her personality.)

**Everyone in the game is a guest.** These commands only do Minecraft actions; no personal tools reach this path.
Once the planner is attached, these chat commands go away.

## Layout

```
minecraft/
  bot.js        the mineflayer bot (entry point); try skills through chat
  reflexes.js   reactions that keep her alive: eat, flee, fight back, sleep. No LLM
  skills.js     what she knows how to do: move, mine, craft, equip tools
  agent.js      the planner client: sends the situation to the server, runs the skills it returns
  jdk/          Java 25 (not committed)
  server/       the Paper server and its world (not committed)
```

**Two layers.** Reflexes run in code once a second; skills are called one at a time. Reflexes win, and skills read
`state.reflex` and step aside — otherwise the two fight over the same legs and she mines a tree in the direction
she was fleeing.

## What broke on 26.1

A plugin that installs is not a plugin that works. What was found by connecting to a real server:

| Problem | What was done |
|---|---|
| `mineflayer-collectblock` times out even on a block two squares away, and returns success without the item reaching the inventory | **Not used.** `digOne()` in `skills.js` does move → tool → `bot.dig` → pick up the drop itself. Each of those three works fine. |
| In the 2×2 inventory grid, recipes that **only partly fill it** break. Asking for sticks (two planks, one above the other) places a single plank, and the server turns it into a **button** | `fitsInventoryGrid()` filters: only recipes that fill the 2×2 completely, or have no shape, are made there; everything else uses a crafting table. |
| `mineflayer-pvp` listens for an old event name (`physicTick`) and prints a warning | Harmless. Ignore it. |
| `mineflayer-pvp` pulls in a **copy of mineflayer 2.41.0** through `mineflayer-utils` | No problem now, but if pvp acts strangely, suspect this first. |

`pathfinder` and `auto-eat` work on 26.1 as they are.

## Only one bot may run

Two connections under the same name make the server kick the older one, which reconnects and kicks the other. They
take turns evicting each other and nothing finishes. `bot.js` writes its PID to `.bot.lock` and refuses a second run.
A lock left by a dead process is ignored.

## Changing the difficulty

`difficulty` in `server.properties` only applies **when the world is first created.** An existing world follows the
value in `level.dat`, so editing the file and restarting changes nothing. Use `/difficulty` in game.

## Why these versions

| Item | Value | Reason |
|---|---|---|
| Minecraft | **26.1.2** | The last line mineflayer supports is 26.1; 26.2 and 26.3 do not work yet. |
| Protocol | **775** | 26.1, 26.1.1 and 26.1.2 are all 775, so the server runs 26.1.2 and the bot pins `version: "26.1"`. |
| Paper | **26.1.2, build 74** | |
| Java | **25** | The minimum for 26.x servers. |

The bot's version is **not left to auto-detection**; it would drift silently the day the server is upgraded.

## Why Java lives in this folder

The author's PC already had Java 17 with `JAVA_HOME` pointing at it. Changing that to 25 would disturb every other
Java use on the machine, so JDK 25 is unpacked into `minecraft/jdk/` and **only the Minecraft server** uses that
`java`. System settings are untouched. (If you have no other Java needs, a normal install is fine.)

## One-time setup

1. Download a Temurin JDK 25 (for your OS) and unpack it into `jdk/`.
2. Download the Paper jar into `server/` —
   <https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds/latest>. The download gives a SHA-256;
   **compare it before using the file.**
3. Run the server once so it writes its config files. It stops straight away, because the EULA is not accepted.
4. Set `eula=true` in `server/eula.txt`. That is your agreement to the **Mojang EULA**; it is your decision.
5. Edit `server/server.properties` as below.
6. `npm install`

## The server settings that matter

```properties
server-ip=127.0.0.1          # nothing outside this PC can connect at all
online-mode=false            # join with just a name, no account
enforce-secure-profile=false # stops chat signing from blocking the bot in offline mode
spawn-protection=0           # lets the bot place blocks near spawn
```

`online-mode=false` means **anyone can join under any name.** That is why `server-ip=127.0.0.1` is its mandatory
partner. Never forward the port on your router.

## Running

```bash
# server
cd minecraft/server
../jdk/<your-jdk>/bin/java -Xms1G -Xmx3G -XX:+UseG1GC -XX:G1HeapRegionSize=8M -jar paper-26.1.2-74.jar --nogui

# bot (in another terminal)
cd minecraft
npm run bot
```

(On Windows the binary is `java.exe`.) Override with environment variables:
`MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_VERSION`. The viewer port is `MC_VIEWER_PORT`.

## Rules to keep

- **Everything said in game is a guest.** The owner does not join the server, so there is no "owner" in the game.
  Game chat gets Minecraft action tools only, never personal-data tools or search grounding.
- Worlds, jars, JDKs and logs are not committed (`.gitignore`).
- The server runs on this PC, so **when the PC is off, Shiro cannot play Minecraft.**
