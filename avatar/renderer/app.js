import { poseFor, blendPose, EMOTION_POSES } from "./emotions.js";
import { prepareTail, poseTail, tailBend, drawTail } from "./tail.js";
import { startListening } from "./mic.js";

const EMOTIONS = Object.keys(EMOTION_POSES);
const TRANSITION_MS = 700;
const RECONNECT_MAX_MS = 15000;

// Which group a transform hangs off. Ears ride the head, the head rides the
// body, so a single breath moves everything the way a body actually does.
const PARENT = {
  body: null,
  // No tail groups: it isn't hinged any more. It bends along its own centreline,
  // which the rotation hierarchy has no way to express, so tail.js draws it.
  head: "body",
  // Her hair is attached to her head, so it has to turn with it; hanging it off
  // the body left the back hair standing still while the head moved.
  hair_back: "head",
  hair_front: "head",
  ear_l: "head",
  ear_r: "head",
  eyes: "head",
  irides: "eyes",
  mouth: "head",
};

// The art fills its own frame — the tail tip sits 21px from the left edge, and
// the fluffy one runs right off the bottom — so anything that moves immediately
// clips against it. Draw into a larger canvas and offset the art into it.
// Measured against every emotion at full swing; the tail stays inside these.
const PAD = { x: 170, top: 56, bottom: 60 };

const canvas = document.getElementById("shiro");
const ctx = canvas.getContext("2d");
const bubble = document.getElementById("bubble");
const panel = document.getElementById("panel");
const statusEl = document.getElementById("status");

let config = {
  bridgeUrl: "ws://127.0.0.1:18790",
  bridgeToken: "",
  scale: 0.32,
  showBubble: true,
  voice: true,
  voiceVolume: 0.8,
};
let sheet = null;
const images = new Map();

let fromPose = poseFor("neutral");
let toPose = poseFor("neutral");
let transitionStart = 0;
let releaseAt = Infinity; // when to fall back to neutral

const blinker = { nextBlink: 2, phase: -1 };

// The tail's phase is ACCUMULATED, never computed from the clock. Deriving it
// as `time * speed` means any change of speed multiplies into a huge jump in
// phase — at two minutes uptime, 0.26 -> 0.85 cycles/s snaps the tail through
// ~180 turns. That is what made every emotion change fling the tail around.
let tailPhase = 0;

// Where the head actually is, as opposed to where the pose says it should be.
// It chases the pose instead of following it exactly, so no pose change can
// snap her neck around — the spring absorbs it.
const head = { tilt: 0, bob: 0 };
const HEAD_FOLLOW = 1.8; // rad/s-ish; lower = heavier head

// Hair swings a beat late; the gap between this and the head's actual angle is
// exactly that lag.
let hairLag = 0;

