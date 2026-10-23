// Tests for avatar/browser.js, run inside real Electron (it needs a Chromium to drive):
//
//   cd avatar && npx electron tools/test-browser.js
//
// Two local servers stand in for an allowed site and a site that is not allowed. The point of
// most of these is what must NOT happen: the other site never receives a request, a password
// field is never typed into, nothing that cannot be taken back runs without an approval.
// A window may flash up while the sign-in test runs. Exits non-zero on failure.
const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const assert = require("node:assert/strict");
const B = require("../browser.js");

/* ---------- pure rules ---------- */
function pure() {
  const sites = ["example.edu", "*.shop.test"];
  assert.equal(B.urlAllowed("https://example.edu/a", sites), true);
  assert.equal(B.urlAllowed("https://canvas.example.edu/a", sites), true, "subdomain");
  assert.equal(B.urlAllowed("https://notexample.edu/", sites), false, "suffix must be a real subdomain");
  assert.equal(B.urlAllowed("https://example.edu.evil.test/", sites), false);
  assert.equal(B.urlAllowed("https://x.shop.test/", sites), true);
  assert.equal(B.urlAllowed("http://example.edu/", sites), false, "plain http only for a listed loopback host");
  assert.equal(B.urlAllowed("http://127.0.0.1:8/", ["127.0.0.1"]), true);
  assert.equal(B.urlAllowed("javascript:alert(1)", sites), false);
  assert.equal(B.urlAllowed("file:///etc/passwd", ["etc"]), false);
  assert.equal(B.urlAllowed("data:text/html,hi", sites), false);
  assert.equal(B.urlAllowed("https://user:pw@example.edu/", sites), false, "credentials in the address");
  assert.deepEqual(B.normalizeSites(["HTTPS://Canvas.Example.edu/x?y", "*.a.b", "c.d:8080"]), ["canvas.example.edu", "a.b", "c.d"]);
  assert.equal(B.isCredentialField({ tag: "input", type: "password" }), true);
  assert.equal(B.isCredentialField({ tag: "input", type: "text", name: "user_otp" }), true);
  assert.equal(B.isCredentialField({ tag: "input", type: "text", placeholder: "인증번호" }), true);
  assert.equal(B.isCredentialField({ tag: "input", type: "text", autocomplete: "one-time-code" }), true);
  assert.equal(B.isCredentialField({ tag: "input", type: "text", name: "classname" }), false, "'ssn' inside a word is not a credential");
  assert.equal(B.isCredentialField({ tag: "input", type: "text", name: "q", placeholder: "Search" }), false);
  assert.ok(B.riskReason({ tag: "button", type: "submit", text: "Go", inForm: true }), "a submit button");
  assert.ok(B.riskReason({ tag: "button", type: "", text: "Go", inForm: true }), "a button in a form defaults to submit");
  assert.equal(B.riskReason({ tag: "button", type: "button", text: "Show more", inForm: true }), "");
  assert.ok(B.riskReason({ tag: "a", text: "Sign out", href: "https://x/y" }));
  assert.ok(B.riskReason({ tag: "a", text: "x", href: "https://x/account/logout" }));
  assert.ok(B.riskReason({ tag: "a", text: "과제 제출" }));
  assert.ok(B.riskReason({ tag: "button", text: "결제하기" }));
  assert.equal(B.riskReason({ tag: "a", text: "Page two", href: "https://x/page2" }), "");
  assert.equal(B.looksLikeLogin("https://login.microsoftonline.com/x"), true);
  assert.equal(B.looksLikeLogin("https://school.edu/sso/start"), true);
  assert.equal(B.looksLikeLogin("https://school.edu/courses/1"), false);
  console.log("pure rules: ok");
}

