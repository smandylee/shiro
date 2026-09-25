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
const mineflayer = require("mineflayer");

const HOST = process.env.MC_HOST || "127.0.0.1";
const PORT = Number(process.env.MC_PORT || 25565);
const USERNAME = process.env.MC_USERNAME || "Shiro";
// Pinned, not sniffed. 26.1, 26.1.1 and 26.1.2 all speak protocol 775, so the
// server can be any of them, but letting mineflayer guess means a silent
// mismatch the day the server updates.
const VERSION = process.env.MC_VERSION || "26.1";

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60_000;

let backoff = RECONNECT_MIN_MS;

function log(line) {
  console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${line}`);
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

  let settled = false;
  const retry = (why) => {
    if (settled) return;
    settled = true;
    log(`${why} · ${Math.round(backoff / 1000)}초 뒤 재시도`);
    setTimeout(connect, backoff);
    backoff = Math.min(RECONNECT_MAX_MS, Math.round(backoff * 1.7));
  };

  bot.once("spawn", () => {
    backoff = RECONNECT_MIN_MS;
    const { x, y, z } = bot.entity.position;
    log(`들어왔다. 위치 ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`);
    bot.chat("안녕! 나 시로야.");
  });

  // Health arrives in its own packet just after the spawn, so reading it during
  // `spawn` gives undefined.
  bot.once("health", () => log(`체력 ${bot.health} · 배고픔 ${bot.food}`));

  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    log(`<${username}> ${message}`);
    // A fixed answer on purpose: this step is proving the round trip, not
    // being clever. The planner replaces this.
    bot.chat(`${username} 안녕! 아직 구경만 하는 중이야.`);
  });

  bot.on("death", () => log("죽었다. 리스폰 대기"));
  bot.on("kicked", (reason) => retry(`서버가 내보냄: ${JSON.stringify(reason).slice(0, 300)}`));
  bot.on("error", (err) => retry(`오류: ${err.message}`));
  bot.on("end", (reason) => retry(`연결 끊김 (${reason})`));
}

connect();
