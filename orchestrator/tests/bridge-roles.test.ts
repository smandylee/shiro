// Who gets a request on the bridge. The avatar, the dev worker and the Minecraft bot share it and only
// the avatar can answer a screenshot or a browser action; this checks that nothing else is asked.
//
//   cd orchestrator && npx tsx tests/bridge-roles.test.ts
import assert from "node:assert/strict";
import WebSocket from "ws";
process.env.AVATAR_BRIDGE_TOKEN = "t0ken"; const PORT = String(20000 + Math.floor(Math.random() * 20000));
process.env.AVATAR_BRIDGE_PORT = PORT;
const b = await import("../src/avatar/bridge.js");
b.startAvatarBridge(["neutral"]);
await new Promise((r) => setTimeout(r, 300));

type C = { ws: WebSocket; got: any[] };
async function connect(role?: string, token = "t0ken"): Promise<C> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`); const got: any[] = [];
  ws.on("message", (d) => got.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "auth", token, ...(role ? { role } : {}) }));
  await new Promise((r) => setTimeout(r, 150));
  return { ws, got };
}
const reqs = (c: C) => c.got.filter((m) => m.type === "capture_request");
const answer = (c: C) => { const r = reqs(c)[0]; c.ws.send(JSON.stringify({ type: "capture_result", id: r.id, mime: "image/jpeg", data: "AAAA" })); };
const closeAll = async (...cs: C[]) => { cs.forEach((c) => c.ws.close()); await new Promise((r) => setTimeout(r, 200)); };

// 1. the case that used to fail: the dev worker connects AFTER the avatar
{ const avatar = await connect("avatar"); const dev = await connect("dev"); const mc = await connect("minecraft");
  const p = b.requestScreenCapture(); await new Promise((r) => setTimeout(r, 150));
  assert.equal(reqs(avatar).length, 1, "the avatar is asked"); assert.equal(reqs(dev).length, 0, "the dev worker is not"); assert.equal(reqs(mc).length, 0, "nor the Minecraft bot");
  answer(avatar); assert.equal((await p).mime, "image/jpeg"); await closeAll(avatar, dev, mc); console.log("1 dev worker connected last: capture still goes to the avatar"); }
// 2. an avatar from before roles existed, next to a worker that declares itself
{ const oldAvatar = await connect(undefined); const dev = await connect("dev");
  const p = b.requestScreenCapture(); await new Promise((r) => setTimeout(r, 150));
  assert.equal(reqs(oldAvatar).length, 1); assert.equal(reqs(dev).length, 0); answer(oldAvatar); await p; await closeAll(oldAvatar, dev); console.log("2 old avatar without a role is still found"); }
// 3. only the worker and the bot: nobody can answer, and she says so rather than waiting out the timeout
{ const dev = await connect("dev"); const mc = await connect("minecraft");
  await assert.rejects(b.requestScreenCapture(), /아바타가 켜져 있지 않아서/); assert.equal(reqs(dev).length + reqs(mc).length, 0); await closeAll(dev, mc); console.log("3 no avatar: fails at once, nothing sent to the others"); }
// 4. an avatar that reconnected: the newest declared one
{ const a1 = await connect("avatar"); const a2 = await connect("avatar");
  const p = b.requestScreenCapture(); await new Promise((r) => setTimeout(r, 150));
  assert.equal(reqs(a1).length, 0); assert.equal(reqs(a2).length, 1); answer(a2); await p; await closeAll(a1, a2); console.log("4 newest avatar wins"); }
// 5. a wrong token never becomes an avatar, whatever role it claims
{ const bad = await connect("avatar", "wrong"); const dev = await connect("dev");
  await assert.rejects(b.requestScreenCapture(), /아바타가 켜져 있지 않아서/); await closeAll(bad, dev); console.log("5 wrong token claiming to be the avatar is ignored"); }
console.log("bridge roles: ok"); process.exit(0);
