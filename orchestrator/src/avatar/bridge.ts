import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { Emotion } from "../persona.js";

// The avatar renders on the owner's PC while the orchestrator lives on the VM,
// so replies are pushed over a WebSocket instead of being drawn in-process.
// Nothing here is load-bearing: if no avatar is connected, Discord still works
// exactly as before.

export type AvatarEvent =
  | { type: "hello"; emotions: readonly string[] }
  | { type: "say"; id: string; emotion: Emotion; text: string }
  // The text of a "say" that is still being written: everything said so far.
  // A streamed reply starts its "say" before the words exist, and fills it in.
  | { type: "caption"; id: string; text: string }
  // The voice for a "say", streamed as it is synthesized: start, then base64
  // audio chunks in order, then end. All carry the id of the "say" they belong to.
  | { type: "speak_start"; id: string; mime: string }
  | { type: "speak_chunk"; id: string; data: string }
  | { type: "speak_end"; id: string }
  // Asks the avatar's PC for a picture of the owner's screen. The answer comes
  // back as a `capture_result` carrying the same id.
  | { type: "capture_request"; id: string }
  // What she made of the owner's spoken words ("" when nothing could be made out),
  // so the avatar can stop showing "listening…".
  | { type: "heard"; text: string };

// One job posting as the PC-side crawler reports it. Every field but the URL
// may be missing — job boards don't always give a date or a clean location.
export type RawJobPosting = {
  jobUrl: string;
  title: string;
  company: string;
  location?: string | null;
  datePosted?: string | null;
  site: string;
  query?: string | null;
};

type Client = {
  socket: WebSocket;
  authed: boolean;
  alive: boolean;
};

const AUTH_TIMEOUT_MS = 5_000;
const PING_INTERVAL_MS = 30_000;

const clients = new Set<Client>();
let server: WebSocketServer | null = null;

/** True when at least one avatar app is listening — TTS should stay off otherwise. */
export function hasAvatarClient(): boolean {
  for (const c of clients) if (c.authed && c.socket.readyState === WebSocket.OPEN) return true;
  return false;
}

function send(client: Client, event: AvatarEvent): void {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  try {
    client.socket.send(JSON.stringify(event));
  } catch (err) {
    console.error("[avatar] send failed:", err);
  }
}

export function broadcast(event: AvatarEvent): void {
  for (const client of clients) {
    if (client.authed) send(client, event);
  }
}

export type ScreenCapture = { mime: string; data: string };

type PendingCapture = {
  client: Client;
  resolve: (result: ScreenCapture) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

const pendingCaptures = new Map<string, PendingCapture>();
const CAPTURE_TIMEOUT_MS = 10_000;
// A screenshot arrives as base64 in one frame; this keeps a misbehaving client
// from feeding the model (and our memory) something enormous.
const MAX_CAPTURE_BASE64 = 8 * 1024 * 1024;
const CAPTURE_MIMES = new Set(["image/jpeg", "image/png"]);

/**
 * Asks the connected avatar for one picture of the owner's screen. Rejects
 * with a reason that reads well to the owner when nobody is connected, the
 * avatar has screen capture switched off, or it doesn't answer in time.
 */
export function requestScreenCapture(): Promise<ScreenCapture> {
  let target: Client | undefined;
  for (const c of clients) {
    if (c.authed && c.socket.readyState === WebSocket.OPEN) target = c;
  }
  if (!target) return Promise.reject(new Error("아바타가 켜져 있지 않아서 화면을 볼 수 없어"));
  const client = target;

  const id = randomUUID();
  return new Promise<ScreenCapture>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCaptures.delete(id);
      reject(new Error("화면 캡처 응답이 없어"));
    }, CAPTURE_TIMEOUT_MS);
    pendingCaptures.set(id, { client, resolve, reject, timer });
    send(client, { type: "capture_request", id });
  });
}

/* ---------- watch mode: the avatar streams changed frames while the owner has it on ---------- */

export type WatchListener = {
  onState: (on: boolean) => void;
  onFrame: (frame: ScreenCapture) => void;
};

let watchListener: WatchListener | null = null;
// The client that turned watch mode on; only its frames count, and it
// disconnecting ends the session.
let watcher: Client | null = null;

export function setWatchListener(listener: WatchListener): void {
  watchListener = listener;
}

function isValidImage(mime: unknown, data: unknown): data is string {
  return (
    typeof mime === "string" &&
    CAPTURE_MIMES.has(mime) &&
    typeof data === "string" &&
    data.length > 0 &&
    data.length <= MAX_CAPTURE_BASE64
  );
}

/* ---------- voice input: the owner speaks to the avatar ---------- */

export type VoiceAudio = { mime: string; data: string };
export type VoiceListener = {
  /** The owner started talking: whatever she is saying should stop. */
  onStart: () => void;
  /** One finished utterance. */
  onInput: (audio: VoiceAudio) => void;
};

let voiceListener: VoiceListener | null = null;
// About a minute of 16 kHz mono 16-bit audio, as base64.
const MAX_VOICE_BASE64 = 4 * 1024 * 1024;

export function setVoiceListener(listener: VoiceListener): void {
  voiceListener = listener;
}

function onVoiceMessage(msg: { type?: string; mime?: unknown; data?: unknown }): void {
  if (msg.type === "voice_start") {
    voiceListener?.onStart();
  } else if (msg.type === "voice_input") {
    if (msg.mime !== "audio/wav" || typeof msg.data !== "string" || msg.data.length === 0 || msg.data.length > MAX_VOICE_BASE64) {
      return;
    }
    voiceListener?.onInput({ mime: msg.mime, data: msg.data });
  }
}

