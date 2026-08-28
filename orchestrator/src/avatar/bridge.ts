import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { Emotion } from "../persona.js";

// The avatar renders on the owner's PC while the orchestrator lives on the VM,
// so replies are pushed over a WebSocket instead of being drawn in-process.
// Nothing here is load-bearing: if no avatar is connected, Discord still works
// exactly as before.

export type AvatarEvent =
  | { type: "hello"; emotions: readonly string[] }
  | { type: "say"; id: string; emotion: Emotion; text: string };

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

  server = new WebSocketServer({ host, port });

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
      if (client.authed) return; // Nothing to say to us once connected.
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        socket.close(4002, "bad json");
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
