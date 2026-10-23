# Getting started

This walks through running your own Shiro: the orchestrator (her mind), the avatar (her body), and how to keep
both running. Everything beyond the first section is optional.

Shiro was built for one person's setup — an always-on server plus a Windows PC — so some steps assume that
shape. Where something is specific to it, this says so.

- [1. Prerequisites](#1-prerequisites)
- [2. The orchestrator](#2-the-orchestrator)
- [3. The avatar](#3-the-avatar)
- [4. Running on a server](#4-running-on-a-server)
- [5. Keeping the PC side running (Windows)](#5-keeping-the-pc-side-running-windows)
- [6. Optional integrations](#6-optional-integrations)
- [7. Troubleshooting](#7-troubleshooting)

---

## 1. Prerequisites

| You need | Why |
|---|---|
| **Node.js 20.6 or newer** | The orchestrator runs on `tsx`; `--env-file` needs 20.6+. A C++ toolchain may be needed the first time, because `better-sqlite3` builds a native module. |
| **A Discord application with a bot** | Where you talk to her. Create one at <https://discord.com/developers/applications>, add a bot, copy its token, and **enable the Message Content Intent**. DMs work without inviting the bot anywhere. |
| **Your Discord user id** | Developer Mode on, then right-click yourself → *Copy User ID*. Only this account gets the personal-data tools. |
| **A Google Cloud project with Vertex AI enabled** | All language-model calls go to Gemini through Vertex AI. |

Optional: a Pinecone account (long-term memory), an ElevenLabs or Typecast account (voice), a Google OAuth client
(Gmail / Calendar / Drive), an [OpenClaw](https://docs.openclaw.ai) gateway (running commands you approve), Claude Code
(development requests), a Paper server (Minecraft).

## 2. The orchestrator

```bash
cd orchestrator
npm install
cp .env.example .env
```

Fill in `.env`. The four values you must set:

| Variable | What |
|---|---|
| `DISCORD_BOT_TOKEN` | The bot token. |
| `DISCORD_OWNER_USER_ID` | Your Discord user id. **The bot will not start without it.** |
| `GOOGLE_CLOUD_PROJECT` | Your Google Cloud project id. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service-account key with the *Vertex AI User* role — or skip it and run `gcloud auth application-default login`. |

Start her:

```bash
npx tsx --env-file=.env src/index.ts      # or: npm start, with the variables already exported
```

You should see `logged in as <bot name>`. Send the bot a direct message.

State lives in `orchestrator/data/memory.sqlite` (created on first run, git-ignored): recent turns, settings,
your to-do list, the learned profile, her mood. Long-term memory is in Pinecone if you set `PINECONE_API_KEY`;
the index `shiro-memory` (768 dimensions, cosine, serverless) is created for you.

### What happens when something is not configured

Nothing crashes; the feature just stays off, and the log says so once at startup.

| Missing | Effect |
|---|---|
| `PINECONE_API_KEY` | No long-term memory. Short-term memory and the learned profile still work. |
| `AVATAR_BRIDGE_TOKEN` | The bridge does not start, so no avatar, no voice, no dev worker, no Minecraft planner. |
| TTS keys | No voice. Everything else is unchanged. |
| Google OAuth files | Gmail, Calendar and Drive tools report an error instead of working. |
| `OPENCLAW_GATEWAY_TOKEN` | She cannot run shell commands. See [Running commands](command-execution.md). |
| `CANVAS_ICS_URL` | No Canvas deadline reminders. |

### Settings you may want to change

Defaults are in the source next to where they are read; the common ones are listed in `.env.example`.
The ones that shape how she behaves:

| Variable | Default | Effect |
|---|---|---|
| `SHIRO_TZ` | `Asia/Hong_Kong` | Timezone for the briefing, quiet hours and nightly jobs. **Set this.** |
| `SHIRO_BRIEFING_HOUR` | `8` | Morning briefing hour (a late one is still sent until `SHIRO_BRIEFING_LATEST_HOUR`, `12`). |
| `SHIRO_QUIET_START` / `_END` | `23` / `8` | To-do nudges stay silent in this window. |
| `SHIRO_CHATTER_IDLE_MIN` | `30` | She never starts a conversation sooner than this after you last wrote. |
| `SHIRO_WONDER_GAP_MIN` | `30` | Minimum gap between questions she thinks up on her own. |
| `SHIRO_PROFILE_HOUR`, `SHIRO_MOOD_HOUR` | `4` | When the nightly learning and mood reflection run. |
| `TTS_PROVIDER` | `typecast` | `elevenlabs` for ElevenLabs. |

You can tell her to stop starting conversations ("don't talk to me until tomorrow") — she has a tool for it.

## 3. The avatar

The avatar is an Electron app: a transparent, click-through, always-on-top window. It was developed and used on
Windows; it should run on macOS and Linux but that is untested.

```bash
cd avatar
npm install
cp config.example.json config.json
npm start
```

`config.json` is git-ignored. Set at least:

| Key | Meaning |
|---|---|
| `bridgeUrl` | Where the orchestrator's bridge is. `ws://127.0.0.1:18790` when both run on one machine. |
| `bridgeToken` | **The same value as the orchestrator's `AVATAR_BRIDGE_TOKEN`.** |

Everything else is optional and off by default for anything that touches your machine:

| Key | Meaning |
|---|---|
| `scale` | Size of the avatar (0.32 by default); the control panel changes it live. |
| `showBubble` | Show her replies as a speech bubble next to her. |
| `mesh` | Draw head and body with the mesh engine so the head can turn. `false` falls back to plain layers. |
| `allowScreenCapture` | Let her look at your screen (when you ask) and watch you play. |
| `allowMicrophone` | Let you talk to her. |
| `allowDevTasks`, `devModel`, `devMaxBudgetUsd` | Let her ask for changes to herself — see [Development requests](dev-tasks.md). |
| `allowDeploy`, `deployHost`, `deployKeyPath`, `deployRemoteDir`, `deployService` | Let an approved change be deployed to your server. |

Hotkeys: **Ctrl+Shift+S** toggles the control panel (move, resize, preview emotions, debug overlay),
**Ctrl+Shift+W** starts and stops watch mode, **Ctrl+Shift+Q** quits.

The orchestrator only sends voice to the avatar while one is connected, so leaving the avatar off costs nothing.

## 4. Running on a server

Shiro is meant to run 24/7. A small VM is enough. The pieces:

1. Copy `orchestrator/` to the server and run `npm install` there.
2. Put the environment variables in a root-only file such as `/etc/shiro.env` (`chmod 600`).
3. Run it under systemd. An example unit:

   ```ini
   [Unit]
   Description=Shiro Discord Orchestrator
   After=network-online.target

   [Service]
   User=ubuntu
   WorkingDirectory=/home/ubuntu/orchestrator
   EnvironmentFile=/etc/shiro.env
   ExecStart=/usr/bin/npm start
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

   Logs: `sudo journalctl -u <unit> -f`.

### Reaching the bridge from your PC

If the orchestrator is on a server and the avatar is on your PC, they talk over the bridge. **Do not expose it
to the public internet.** The token authenticates the connection, but there is no reason to leave the port open.
Pick one:

- **A private network** (Tailscale, WireGuard): set `AVATAR_BRIDGE_HOST` to the server's private address and use
  that in the avatar's `bridgeUrl`.
- **An SSH tunnel** from the PC to the server, with the bridge left on `127.0.0.1`. The bundled autostart script
  (below) does this for you, using `deployHost` and `deployKeyPath` from the avatar config.

### Updating the server

`tools/deploy/deploy.js` is the script the dev worker uses to ship an approved change: it merges, type-checks,
uploads `orchestrator/src`, restarts the service and checks that she logged in to Discord, and rolls back if she
did not. It refuses to run if `package.json` changed, if files outside `orchestrator/src` changed, or if the
checkout is not clean — those need a human.

Doing it by hand: copy the changed files, restart the service, and read the log for `logged in as`. Keep the
previous `src` around under another name so you can swap it back.

## 5. Keeping the PC side running (Windows)

Three programs run on the PC: **the SSH tunnel to the server, the dev worker, and the avatar.** Left to start
by hand they silently stop when the PC reboots, so there is a scheduled-task installer:

```powershell
powershell -ExecutionPolicy Bypass -File tools\autostart\install.ps1            # register (safe to repeat)
powershell -ExecutionPolicy Bypass -File tools\autostart\install.ps1 -Remove    # unregister
```

| Task (`\Shiro\`) | When | What it does |
|---|---|---|
| `Up` | At logon | Starts the tunnel, the dev worker and the avatar. The tunnel and worker are restarted if they die. |
| `JobSpy-0900` / `JobSpy-2100` | Daily | The job crawler ([details](../tools/jobspy/README.md)). Runs once at next boot if the PC was off. |

Notes:

- The avatar is started **once** at logon. If you close it, it stays closed.
- It runs as your own user — no administrator rights, no stored password. Logging out stops it.
- Logs: `tools/autostart/shiro-up.log`, `avatar/devworker.log`, `tools/jobspy/crawl.log`.
- Start now: `Start-ScheduledTask -TaskPath '\Shiro\' -TaskName 'Up'`
- The Minecraft bot and server are not included.
- **PowerShell files that contain non-ASCII text must be saved as UTF-8 with a BOM.** Windows PowerShell 5.1 reads a
  file without one as the system code page; quotes then vanish and the script fails with a syntax error.

## 6. Optional integrations

| Feature | Guide |
|---|---|
| Gmail, Calendar, Drive notes | [Google integration](google-integration.md) |
| Running shell commands you approve | [Running commands (OpenClaw)](command-execution.md) |
| Joining a Discord server | [Server chat](guild-chat.md) |
| She asks for changes to herself | [Development requests](dev-tasks.md) |
| Minecraft | [Minecraft design](minecraft.md) and [running the bot](../minecraft/README.md) |
| Job postings | [Job crawler](../tools/jobspy/README.md) |

## 7. Troubleshooting

- **She does not answer a DM.** Check the log for `logged in as`. If she logged in but ignores you, the
  *Message Content Intent* is probably off in the Discord developer portal, or `DISCORD_OWNER_USER_ID` is not
  your id (the owner check is strict, and anyone else is treated as a guest).
- **The avatar says it cannot connect.** `bridgeToken` must equal `AVATAR_BRIDGE_TOKEN` exactly, and the
  orchestrator log must show the bridge listening. If the orchestrator is on another machine, see
  [Reaching the bridge](#reaching-the-bridge-from-your-pc).
- **Replies suddenly take minutes.** Restart the service first. A long-running process has been seen to slow down
  while the network and the model were fine; a fresh process called the same model in seconds.
- **`better-sqlite3` crashes on start.** It is a native module: rebuild it (`npm rebuild better-sqlite3`) with a
  toolchain that matches your Node version. It segfaulted on macOS 13.0 with one Node build and ran fine on Linux.