export type JobListener = (postings: RawJobPosting[]) => void;
let jobListener: JobListener | null = null;
const MAX_JOB_BATCH = 500;

export function setJobListener(listener: JobListener): void {
  jobListener = listener;
}

function isValidJobPosting(p: unknown): p is RawJobPosting {
  if (!p || typeof p !== "object") return false;
  const j = p as Record<string, unknown>;
  return typeof j.jobUrl === "string" && j.jobUrl.length > 0 && typeof j.title === "string" && typeof j.company === "string" && typeof j.site === "string";
}

function onJobMessage(msg: { type?: string; postings?: unknown }): void {
  if (msg.type !== "job_results" || !Array.isArray(msg.postings)) return;
  const postings = msg.postings.filter(isValidJobPosting).slice(0, MAX_JOB_BATCH);
  if (postings.length > 0) jobListener?.(postings);
}

function onWatchMessage(client: Client, msg: { type?: string; on?: unknown; mime?: unknown; data?: unknown }): void {
  if (msg.type === "watch_state") {
    const on = msg.on === true;
    if (on) watcher = client;
    else if (watcher === client) watcher = null;
    else return;
    watchListener?.onState(on);
  } else if (msg.type === "watch_frame") {
    if (watcher !== client || !isValidImage(msg.mime, msg.data)) return;
    watchListener?.onFrame({ mime: msg.mime as string, data: msg.data });
  }
}

function onCaptureResult(client: Client, msg: { id?: unknown; mime?: unknown; data?: unknown; error?: unknown }): void {
  if (typeof msg.id !== "string") return;
  const pending = pendingCaptures.get(msg.id);
  // Only the client that was asked may answer, and only once.
  if (!pending || pending.client !== client) return;
  pendingCaptures.delete(msg.id);
  clearTimeout(pending.timer);

  if (typeof msg.error === "string") {
    pending.reject(new Error(msg.error));
  } else if (
    typeof msg.mime !== "string" ||
    !CAPTURE_MIMES.has(msg.mime) ||
    typeof msg.data !== "string" ||
    msg.data.length === 0 ||
    msg.data.length > MAX_CAPTURE_BASE64
  ) {
    pending.reject(new Error("받은 화면 이미지가 올바르지 않아"));
  } else {
    pending.resolve({ mime: msg.mime, data: msg.data });
  }
}

export function say(emotion: Emotion, text: string): string {
  const id = randomUUID();
  broadcast({ type: "say", id, emotion, text });
  return id;
}

export function startAvatarBridge(emotions: readonly string[]): void {
  const token = process.env.AVATAR_BRIDGE_TOKEN;
  if (!token) {
    console.warn("[avatar] AVATAR_BRIDGE_TOKEN is not set — avatar bridge disabled");
    return;
  }

  const port = Number(process.env.AVATAR_BRIDGE_PORT ?? 18790);
  // Loopback by default; expose it over the tailnet with `tailscale serve`
  // rather than binding to every interface.
  const host = process.env.AVATAR_BRIDGE_HOST ?? "127.0.0.1";

  // Room for one screenshot frame (MAX_CAPTURE_BASE64 plus the JSON around it).
  server = new WebSocketServer({ host, port, maxPayload: MAX_CAPTURE_BASE64 + 1024 });

  server.on("connection", (socket) => {
    const client: Client = { socket, authed: false, alive: true };
    clients.add(client);

    // Credentials go in the first frame, never the URL.
    const authTimer = setTimeout(() => {
      if (!client.authed) socket.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    socket.on("pong", () => {
      client.alive = true;
    });

    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        socket.close(4002, "bad json");
        return;
      }
      if (client.authed) {
        // The only thing a connected avatar says to us is an answer to a request.
        const reply = parsed as { type?: string; id?: unknown; on?: unknown; mime?: unknown; data?: unknown; error?: unknown; postings?: unknown };
        if (reply.type === "capture_result") onCaptureResult(client, reply);
        else if (reply.type === "voice_start" || reply.type === "voice_input") onVoiceMessage(reply);
        else if (reply.type === "job_results") onJobMessage(reply);
        else onWatchMessage(client, reply);
        return;
      }
      const msg = parsed as { type?: string; token?: string };
      if (msg.type !== "auth" || msg.token !== token) {
        socket.close(4003, "unauthorized");
        return;
      }
      client.authed = true;
      clearTimeout(authTimer);
      console.log("[avatar] client connected");
      send(client, { type: "hello", emotions });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      clients.delete(client);
      for (const [id, pending] of pendingCaptures) {
        if (pending.client !== client) continue;
        pendingCaptures.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error("화면을 받기 전에 아바타 연결이 끊겼어"));
      }
      if (watcher === client) {
        watcher = null;
        watchListener?.onState(false);
      }
      console.log("[avatar] client disconnected");
    });

    socket.on("error", (err) => {
      console.error("[avatar] socket error:", err.message);
    });
  });

  server.on("error", (err) => {
    console.error("[avatar] bridge error:", err);
  });

  // Drop clients that stopped answering, so hasAvatarClient() stays honest.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        /* the close handler cleans up */
      }
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();

  console.log(`[avatar] bridge listening on ws://${host}:${port}`);
}
