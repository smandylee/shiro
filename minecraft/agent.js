// Asking what to do, and then doing it.
//
// Her body is here on the PC; the part that decides is on the server. This is
// the loop between them: describe the situation, get back a few steps, carry
// them out, describe what happened, ask again.
//
// The loop never calls the model itself. Credentials, the persona and the
// spend ceiling all live on the VM, and a Hong Kong round trip is fine for
// "what should I do next" precisely because reflexes already handle everything
// that cannot wait.
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { GROUPS } = require("./skills.js");

const CONFIG_PATH = path.join(__dirname, "..", "avatar", "config.json");
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
// How long to sit still before asking again when there is nothing to do.
const IDLE_PAUSE_MS = 8000;
// Thinking costs money on Vertex, so she does not ask again the instant a plan
// finishes. When every step of it failed, the world clearly is not what she
// thought it was, and waiting longer beats asking the same question faster.
const AFTER_PLAN_MS = 5000;
const AFTER_FAILED_PLAN_MS = 20_000;
// If the server never answers, carry on rather than freezing forever.
const PLAN_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 6;
// What she looks around for, to tell the planner what is actually available.
const LOOK_FOR = ["wood", "stone", "coal", "iron"];

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^﻿/, ""));
  } catch {
    /* no config; env may still have what we need */
  }
  return {
    url: process.env.SHIRO_BRIDGE_URL || file.bridgeUrl || "ws://127.0.0.1:18790",
    token: process.env.SHIRO_BRIDGE_TOKEN || file.bridgeToken,
  };
}

/**
 * Runs her. `skills` and `state` come from the same place the chat commands
 * use, so a plan can only ever ask for something she already knows how to do.
 */
function startAgent({ bot, skills, state, log }) {
  const { url, token } = loadConfig();
  if (!token) {
    log("[계획] 브릿지 토큰이 없어서 스스로 목표를 정하진 못해 (채팅 명령은 그대로 된다)");
    return { stop() {} };
  }

  let socket = null;
  let backoff = RECONNECT_MIN_MS;
  let stopped = false;
  let waiting = null; // resolve of the in-flight plan request
  let goal = "";
  const results = [];

  const remember = (line) => {
    results.push(line);
    while (results.length > MAX_RESULTS) results.shift();
  };

  /** A short, honest picture of where she is. Nothing in it is an instruction. */
  const snapshot = () => {
    const p = bot.entity?.position;
    const seen = [];
    if (p) {
      for (const name of LOOK_FOR) {
        const ids = skills.ids(GROUPS[name] ?? [name]);
        if (!ids.length) continue;
        const found = bot.findBlocks({ matching: ids, maxDistance: 32, count: 1 });
        if (found.length) seen.push(`${name} ${Math.round(found[0].distanceTo(p))}칸`);
      }
    }
    const threats = Object.values(bot.entities)
      .filter((e) => e && e.type === "hostile" && p && e.position.distanceTo(p) < 16)
      .map((e) => `${e.name} ${Math.round(e.position.distanceTo(p))}칸`);

    return {
      position: p ? { x: p.x, y: p.y, z: p.z } : undefined,
      health: bot.health,
      food: bot.food,
      isDay: bot.time?.isDay ?? true,
      inventory: skills.inventorySummary(),
      nearby: seen.join(", ") || "가까이에 쓸 만한 게 안 보임",
      threats: threats.join(", "),
      goal,
      lastResults: [...results],
    };
  };

  const send = (message) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  /** One step of a plan, mapped onto a skill she already has. */
  const run = async (step) => {
    const what = typeof step.what === "string" ? step.what : "";
    const count = Number.isFinite(step.count) ? Math.max(1, Math.min(32, Math.round(step.count))) : 1;
    switch (step.skill) {
      case "mine":
        return skills.mine(what, count);
      case "craft":
        return skills.craft(what, count);
      case "equip":
        return skills.equipBestTool(what);
      case "goto":
        return skills.goTo(Number(step.x), Number(step.y), Number(step.z), 2);
      case "wait": {
        const seconds = Math.max(1, Math.min(30, Number(step.seconds) || 5));
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return { ok: true, detail: `${seconds}초 기다렸어` };
      }
      default:
        return { ok: false, detail: `"${step.skill}" 은 내가 할 줄 모르는 거야` };
    }
  };

  const askForPlan = () =>
    new Promise((resolve) => {
      waiting = resolve;
      send({ type: "mc_state", state: snapshot() });
      setTimeout(() => {
        if (waiting === resolve) {
          waiting = null;
          resolve(null);
        }
      }, PLAN_TIMEOUT_MS);
    });

  const think = async () => {
    while (!stopped) {
      // Nothing to decide while she is busy staying alive.
      if (state.reflex || !socket || socket.readyState !== WebSocket.OPEN) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      const plan = await askForPlan();
      if (!plan || !plan.steps?.length) {
        await new Promise((r) => setTimeout(r, IDLE_PAUSE_MS));
        continue;
      }

      goal = plan.goal || goal;
      log(`[계획] ${goal} (${plan.steps.length}단계)`);
      if (plan.say) bot.chat(String(plan.say).slice(0, 200));

      let anyWorked = false;
      for (const step of plan.steps) {
        if (stopped) return;
        if (state.reflex) {
          remember(`${step.skill} 하려다 말았어 — ${state.reflex} 중`);
          break;
        }
        const label = [step.skill, step.what, step.count].filter(Boolean).join(" ");
        try {
          const result = await run(step);
          if (result.ok) anyWorked = true;
          remember(`${label} → ${result.ok ? "" : "실패: "}${result.detail}`);
          log(`[계획] ${label} → ${result.detail}`);
        } catch (err) {
          remember(`${label} → 오류: ${err.message}`);
          log(`[계획] ${label} 오류: ${err.message}`);
        }
      }

      await new Promise((r) => setTimeout(r, anyWorked ? AFTER_PLAN_MS : AFTER_FAILED_PLAN_MS));
    }
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(url);
    socket = ws;

    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (event.type === "hello") {
        backoff = RECONNECT_MIN_MS;
        log(`[계획] 시로 본체와 연결됨 (${url})`);
        return;
      }
      if (event.type !== "mc_plan") return;
      const resolve = waiting;
      waiting = null;
      resolve?.(Array.isArray(event.steps) && event.goal ? event : null);
    });
    ws.on("close", () => {
      if (socket === ws) socket = null;
      if (stopped) return;
      setTimeout(connect, backoff);
      backoff = Math.min(RECONNECT_MAX_MS, Math.round(backoff * 1.7));
    });
    ws.on("error", () => {
      /* 'close' follows, which is where the retry lives */
    });
  };

  connect();
  void think();

  return {
    stop() {
      stopped = true;
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
    },
  };
}

module.exports = { startAgent };