// How open the mouth is, as a vertical scale of the one mouth layer she has (an
// open smile). 1 is that smile as drawn; squashed toward MOUTH_CLOSED it reads
// as a closed smile, so one layer is enough to open and shut while she talks.
const MOUTH_CLOSED = 0.25;
// Speech may open her wider than the resting smile, otherwise most of it would
// only ever hover below that and read as a small twitch.
const MOUTH_OPEN = 1.2;
let mouthScale = 1;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls ?? ""}`;
}

/* ---------- layers ---------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

async function loadSheet() {
  // Prefer the decomposed layers; fall back to the flat illustration so the
  // avatar is testable before the PSD exists.
  try {
    const res = await fetch("../layers/layers.json");
    if (res.ok) {
      const manifest = await res.json();
      const layers = [];
      for (const layer of manifest.layers) {
        const img = await loadImage(`../layers/${layer.file}`);
        images.set(layer.file, img);
        layers.push({ group: "body", ...layer });
      }
      const rigs = new Map();
      const rigRes = await fetch("../layers/tail-rig.json");
      if (rigRes.ok) {
        for (const t of (await rigRes.json()).tails) rigs.set(t.id, prepareTail(t));
      }
      return { canvas: manifest.canvas, groups: manifest.groups ?? {}, layers, rigs, flat: false };
    }
  } catch {
    /* fall through to the flat image */
  }

  const img = await loadImage("../shiro_base.png");
  images.set("shiro_base.png", img);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  return {
    canvas: { width: w, height: h },
    // Treated as the head group so tilt and bob read even before layers exist.
    groups: { head: { pivot: [w / 2, h] }, body: { pivot: [w / 2, h] } },
    layers: [{ file: "shiro_base.png", group: "head" }],
    rigs: new Map(),
    flat: true,
  };
}

/* ---------- animation ---------- */

function currentPose(now) {
  const t = Math.min(1, (now - transitionStart) / TRANSITION_MS);
  return blendPose(fromPose, toPose, t * t * (3 - 2 * t)); // smoothstep
}

function tailWave(pose, phase) {
  const s = Math.sin(phase);
  let wave;
  if (pose.tailWave === "still") wave = s * 0.15;
  else if (pose.tailWave === "flick") wave = Math.sign(s) * Math.pow(Math.abs(s), 0.35);
  else wave = s;
  // A lone sine is a metronome. A second, slower swing at an irrational ratio
  // keeps the pattern from ever repeating exactly, so it reads as an animal
  // rather than a windscreen wiper.
  const drift = Math.sin(phase * 0.37 + 1.3) * 0.3;
  return wave * 0.78 + drift;
}

function blinkFactor(pose, dt) {
  const DURATION = 0.13;
  if (blinker.phase >= 0) {
    blinker.phase += dt;
    if (blinker.phase > DURATION) {
      blinker.phase = -1;
      blinker.nextBlink = pose.blinkEvery * (0.6 + Math.random() * 0.8);
      return 1;
    }
    return Math.abs(Math.cos((blinker.phase / DURATION) * Math.PI));
  }
  blinker.nextBlink -= dt;
  if (blinker.nextBlink <= 0) blinker.phase = 0;
  return 1;
}

function applyGroup(group, pose, time, blink) {
  const breathe = Math.sin(time * 0.9) * pose.breath;
  switch (group) {
    case "body":
      ctx.translate(0, breathe * 1.5);
      ctx.scale(1, 1 + breathe * 0.0016);
      break;
    case "head":
      ctx.translate(0, head.bob + breathe * 1.2);
      ctx.rotate((head.tilt * Math.PI) / 180);
      break;
    case "ear_l":
      ctx.rotate((-(pose.earAngle + Math.sin(time * 3.1) * pose.earTwitch) * Math.PI) / 180);
      break;
    case "ear_r":
      ctx.rotate(((pose.earAngle + Math.sin(time * 2.7 + 1) * pose.earTwitch) * Math.PI) / 180);
      break;
    case "hair_back":
      // Already turning with the head; this is the bit that trails behind it.
      ctx.rotate(((hairLag - head.tilt) * 0.6 * Math.PI) / 180);
      break;
    case "eyes":
      // Lids close over the eye — the eye itself doesn't move.
      ctx.scale(1, blink);
      break;
    case "irides":
      ctx.translate(pose.gaze[0], pose.gaze[1]);
      break;
    case "mouth":
      ctx.translate(0, breathe * 0.3);
      // About the group's own pivot, so it closes toward the mouth's centre line.
      ctx.scale(1, mouthScale);
      break;
    default:
      break;
  }
}

function pivotOf(group) {
  return sheet.groups?.[group]?.pivot ?? [sheet.canvas.width / 2, sheet.canvas.height];
}

let showPivots = false;

// The tail's live centreline, kept from the last frame so the debug overlay can
// show where the bend actually put it.
const posedSpines = new Map();

/** Debug overlay: pivots and the tail's spine — what motion is actually built on. */
function drawPivots() {
  ctx.save();
  ctx.lineWidth = 3;
  for (const pts of posedSpines.values()) {
    ctx.strokeStyle = "#00e0ff";
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.fillStyle = "#00e0ff";
    for (const [x, y] of pts) ctx.fillRect(x - 3, y - 3, 6, 6);
  }
  for (const [name, g] of Object.entries(sheet.groups ?? {})) {
    const [x, y] = g.pivot;
    ctx.strokeStyle = "#ff3ea5";
    ctx.beginPath();
    ctx.moveTo(x - 18, y);
    ctx.lineTo(x + 18, y);
    ctx.moveTo(x, y - 18);
    ctx.lineTo(x, y + 18);
    ctx.stroke();
    ctx.fillStyle = "#ff3ea5";
    ctx.font = "20px sans-serif";
    ctx.fillText(name, x + 22, y - 6);
  }
  ctx.restore();
}

/** Root-first parent chain, so a child inherits everything above it. */
function chainFor(group) {
  const chain = [];
  let g = group;
  while (g) {
    chain.unshift(g);
    g = PARENT[g] ?? null;
  }
  return chain;
}

let lastFrame = performance.now();

function draw(now) {
  requestAnimationFrame(draw);
  if (!sheet) return;

  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const time = now / 1000;

  if (now > releaseAt) {
    releaseAt = Infinity;
    setEmotion("neutral");
  }

  const pose = currentPose(now);
  const blink = blinkFactor(pose, dt);

  tailPhase += dt * pose.tailSpeed * Math.PI * 2;
  if (tailPhase > Math.PI * 2000) tailPhase -= Math.PI * 2000; // keep the float honest

  // Never let the head sit perfectly still: two slow, unrelated sways mean the
  // pose she settles into is always drifting a little, so arriving at a new one
  // is a change of drift rather than a start from dead stop.
  const idleTilt = Math.sin(time * 0.31) * 0.9 + Math.sin(time * 0.17 + 2.1) * 0.6;
  const idleBob = Math.sin(time * 0.23 + 1.1) * 1.2;
  const k = 1 - Math.exp(-dt * HEAD_FOLLOW);
  head.tilt += (pose.headTilt + idleTilt - head.tilt) * k;
  head.bob += (pose.headBob + idleBob - head.bob) * k;

  hairLag += (head.tilt - hairLag) * Math.min(1, dt * 5);

  // Speaking: follow the voice between closed and open. Otherwise return to
  // the resting open smile. It snaps open faster than it eases shut, which is
  // what makes a mouth read as speech rather than a slow pulse.
  const level = voiceLevel();
  const mouthTarget = level === null ? 1 : MOUTH_CLOSED + (MOUTH_OPEN - MOUTH_CLOSED) * level;
  const mouthRate = level === null ? 6 : mouthTarget > mouthScale ? 30 : 16;
  mouthScale += (mouthTarget - mouthScale) * (1 - Math.exp(-dt * mouthRate));

  const dpr = window.devicePixelRatio || 1;
  const w = (sheet.canvas.width + PAD.x * 2) * config.scale;
  const h = (sheet.canvas.height + PAD.top + PAD.bottom) * config.scale;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  const k2 = dpr * config.scale;
  ctx.setTransform(k2, 0, 0, k2, k2 * PAD.x, k2 * PAD.top);
  ctx.clearRect(
    -PAD.x,
    -PAD.top,
    sheet.canvas.width + PAD.x * 2,
    sheet.canvas.height + PAD.top + PAD.bottom
  );

  for (const layer of sheet.layers) {
    const img = images.get(layer.file);
    if (!img) continue;

    ctx.save();
    // Each group turns about its OWN pivot. Using the layer's pivot for every
    // ancestor is what tore the face apart: the eyes span about the eyes and
    // the nose about the nose, instead of the whole head about the neck.
    for (const group of chainFor(layer.group)) {
      const pivot = pivotOf(group);
      ctx.translate(pivot[0], pivot[1]);
      applyGroup(group, pose, time, blink);
      ctx.translate(-pivot[0], -pivot[1]);
    }
    const rig = layer.warp === "tail" ? sheet.rigs.get(layer.id) : null;
    if (rig) {
      const bend = tailBend(rig, pose, tailPhase, (ph) => tailWave(pose, ph));
      const posed = poseTail(rig, bend);
      if (showPivots) posedSpines.set(rig.id, posed);
      drawTail(ctx, img, rig, posed);
    } else {
      ctx.drawImage(img, layer.x ?? 0, layer.y ?? 0);
    }
    ctx.restore();
  }

  if (showPivots) drawPivots();
}

/* ---------- emotion + bridge ---------- */

function setEmotion(next) {
  const name = EMOTIONS.includes(next) ? next : "neutral";
  fromPose = currentPose(performance.now());
  toPose = poseFor(name);
  transitionStart = performance.now();
  for (const btn of document.querySelectorAll("#emotions button")) {
    btn.classList.toggle("active", btn.dataset.emotion === name);
  }
}

let bubbleTimer = null;

// The voice belongs to one specific reply. A clip that lands after a newer
// reply has already started would talk over it, so it's matched by id.
let currentSayId = null;

// The voice arrives as a stream of MP3 chunks. They are appended to a
// MediaSource as they come, so playback starts on the first chunk instead of
// after the whole clip. Where MediaSource can't take the format, the chunks are
// gathered and played as one clip once the stream ends.
let voice = null; // { id, audio, url, ms, sb, queue, ended, parts, mime, started, analyser, gain, samples, nodes }

const HOLD_TAIL_MS = 700; // let the pose settle a beat after the last word
const STREAM_STALL_MS = 20000; // never hold a pose longer than this waiting on audio

let audioCtx = null;

// Puts the clip's audio through an analyser (for the mouth) and then a gain
// node (the volume knob) on its way to the speakers. The analyser is tapped
// before the gain, so turning her down doesn't still her mouth.
function routeThroughAnalyser(v) {
  audioCtx ??= new AudioContext();
  audioCtx.resume().catch(() => {});
  const source = audioCtx.createMediaElementSource(v.audio);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  const gain = audioCtx.createGain();
  gain.gain.value = config.voiceVolume;
  source.connect(analyser);
  source.connect(gain);
  gain.connect(audioCtx.destination);
  Object.assign(v, { analyser, gain, samples: new Uint8Array(analyser.fftSize), nodes: [source, analyser, gain] });
}

/** 0..1 loudness of what she is saying right now, or null when she isn't speaking. */
function voiceLevel() {
  const v = voice;
  if (!v?.analyser || v.audio.paused || v.audio.ended) return null;
  v.analyser.getByteTimeDomainData(v.samples);
  let sum = 0;
  for (const s of v.samples) sum += ((s - 128) / 128) ** 2;
  // Gate out the noise floor, then stretch ordinary speech (RMS ~0.05-0.2) across 0..1.
  return Math.min(1, Math.max(0, (Math.sqrt(sum / v.samples.length) - 0.02) * 9));
}

function stopVoice() {
  if (!voice) return;
  const v = voice;
  voice = null;
  v.audio.pause();
  v.nodes?.forEach((n) => n.disconnect());
  v.audio.removeAttribute("src");
  v.audio.load();
  if (v.url) URL.revokeObjectURL(v.url);
}

function startPlayback(v) {
  if (v.started || voice !== v) return;
  v.started = true;
  v.audio.play().catch((err) => console.error("[avatar] voice playback failed:", err));
}

// Feeds queued chunks into the SourceBuffer one at a time (it accepts a single
// append until "updateend"), and closes the stream once the server is done.
function pump(v) {
  if (voice !== v || !v.sb || v.sb.updating) return;
  const next = v.queue.shift();
  if (next) {
    try {
      v.sb.appendBuffer(next);
    } catch (err) {
      console.error("[avatar] voice append failed:", err);
    }
    return;
  }
  if (v.ended && v.ms.readyState === "open") v.ms.endOfStream();
}

function holdPoseUntilVoiceEnds(v) {
  const remaining = Number.isFinite(v.audio.duration) ? v.audio.duration - v.audio.currentTime : 0;
  releaseAt = performance.now() + Math.max(0, remaining) * 1000 + HOLD_TAIL_MS;
}

function onSpeakStart(event) {
  if (!config.voice || event.id !== currentSayId) return;

  stopVoice();
  const audio = new Audio();
  const v = { id: event.id, audio, url: null, ms: null, sb: null, queue: [], ended: false, parts: [], mime: event.mime, started: false };
  routeThroughAnalyser(v);
  voice = v;

  // The pose was set for a guess based on text length, which runs short for a
  // long clip. Hold it while the voice is still coming, with a ceiling in case
  // the stream stalls; the real length replaces this once it is known.
  releaseAt = performance.now() + STREAM_STALL_MS;
  audio.onended = () => {
    if (voice === v) releaseAt = performance.now() + HOLD_TAIL_MS;
  };

  if (window.MediaSource && MediaSource.isTypeSupported(event.mime)) {
    const ms = new MediaSource();
    v.ms = ms;
    v.url = URL.createObjectURL(ms);
    audio.src = v.url;
    ms.addEventListener(
      "sourceopen",
      () => {
        if (voice !== v) return;
        v.sb = ms.addSourceBuffer(event.mime);
        v.sb.addEventListener("updateend", () => {
          startPlayback(v);
          pump(v);
        });
        pump(v);
      },
      { once: true }
    );
    ms.addEventListener("sourceended", () => {
      if (voice === v) holdPoseUntilVoiceEnds(v);
    });
  }
}

function onSpeakChunk(event) {
  const v = voice;
  if (!v || event.id !== v.id) return;

  const bytes = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0));
  if (v.ms) {
    v.queue.push(bytes);
    pump(v);
  } else {
    v.parts.push(bytes);
  }
}

function onSpeakEnd(event) {
  const v = voice;
  if (!v || event.id !== v.id) return;

  v.ended = true;
  if (v.ms) {
    pump(v);
    return;
  }
  // No MediaSource support for this format: play the gathered clip in one go.
  v.url = URL.createObjectURL(new Blob(v.parts, { type: v.mime }));
  v.audio.src = v.url;
  v.audio.onloadedmetadata = () => holdPoseUntilVoiceEnds(v);
  startPlayback(v);
}

// A streamed reply starts its "say" before the words exist and fills them in as
// they are written: each caption is everything said so far.
function onCaption(event) {
  if (event.id !== currentSayId) return;

  const holdMs = Math.min(12000, Math.max(4000, event.text.length * 90));
  // Keep the pose up for as long as the text so far needs; once the voice
  // starts it takes over the timing.
  releaseAt = Math.max(releaseAt, performance.now() + holdMs);

  if (config.showBubble) {
    bubble.textContent = event.text;
    bubble.classList.remove("hidden");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.add("hidden"), holdMs);
  }
}

function onSay(event) {
  currentSayId = event.id;
  stopVoice();
  setEmotion(event.emotion);
  // Hold the emotion roughly as long as it takes to read the line.
  const holdMs = Math.min(12000, Math.max(4000, (event.text?.length ?? 0) * 90));
  releaseAt = performance.now() + holdMs;

  if (config.showBubble && event.text) {
    bubble.textContent = event.text;
    bubble.classList.remove("hidden");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.add("hidden"), holdMs);
  }
}

let backoff = 1000;
// The live, authenticated socket (null while reconnecting), for things the
// avatar sends on its own rather than in reply to a message.
let socket = null;

/* ---------- talking to her ---------- */

const micBadge = document.getElementById("mic-badge");
let listening = null; // the running recording, or null
let micNoticeTimer = null;

function showMic(text, { hideAfterMs } = {}) {
  console.log(`[mic] badge: ${text}`);
  clearTimeout(micNoticeTimer);
  micBadge.textContent = text;
  micBadge.classList.remove("hidden");
  if (hideAfterMs) micNoticeTimer = setTimeout(() => !listening && micBadge.classList.add("hidden"), hideAfterMs);
}

function hideMic() {
  clearTimeout(micNoticeTimer);
  micBadge.classList.add("hidden");
}

function sendJson(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

async function toggleMic() {
  console.log(`[mic] toggle: listening=${Boolean(listening)} socket=${socket ? socket.readyState : "none"}`);
  // Pressing again while listening ends it and sends what was said.
  if (listening) {
    listening.stop();
    return;
  }
  if (socket?.readyState !== WebSocket.OPEN) {
    showMic("🎤 시로와 연결이 안 돼 있어", { hideAfterMs: 3000 });
    return;
  }

  // Whatever she is saying stops the moment the owner starts talking.
  stopVoice();
  sendJson({ type: "voice_start" });
  showMic("🎤 듣는 중… (말이 끝나면 자동으로 보내져)");
  try {
    listening = await startListening({
      onDone: (audio, reason) => {
        listening = null;
        if (!audio) {
          const notice = { "no-speech": "🎤 말이 안 들렸어", noise: "🎤 말소리가 아닌 것 같아" }[reason] ?? "🎤 너무 짧았어";
          showMic(notice, { hideAfterMs: 2500 });
          return;
        }
        showMic("🎤 알아듣는 중…");
        if (!sendJson({ type: "voice_input", ...audio })) showMic("🎤 연결이 끊겨서 못 보냈어", { hideAfterMs: 3000 });
      },
    });
  } catch (err) {
    listening = null;
    console.error("microphone unavailable:", err);
    showMic("🎤 마이크를 쓸 수 없어 (Windows 마이크 설정 확인)", { hideAfterMs: 4000 });
  }
}

function setupMic() {
  window.shiro.onMic(({ toggle, denied }) => {
    if (denied) showMic("🎤 마이크가 꺼져 있어 (config.json 의 allowMicrophone)", { hideAfterMs: 4000 });
    else if (toggle) void toggleMic();
  });
}

/* ---------- watch mode ---------- */

const watchBadge = document.getElementById("watch-badge");
let watching = false;

function sendWatchState() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "watch_state", on: watching }));
}

function setupWatch() {
  window.shiro.onWatch(({ on, denied }) => {
    if (denied) {
      watchBadge.textContent = "화면 보기가 꺼져 있어 (config.json allowScreenCapture)";
      watchBadge.classList.remove("hidden");
      setTimeout(() => {
        if (!watching) watchBadge.classList.add("hidden");
      }, 4000);
      return;
    }
    watching = on;
    watchBadge.textContent = "👀 같이 보는 중 · Ctrl+Shift+W";
    watchBadge.classList.toggle("hidden", !on);
    sendWatchState();
  });
  window.shiro.onWatchFrame((frame) => {
    if (watching && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "watch_frame", ...frame }));
    }
  });
}

function connect() {
  if (!config.bridgeToken) {
    setStatus("config.json 에 bridgeToken 이 없어", "bad");
    return;
  }
  setStatus("연결 중…");
  const ws = new WebSocket(config.bridgeUrl);

  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: config.bridgeToken }));

  ws.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (event.type === "hello") {
      backoff = 1000;
      socket = ws;
      setStatus("시로와 연결됨", "ok");
      // A reconnect starts a fresh session on the other end.
      if (watching) sendWatchState();
    } else if (event.type === "heard") {
      // Text comes back once she has written out what was said; empty means she couldn't.
      if (event.text) hideMic();
      else showMic("🎤 못 알아들었어", { hideAfterMs: 2500 });
    } else if (event.type === "say") {
      if (!listening) hideMic();
      onSay(event);
    } else if (event.type === "caption") {
      onCaption(event);
    } else if (event.type === "speak_start") {
      onSpeakStart(event);
    } else if (event.type === "speak_chunk") {
      onSpeakChunk(event);
    } else if (event.type === "speak_end") {
      onSpeakEnd(event);
    } else if (event.type === "capture_request") {
      // The main process decides whether screen capture is allowed at all.
      window.shiro
        .captureScreen()
        .catch((err) => ({ error: `화면 캡처 실패: ${err.message}` }))
        .then((result) => ws.send(JSON.stringify({ type: "capture_result", id: event.id, ...result })));
    }
  };

  ws.onclose = (e) => {
    if (socket === ws) socket = null;
    setStatus(e.code === 4003 ? "토큰이 틀렸어" : "연결 끊김 · 재시도 중", "bad");
    setTimeout(connect, backoff);
    backoff = Math.min(RECONNECT_MAX_MS, backoff * 1.7);
  };

  ws.onerror = () => ws.close();
}

/* ---------- panel ---------- */

function buildPanel() {
  const holder = document.getElementById("emotions");
  for (const name of EMOTIONS) {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.dataset.emotion = name;
    btn.onclick = () => {
      setEmotion(name);
      releaseAt = Infinity; // hold it so the pose can be judged
    };
    holder.appendChild(btn);
  }

  const scale = document.getElementById("scale");
  scale.value = config.scale;
  scale.oninput = () => {
    config.scale = Number(scale.value);
  };

  const pivots = document.getElementById("pivots");
  pivots.onchange = () => {
    showPivots = pivots.checked;
  };

  const bubbleToggle = document.getElementById("bubble-toggle");
  bubbleToggle.checked = config.showBubble;
  bubbleToggle.onchange = () => {
    config.showBubble = bubbleToggle.checked;
    if (!config.showBubble) {
      clearTimeout(bubbleTimer);
      bubble.classList.add("hidden");
    }
  };

  const voiceToggle = document.getElementById("voice-toggle");
  voiceToggle.checked = config.voice;
  voiceToggle.onchange = () => {
    config.voice = voiceToggle.checked;
    if (!config.voice) stopVoice();
  };

  const volume = document.getElementById("voice-volume");
  volume.value = config.voiceVolume;
  volume.oninput = () => {
    config.voiceVolume = Number(volume.value);
    if (voice?.gain) voice.gain.gain.value = config.voiceVolume;
  };

  document.getElementById("hide-panel").onclick = () => window.shiro.setInteractive(false);
  document.getElementById("quit").onclick = () => window.shiro.quit();
}

/* ---------- boot ---------- */

async function main() {
  config = { ...config, ...(await window.shiro.getConfig()) };
  buildPanel();

  window.shiro.onInteractive((on) => panel.classList.toggle("hidden", !on));
  setupWatch();
  setupMic();

  try {
    sheet = await loadSheet();
    if (sheet.flat) {
      console.log("[avatar] layers/layers.json not found - using the flat illustration");
    }
  } catch (err) {
    setStatus(`이미지를 못 불러왔어: ${err.message}`, "bad");
    return;
  }

  setEmotion("neutral");
  requestAnimationFrame(draw);
  connect();
}

main();
