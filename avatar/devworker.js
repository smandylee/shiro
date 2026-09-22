// Runs development requests on the owner's PC, independently of the avatar.
//
// The avatar is a window — it gets closed, restarted, and is off whenever the
// owner isn't using it. A request Shiro made shouldn't need her face to be on
// screen, so this connects to the same bridge on its own and handles nothing
// but dev tasks. Plain Node, no Electron.
//
//   node devworker.js        (from the avatar folder)
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { runDevTask } = require("./devtask.js");

const CONFIG_PATH = path.join(__dirname, "config.json");
const LOG_PATH = path.join(__dirname, "devworker.log");
const LOG_MAX_BYTES = 200 * 1024;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

function log(line) {
  const text = `${new Date().toISOString().slice(0, 19).replace("T", " ")} ${line}`;
  console.log(text);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.writeFileSync(LOG_PATH, "");
    fs.appendFileSync(LOG_PATH, text + "\n");
  } catch {
    /* logging must never stop the worker */
  }
}

function loadConfig() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    log(`config.json 을 읽지 못했어: ${err.message}`);
  }
  // Env wins over the file, so the worker can be pointed at another bridge
  // (a test one, say) without editing the avatar's settings.
  if (process.env.SHIRO_BRIDGE_URL) config.bridgeUrl = process.env.SHIRO_BRIDGE_URL;
  if (process.env.SHIRO_BRIDGE_TOKEN) config.bridgeToken = process.env.SHIRO_BRIDGE_TOKEN;
  if (process.env.SHIRO_ALLOW_DEV_TASKS === "true") config.allowDevTasks = true;
  return config;
}

let backoff = RECONNECT_MIN_MS;
let busy = false;

function connect() {
  // Read the config fresh each time, so switching allowDevTasks on or off
  // doesn't need the worker restarted.
  const config = loadConfig();
  if (!config.bridgeToken) {
    log("config.json 에 bridgeToken 이 없어. 아바타와 같은 설정 파일을 쓴다.");
    return setTimeout(connect, RECONNECT_MAX_MS);
  }

  const url = config.bridgeUrl || "ws://127.0.0.1:18790";
  const ws = new WebSocket(url);

  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: config.bridgeToken })));

  ws.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (event.type === "hello") {
      backoff = RECONNECT_MIN_MS;
      log(`시로와 연결됨 (${url}) — 개발 요청 대기 중${config.allowDevTasks === true ? "" : " (allowDevTasks 가 꺼져 있음)"}`);
      return;
    }
    if (event.type !== "dev_task" || typeof event.id !== "number" || typeof event.task !== "string") return;

    // One at a time: two runs would fight over the same repository.
    if (busy) {
      log(`#${event.id} 무시 — 이미 다른 요청을 처리 중`);
      ws.send(JSON.stringify({ type: "dev_result", id: event.id, ok: false, summary: "이미 다른 개발 요청이 돌고 있어서 못 받았어." }));
      return;
    }

    busy = true;
    log(`#${event.id} 받음: ${event.task.slice(0, 80)}`);
    runDevTask({ id: event.id, task: event.task, config: loadConfig(), log })
      .then((result) => ws.send(JSON.stringify({ type: "dev_result", ...result })))
      .catch((err) => {
        log(`#${event.id} 실행 중 오류: ${err.message}`);
        ws.send(JSON.stringify({ type: "dev_result", id: event.id, ok: false, summary: `실행 중 오류: ${err.message}` }));
      })
      .finally(() => {
        busy = false;
      });
  });

  ws.on("close", () => {
    log(`연결 끊김 · ${Math.round(backoff / 1000)}초 뒤 재시도`);
    setTimeout(connect, backoff);
    backoff = Math.min(RECONNECT_MAX_MS, Math.round(backoff * 1.7));
  });
  ws.on("error", (err) => {
    // 'close' follows, which is where the retry lives.
    if (backoff === RECONNECT_MIN_MS) log(`연결 오류: ${err.message}`);
  });
}

log("개발 요청 워커 시작");
connect();