/* ---------- two local "sites" ---------- */
const hits = { saved: 0, deleted: 0, loggedOut: 0, b: 0, searches: [] };
const tall = '<div style="height:3000px">tall</div>';
function serve(handler) { return new Promise((r) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => r(s)); }); }
let PA = 0, PB = 0; // picked when the servers start; the pages read them when they are asked for
const A = (req, res) => {
  const u = new URL(req.url, "http://x");
  const html = (b, code = 200) => { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<!doctype html><title>${u.pathname}</title><body>${b}`); };
  if (u.pathname === "/") return html(`<h1>SHIRO TEST INDEX</h1>
    <a href="/page2">Page two</a> <a href="http://localhost:${PB}/off">Off site</a> <a href="/redirect-out">Redirect out</a>
    <a href="http://localhost:${PB}/popup" target="_blank">Popup out</a> <a href="/download.txt">Get file</a> <a href="/logout">Sign out</a> <a href="/login">Account</a>
    <form action="/search" method="get"><input type="search" name="q" placeholder="Search"></form>
    <form action="/save" method="post"><input type="text" name="note" placeholder="Note"><input type="text" name="otp" placeholder="code"><button>Save note</button></form>
    <form action="/delete" method="post"><button type="submit">Delete everything</button></form>
    <button type="button" id="more" onclick="document.getElementById('late').textContent='LOADED LATE'">Show more</button>
    <p id="late"></p><script>setTimeout(()=>{document.body.insertAdjacentHTML('beforeend','<p>RENDERED BY JS</p>')},300)</script>${tall}`);
  if (u.pathname === "/page2") return html(`<h1>PAGE TWO</h1><a href="/">Home</a>`);
  if (u.pathname === "/login") return html(`<h1>Sign in</h1><form><input name="user" placeholder="user"><input type="password" name="pw"></form>`);
  if (u.pathname === "/search") { hits.searches.push(u.searchParams.get("q")); return html(`SEARCH: ${u.searchParams.get("q")}`); }
  if (u.pathname === "/redirect-out") { res.writeHead(302, { Location: `http://localhost:${PB}/redir` }); return res.end(); }
  if (u.pathname === "/logout") { hits.loggedOut++; return html("LOGGED OUT"); }
  if (u.pathname === "/save") { hits.saved++; return html("SAVED"); }
  if (u.pathname === "/delete") { hits.deleted++; return html("DELETED"); }
  if (u.pathname === "/download.txt") { res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": "attachment; filename=x.txt" }); return res.end("file"); }
  res.writeHead(404); res.end("nope");
};
const Bsite = (req, res) => { hits.b++; res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>B</title>OFF-LIST SITE"); };

/* ---------- the browser ---------- */
async function main() {
  pure();
  PA = (await serve(A)).address().port; PB = (await serve(Bsite)).address().port;
  let config = { allowBrowser: false, browserSites: ["127.0.0.1"] };
  const logs = [];
  const br = B.createBrowser({ getConfig: () => config, log: (l) => logs.push(l) });
  const ref = (snap, text) => { const e = snap.elements.find((x) => x.text === text || x.text.includes(text) || x.placeholder === text); assert.ok(e, `no element "${text}" in: ${snap.elements.map((x) => x.text || x.placeholder).join(" | ")}`); return e.ref; };
  const A_URL = `http://127.0.0.1:${PA}/`;
  const bShown = () => BrowserWindow.getAllWindows().some((w) => w.isVisible());

  // 1 off by default
  let r = await br.run({ action: "open", url: A_URL });
  assert.equal(r.ok, false); assert.match(r.error, /꺼져 있어/); console.log("1 off unless allowBrowser and a site are set");
  config = { allowBrowser: true, browserSites: [] };
  r = await br.run({ action: "open", url: A_URL }); assert.equal(r.ok, false); console.log("1b allowBrowser with no sites is still off");
  config = { allowBrowser: true, browserSites: ["127.0.0.1"] };

  // 2 refused addresses
  for (const url of [`http://localhost:${PB}/`, "javascript:alert(1)", "file:///etc/passwd", "http://example.com/", "https://user:pw@127.0.0.1/"]) {
    r = await br.run({ action: "open", url }); assert.equal(r.ok, false, url);
  }
  assert.equal(hits.b, 0); console.log("2 off-list, javascript:, file:, plain-http and credentialed addresses refused; the other site saw nothing");
  r = await br.run({ action: "click", ref: 1 }); assert.equal(r.ok, false); assert.match(r.error, /open/); console.log("2b no page open: told to open one");

  // 3 open and read
  r = await br.run({ action: "open", url: A_URL }); assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.match(r.text, /SHIRO TEST INDEX/); assert.ok(r.elements.length >= 8); assert.equal(r.title, "/");
  assert.match(r.text, /RENDERED BY JS/, "waits for a page that fills itself in");
  assert.ok(!JSON.stringify(r).includes('"password"'), "no secrets in the reading");
  console.log("3 opened and read:", r.elements.length, "elements; JS-rendered text present");
  let snap = r;

  // 4 links
  r = await br.run({ action: "click", ref: ref(snap, "Page two") }); assert.match(r.text, /PAGE TWO/); assert.match(r.url, /\/page2$/);
  r = await br.run({ action: "back" }); assert.match(r.text, /SHIRO TEST INDEX/); snap = r; console.log("4 a link, then back");
  r = await br.run({ action: "scroll", amount: 800 }); assert.ok(r.scroll.y >= 700, "scrolled " + r.scroll.y); snap = r;
  r = await br.run({ action: "click", ref: ref(snap, "Show more") }); assert.match(r.text, /LOADED LATE/); snap = r; console.log("4b scroll and a harmless button");

  // 5 getting sent elsewhere
  r = await br.run({ action: "click", ref: ref(snap, "Off site") }); assert.ok(r.blocked?.length, "link to another host"); assert.match(r.url, new RegExp(`:${PA}/`));
  snap = await br.run({ action: "snapshot" });
  r = await br.run({ action: "click", ref: ref(snap, "Redirect out") }); assert.ok(r.blocked?.length, "redirect to another host"); assert.match(r.url, new RegExp(`:${PA}/`));
  snap = await br.run({ action: "snapshot" });
  r = await br.run({ action: "click", ref: ref(snap, "Popup out") }); assert.ok(r.blocked?.length, "popup to another host");
  snap = await br.run({ action: "snapshot" });
  r = await br.run({ action: "click", ref: ref(snap, "Get file") }); assert.equal(r.ok, true); console.log("5 off-list link, redirect and popup all blocked; a download does nothing");
  assert.equal(hits.b, 0, "the off-list server was never contacted"); console.log("5b the off-list server received 0 requests");

  // 6 typing
  snap = await br.run({ action: "snapshot" });
  r = await br.run({ action: "type", ref: ref(snap, "Note"), text: "hello" }); assert.equal(r.ok, true);
  assert.equal(r.elements.find((e) => e.placeholder === "Note").value, "hello"); console.log("6 typed into a text field");
  r = await br.run({ action: "type", ref: ref(snap, "code"), text: "123456" }); assert.equal(r.ok, false); assert.match(r.error, /직접/); console.log("6b a one-time-code field is refused");

  // 7 search box: Enter is fine
  r = await br.run({ action: "type", ref: ref(snap, "Search"), text: "cats" });
  r = await br.run({ action: "press", key: "Enter" }); assert.ok(!r.gated, "search is not gated"); assert.match(r.text, /SEARCH: cats/); assert.deepEqual(hits.searches, ["cats"]); console.log("7 Enter in a search box searches");

  // 8 a form that saves: gated, then approved
  r = await br.run({ action: "open", url: A_URL }); snap = r;
  await br.run({ action: "type", ref: ref(snap, "Note"), text: "to keep" });
  r = await br.run({ action: "click", ref: ref(snap, "Save note") }); assert.equal(r.gated, true); assert.ok(r.screenshot.data.startsWith("/9j/"), "a JPEG of what she is about to do"); assert.equal(hits.saved, 0);
  console.log("8 'Save' is stopped with a screenshot; nothing sent:", r.reason);
  r = await br.run({ action: "approve" }); assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200)); assert.equal(hits.saved, 1); assert.match(r.text, /SAVED/); console.log("8b approved: it ran, once");
  r = await br.run({ action: "approve" }); assert.equal(r.ok, false); console.log("8c approving twice does nothing");

  // 9 delete
  r = await br.run({ action: "open", url: A_URL }); snap = r;
  r = await br.run({ action: "click", ref: ref(snap, "Delete everything") }); assert.equal(r.gated, true); assert.equal(hits.deleted, 0);
  await br.run({ action: "snapshot" }); // doing anything else drops the pending approval
  r = await br.run({ action: "approve" }); assert.equal(r.ok, false); assert.equal(hits.deleted, 0); console.log("9 doing something else first drops the pending approval");
  snap = await br.run({ action: "snapshot" });
  r = await br.run({ action: "click", ref: ref(snap, "Delete everything") }); assert.equal(r.gated, true);
  r = await br.run({ action: "approve" }); assert.equal(hits.deleted, 1); console.log("9b delete ran only after approval");

  // 10 sign out is stopped (it would end the owner's session); cancel
  r = await br.run({ action: "open", url: A_URL }); snap = r;
  r = await br.run({ action: "click", ref: ref(snap, "Sign out") }); assert.equal(r.gated, true); assert.equal(hits.loggedOut, 0);
  r = await br.run({ action: "cancel" }); assert.equal(r.cancelled, true); r = await br.run({ action: "approve" }); assert.equal(r.ok, false); assert.equal(hits.loggedOut, 0); console.log("10 'Sign out' stopped; cancelled; never ran");

  // 11 a login page
  r = await br.run({ action: "open", url: `http://127.0.0.1:${PA}/login` }); assert.equal(r.loginRequired, true); assert.equal(r.hasPassword, true);
  const pw = r.elements.find((e) => e.type === "password"); assert.ok(pw && pw.value === undefined, "the password field never reports a value");
  r = await br.run({ action: "type", ref: pw.ref, text: "secret" }); assert.equal(r.ok, false); console.log("11 login page recognised; her typing into its password field refused");

  // 12 the owner signs in by hand
  assert.equal(bShown(), false);
  r = await br.run({ action: "login" }); assert.equal(r.loginMode, true); assert.equal(bShown(), true, "the window is shown for the owner");
  r = await br.run({ action: "snapshot" }); assert.equal(r.ok, false); assert.equal(r.loginMode, true); console.log("12 login window shown; her actions paused");
  const w = BrowserWindow.getAllWindows()[0];
  await w.webContents.executeJavaScript(`location.href = "http://localhost:${PB}/signin-by-owner"`); await new Promise((x) => setTimeout(x, 800));
  assert.equal(hits.b, 1, "the owner can go where sign-in sends them"); console.log("12b the owner, signing in, can follow a redirect to another host");
  r = await br.run({ action: "login_done" }); assert.equal(r.loginMode, false); assert.equal(bShown(), false);
  r = await br.run({ action: "open", url: A_URL }); assert.equal(r.ok, true);
  await br.run({ action: "snapshot" });
  snap = await br.run({ action: "snapshot" });
  r = await br.run({ action: "click", ref: ref(snap, "Off site") }); assert.ok(r.blocked?.length); assert.equal(hits.b, 1, "restrictions are back"); console.log("12c done: window hidden, restrictions back");

  // 13 screenshot and status
  r = await br.run({ action: "screenshot" }); assert.ok(r.screenshot.data.startsWith("/9j/")); r = await br.run({ action: "status" }); assert.equal(r.open, true); console.log("13 screenshot and status");

  // 14 one at a time
  const [p1, p2] = await Promise.all([br.run({ action: "open", url: A_URL }), br.run({ action: "open", url: `http://127.0.0.1:${PA}/page2` })]);
  assert.ok(p1.ok && p2.ok); assert.match(p2.url, /page2/); console.log("14 two requests at once run one after the other");

  // 15 closing the window ends login mode
  await br.run({ action: "login" }); BrowserWindow.getAllWindows()[0].close(); await new Promise((x) => setTimeout(x, 400));
  assert.equal(br.isLoginMode(), false); r = await br.run({ action: "open", url: A_URL }); assert.equal(r.ok, true); console.log("15 closing the window ends login mode; a new one opens on demand");
  console.log("ALL BROWSER TESTS PASSED");
}
// the real avatar always has its own window open; here the browser window is the only one
app.on("window-all-closed", () => {});
app.whenReady().then(() => main().then(() => app.quit(), (e) => { console.error("FAIL:", e.message); console.error(e.stack.split("\n").slice(1, 4).join("\n")); app.exit(1); }));
