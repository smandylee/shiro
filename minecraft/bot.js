// Shiro in Minecraft — step one: get her into the world and talking.
//
// Nothing here decides anything yet. This connects to the local Paper server,
// stays connected, and answers chat with a fixed line, so that the plumbing
// (version, protocol, offline-mode login, reconnect) is proven before any of
// the interesting parts are built on top of it.
//
//   npm run bot
//
// Everyone in the game is a guest. The owner does not play on this server, so
// there is no one in here to take orders from — whatever appears in chat is
// input to look at, never an instruction to act on. That stays true when the
// planner arrives: game chat gets Minecraft actions and nothing else, never
// the personal tools.
const fs = require("node:fs");
const path = require("node:path");
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const { plugin: pvp } = require("mineflayer-pvp");
const { loader: autoEat } = require("mineflayer-auto-eat");
// No mineflayer-collectblock: on 26.1 it times out on blocks two steps away and
// reports success without picking anything up. skills.js does those steps itself.
const { installReflexes } = require("./reflexes.js");
const { Skills } = require("./skills.js");

const HOST = process.env.MC_HOST || "127.0.0.1";
const PORT = Number(process.env.MC_PORT || 25565);
const USERNAME = process.env.MC_USERNAME || "Shiro";
// Pinned, not sniffed. 26.1, 26.1.1 and 26.1.2 all speak protocol 775, so the
// server can be any of them, but letting mineflayer guess means a silent
// mismatch the day the server updates.
const VERSION = process.env.MC_VERSION || "26.1";

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
// Chunks arrive after the spawn packet. Acting before they land means looking
// at an empty world and concluding there are no trees in it.
const CHUNK_SETTLE_MS = 4000;

let backoff = RECONNECT_MIN_MS;

function log(line) {
  console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${line}`);
}

/**
 * One Shiro at a time.
 *
 * Two copies both log in under the same name, the server kicks whichever was
 * there first, and it reconnects and kicks the other — so they take turns
 * throwing each other out and neither ever finishes anything. A stale lock from
 * a process that died is ignored; a live one stops this start.
 */
function claimSingleInstance() {
  const lockPath = path.join(__dirname, ".bot.lock");
  try {
    const previous = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (previous && previous !== process.pid) {
      try {
        process.kill(previous, 0); // signal 0: does it exist, not "die"
        log(`이미 ${previous} 번으로 돌고 있어. 그걸 끄고 다시 시작해.`);
        process.exit(1);
      } catch {
        /* the old process is gone; the lock is just litter */
      }
    }
  } catch {
    /* no lock file yet */
  }

  fs.writeFileSync(lockPath, String(process.pid));
  const release = () => {
    try {
      if (Number(fs.readFileSync(lockPath, "utf8").trim()) === process.pid) fs.unlinkSync(lockPath);
    } catch {
      /* nothing to release */
    }
  };
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      release();
      process.exit(0);
    });
  }
}

function connect() {
  log(`접속 시도 ${HOST}:${PORT} (${VERSION}, 이름 ${USERNAME})`);

  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    auth: "offline",
  });

  let skills = null;
  let reflexes = null;
  let setupTimer = null;
  let settled = false;

  const retry = (why) => {
    if (settled) return;
    settled = true;
    // The dead bot's reflexes would otherwise keep ticking forever against a
    // connection that is gone, one stray interval per reconnect.
    clearTimeout(setupTimer);
    reflexes?.stop();
    reflexes = null;
    skills = null;
    log(`${why} · ${Math.round(backoff / 1000)}초 뒤 재시도`);
    setTimeout(connect, backoff);
    backoff = Math.min(RECONNECT_MAX_MS, Math.round(backoff * 1.7));
  };

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(autoEat);

  bot.once("spawn", () => {
    backoff = RECONNECT_MIN_MS;
    const { x, y, z } = bot.entity.position;
    log(`들어왔다. 위치 ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`);
    bot.chat("안녕! 나 시로야.");

    setupTimer = setTimeout(() => {
      reflexes = installReflexes(bot, { log });
      skills = new Skills(bot, { log, state: reflexes.state });
      log("반사신경과 기술 준비됨");
    }, CHUNK_SETTLE_MS);
  });

  // Health arrives in its own packet just after the spawn, so reading it during
  // `spawn` gives undefined.
  bot.once("health", () => log(`체력 ${bot.health} · 배고픔 ${bot.food}`));

  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    log(`<${username}> ${message}`);
    void handleChat(username, message);
  });

  /**
   * Until the planner exists, chat is how the skills get exercised. These are
   * test commands, not a feature: whoever is in the game is a guest, and a
   * guest only ever reaches the Minecraft verbs — never anything of the
   * owner's. When the planner lands it takes this over and these go away.
   */
  async function handleChat(username, message) {
    if (!skills) return void bot.chat("아직 준비 중이야. 조금만.");

    const [verb, ...rest] = message.trim().split(/\s+/);
    const say = (text) => {
      log(`→ ${text}`);
      bot.chat(text.slice(0, 250));
    };

    try {
      if (verb === "상태") return say(skills.status());
      if (verb === "가방") return say(skills.inventorySummary());
      if (verb === "와") {
        const target = bot.players[username]?.entity;
        if (!target) return say("네가 어디 있는지 안 보여.");
        const p = target.position;
        return say((await skills.goTo(p.x, p.y, p.z, 2)).detail);
      }
      if (verb === "캐") {
        const [what, n] = rest;
        if (!what) return say("뭘 캘지 말해줘. 예: 캐 wood 3");
        return say((await skills.mine(what, Number(n) || 1)).detail);
      }
      if (verb === "만들어") {
        const [what, n] = rest;
        if (!what) return say("뭘 만들지 말해줘. 예: 만들어 wooden_pickaxe");
        return say((await skills.craft(what, Number(n) || 1)).detail);
      }
      if (verb === "들어") {
        const [what] = rest;
        if (!what) return say("뭐에 쓸 도구인지 말해줘. 예: 들어 stone");
        return say((await skills.equipBestTool(what)).detail);
      }
      say(`${username} 안녕! 할 줄 아는 건 상태 / 가방 / 와 / 캐 / 만들어 / 들어 야.`);
    } catch (err) {
      log(`채팅 처리 중 오류: ${err.stack || err.message}`);
      say(`하다가 뭔가 잘못됐어: ${err.message}`);
    }
  }

  bot.on("death", () => log("죽었다. 리스폰 대기"));
  bot.on("kicked", (reason) => retry(`서버가 내보냄: ${JSON.stringify(reason).slice(0, 300)}`));
  bot.on("error", (err) => retry(`오류: ${err.message}`));
  bot.on("end", (reason) => retry(`연결 끊김 (${reason})`));
}

claimSingleInstance();
connect();
