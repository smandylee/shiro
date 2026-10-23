// A browser of her own, inside the avatar app.
//
// Shiro can open pages, read them, click, type and scroll in a window that
// Electron's own Chromium provides. It has a profile of its own, apart from the
// owner's everyday browser: nothing she can reach is signed in unless the owner
// signed it in there themselves, by hand, in that window.
//
// The rules live here, in the program that holds the browser, and not in a
// prompt that a model is asked to follow:
//
//   - She only goes where `browserSites` in config.json says. Redirects are
//     checked too, so a page cannot send her somewhere else.
//   - Logging in is the owner's: she never types into a password, one-time-code
//     or card field, and a page that wants a login makes her ask the owner,
//     who signs in by hand (`login`) while she waits.
//   - Anything that cannot be taken back — submit, pay, delete, send, sign out —
//     is stopped first and shown to the owner; it runs only when the owner
//     approves that very action in a later message.
//   - Everything it reads is page content, which the orchestrator treats as data.
//
// Off unless config.json has `allowBrowser: true` and at least one site.
"use strict";

const { BrowserWindow, session } = require("electron");

const PARTITION = "persist:shiro-browser";
const WIDTH = 1100;
const HEIGHT = 800;
const LOAD_TIMEOUT_MS = 25_000;
const SETTLE_MS = 800;
const TEXT_LIMIT = 5000;
const MAX_ELEMENTS = 80;
const SHOT_WIDTH = 1100;
const GATE_TTL_MS = 10 * 60 * 1000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/* ---------- where she may go ---------- */

/** Hostnames from config: "https://Canvas.Example.edu/x", "*.example.edu" and "example.edu" all mean example.edu and its subdomains. */
function normalizeSites(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) =>
      String(s)
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .replace(/^\*\./, "")
        .replace(/[/?#].*$/, "")
        .replace(/:\d+$/, "")
    )
    .filter(Boolean);
}

function isHttp(urlString) {
  try {
    const u = new URL(urlString);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Whether `urlString` is a page she may open. Only https (http only for a loopback host you listed), no credentials in the address. */
function urlAllowed(urlString, sites) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "http:") {
    if (!LOOPBACK.has(u.hostname)) return false;
  } else if (u.protocol !== "https:") {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return normalizeSites(sites).some((s) => host === s || host.endsWith(`.${s}`));
}

/* ---------- what she may type, and what she may not do unasked ---------- */

const CREDENTIAL_WORDS =
  /passw|passcode|one.?time|verification|security.?code|card.?num|credit.?card|(^|[^a-z])(otp|2fa|mfa|pwd|cvv|cvc|ssn)([^a-z]|$)|비밀번호|암호|인증번호|인증 ?코드|보안 ?코드|카드 ?번호|주민/i;

/** A field that holds something secret. She does not type into these: the owner does. */
function isCredentialField(info) {
  if (!info) return false;
  if ((info.type || "") === "password") return true;
  if (/password|one-time-code|cc-/i.test(info.autocomplete || "")) return true;
  return CREDENTIAL_WORDS.test([info.name, info.id, info.text, info.placeholder].filter(Boolean).join(" "));
}

const RISKY_EN =
  /\b(submit|send|pay|purchase|buy|order|checkout|confirm|delete|remove|cancel|unsubscribe|sign ?out|log ?out|post|publish|apply|register|sign ?up|enroll|transfer|withdraw|save|update|change|reset|donate|subscribe|accept|agree)\b/i;
const RISKY_KO = /(제출|전송|보내기|발송|결제|구매|주문|확인|삭제|제거|취소|구독|로그아웃|게시|등록|지원|신청|가입|이체|송금|저장|변경|수정|초기화|동의|수락|완료)/;
const RISKY_HREF = /(log-?out|sign-?out|signout|delete|remove|unsubscribe|checkout|payment|purchase|\/order|confirm)/i;

/** Why clicking this could change something that cannot be taken back, or "" when it looks harmless. */
function riskReason(info) {
  if (!info) return "";
  const tag = info.tag || "";
  const type = (info.type || "").toLowerCase();
  const label = info.text || "";
  if (tag === "input" && ["submit", "image", "reset"].includes(type)) return "양식을 제출하는 버튼";
  if (tag === "button" && info.inForm && type !== "button") return "양식을 제출할 수 있는 버튼";
  if (RISKY_EN.test(label) || RISKY_KO.test(label)) return `"${label.slice(0, 40)}" — 되돌리기 어려운 동작으로 보여`;
  if (tag === "a" && info.href && RISKY_HREF.test(info.href)) return "되돌리기 어려운 동작으로 가는 링크";
  return "";
}

const LOGINISH = /(^|[\/.\-_])(log-?in|sign-?in|sso|auth|oauth2?|saml|cas|authorize|adfs)([\/.\-_?]|$)/i;

/** Whether an address looks like a sign-in page. */
function looksLikeLogin(urlString) {
  try {
    const u = new URL(urlString);
    return LOGINISH.test(u.hostname + u.pathname);
  } catch {
    return false;
  }
}

/* ---------- reading a page: run inside it ---------- */

// Numbers every visible thing that can be clicked or typed into, so she can say "12" instead of describing it.
// The numbers belong to this reading and stop meaning anything at the next one.
const SNAPSHOT_JS = `(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0.05;
  };
  window.__shiro = { els: [] };
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[onclick]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= ${MAX_ELEMENTS}) break;
    if (!vis(el) || el.closest("[aria-hidden=true]")) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") continue;
    const text = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || "")
      .replace(/\\s+/g, " ").trim().slice(0, 80);
    const ref = window.__shiro.els.push(el);
    const secret = type === "password";
    out.push({
      ref, tag, type: type || undefined, role: el.getAttribute("role") || undefined, text,
      href: tag === "a" ? el.href : undefined,
      name: el.getAttribute("name") || undefined, id: el.id || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      autocomplete: el.getAttribute("autocomplete") || undefined,
      disabled: el.disabled || undefined,
      inForm: !!el.closest("form"),
      value: (tag === "input" || tag === "textarea") && !secret && type !== "hidden" ? String(el.value || "").slice(0, 60) : undefined,
      checked: type === "checkbox" || type === "radio" ? !!el.checked : undefined,
    });
  }
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, ${TEXT_LIMIT});
  const hasPassword = [...document.querySelectorAll("input[type=password]")].some(vis);
  return {
    url: location.href, title: document.title, text, elements: out, hasPassword,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight },
  };
})()`;

const elementJs = (ref) => `(() => {
  const el = window.__shiro && window.__shiro.els[${Number(ref) - 1}];
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  return {
    x: r.x + r.width / 2, y: r.y + r.height / 2, tag, type,
    text: (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 80),
    href: tag === "a" ? el.href : undefined,
    name: el.getAttribute("name") || undefined, id: el.id || undefined,
    placeholder: el.getAttribute("placeholder") || undefined,
    autocomplete: el.getAttribute("autocomplete") || undefined,
    inForm: !!el.closest("form"), disabled: !!el.disabled,
    editable: tag === "input" || tag === "textarea" || el.isContentEditable,
  };
})()`;

const FOCUSED_JS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "");
  const form = el.closest("form");
  const searchy = type === "search" || (form && form.getAttribute("role") === "search") || el.closest("[role=search]") !== null ||
    /^(q|query|search|keyword|s)$/i.test(el.getAttribute("name") || "") || /search|검색/i.test(label);
  return { tag, type, text: (el.innerText || el.value || label || "").replace(/\\s+/g, " ").trim().slice(0, 80),
    inForm: !!form, searchy: !!searchy, href: tag === "a" ? el.href : undefined };
})()`;

/* ---------- the browser ---------- */

const KEYS = { Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", ArrowDown: "Down", ArrowUp: "Up", ArrowLeft: "Left", ArrowRight: "Right", PageDown: "PageDown", PageUp: "PageUp" };

function createBrowser({ getConfig, log = () => {} }) {
  let win = null;
  let loginMode = false;
  let gated = null; // { op, info, reason, at, url }
  let blocked = [];
  let chain = Promise.resolve();

  const cfg = () => getConfig() || {};
  const sites = () => normalizeSites(cfg().browserSites);
  const enabled = () => cfg().allowBrowser === true && sites().length > 0;
  const wc = () => win.webContents;

  /** May the page navigate here right now? While the owner is signing in they go wherever the sign-in does. */
  const navAllowed = (url) => (loginMode ? isHttp(url) : urlAllowed(url, sites()));

  function noteBlocked(url) {
    blocked.push({ url: String(url).slice(0, 300), login: looksLikeLogin(url) });
    log(`[browser] blocked navigation to ${String(url).slice(0, 120)}`);
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    const created = new BrowserWindow({
      show: false,
      width: WIDTH,
      height: HEIGHT,
      title: "시로 브라우저",
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win = created;
    const ses = win.webContents.session;
    // Nothing a page asks for is granted: camera, microphone, location, notifications. Nothing is downloaded.
    ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (e) => e.preventDefault());
    const ua = win.webContents.getUserAgent().replace(/\s?Electron\/\S+/, "").replace(/\s?shiro\S*\/\S+/i, "");
    win.webContents.setUserAgent(ua);

    const guard = (e, url) => {
      const target = typeof url === "string" ? url : e.url;
      if (!navAllowed(target)) {
        e.preventDefault();
        noteBlocked(target);
      }
    };
    win.webContents.on("will-navigate", guard);
    win.webContents.on("will-redirect", guard);
    // A page that opens a new window stays in this one, and only if it may go there.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (navAllowed(url)) setImmediate(() => win && !win.isDestroyed() && win.webContents.loadURL(url).catch(() => {}));
      else noteBlocked(url);
      return { action: "deny" };
    });
    created.on("closed", () => {
      // Closing the window is how the owner says they are done signing in.
      ses.flushStorageData();
      if (win !== created) return; // a newer window already took its place
      loginMode = false;
      gated = null;
      win = null;
    });
    if (cfg().browserShow === true) win.showInactive();
    return win;
  }

  /** Wait until a navigation this action started has finished, or nothing started. */
  function settle(expectNavigation) {
    return new Promise((resolve) => {
      const w = wc();
      let started = expectNavigation;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(quiet);
        clearTimeout(cap);
        w.removeListener("did-start-navigation", onStart);
        w.removeListener("did-stop-loading", onStop);
        setTimeout(resolve, 350);
      };
      // Electron passes the details as an object now, and the old positional arguments after it.
      const onStart = (e, _url, inPlace, isMain) => {
        const main = e && typeof e.isMainFrame === "boolean" ? e.isMainFrame : isMain;
        const same = e && typeof e.isSameDocument === "boolean" ? e.isSameDocument : inPlace;
        if (main && !same) started = true;
      };
      const onStop = () => {
        if (started) finish();
      };
      w.on("did-start-navigation", onStart);
      w.on("did-stop-loading", onStop);
      const quiet = setTimeout(() => {
        if (!started && !w.isLoading()) finish();
      }, SETTLE_MS);
      const cap = setTimeout(finish, LOAD_TIMEOUT_MS);
    });
  }

  async function snapshot(extra = {}) {
    const page = await wc().executeJavaScript(SNAPSHOT_JS, true);
    const wasBlocked = blocked;
    blocked = [];
    const loginRequired = page.hasPassword || looksLikeLogin(page.url) || wasBlocked.some((b) => b.login);
    return { ok: true, ...page, ...(wasBlocked.length ? { blocked: wasBlocked } : {}), ...(loginRequired ? { loginRequired: true } : {}), ...extra };
  }

  async function screenshot() {
    const img = await wc().capturePage();
    const { width } = img.getSize();
    const small = width > SHOT_WIDTH ? img.resize({ width: SHOT_WIDTH }) : img;
    return { mime: "image/jpeg", data: small.toJPEG(75).toString("base64") };
  }

  async function elementInfo(ref) {
    const info = await wc().executeJavaScript(elementJs(ref), true);
    if (!info) throw new Error("그 번호의 요소가 없어. snapshot 으로 다시 읽고 번호를 확인해");
    return info;
  }

  function gate(op, info, reason) {
    gated = { op, info, reason, at: Date.now(), url: wc().getURL() };
    return screenshot().then((shot) => ({
      ok: true,
      gated: true,
      reason,
      label: info.text || info.tag,
      url: gated.url,
      screenshot: shot,
    }));
  }

  async function doClick(op, approved) {
    const info = await elementInfo(op.ref);
    if (info.disabled) throw new Error("그 요소는 눌 수 없는 상태야");
    const reason = riskReason(info);
    if (reason && !approved) return gate(op, info, reason);
    const w = wc();
    const nav = settle(false);
    w.sendInputEvent({ type: "mouseMove", x: info.x, y: info.y });
    w.sendInputEvent({ type: "mouseDown", x: info.x, y: info.y, button: "left", clickCount: 1 });
    w.sendInputEvent({ type: "mouseUp", x: info.x, y: info.y, button: "left", clickCount: 1 });
    await nav;
    return snapshot({ clicked: info.text || info.tag, ...(approved ? { approved: true } : {}) });
  }

  async function doType(op) {
    const info = await elementInfo(op.ref);
    if (!info.editable) throw new Error("그 요소에는 글자를 넣을 수 없어");
    if (isCredentialField(info)) {
      throw new Error("비밀번호·인증번호·카드번호 같은 칸에는 내가 입력하지 않아. 주인님이 직접 해야 해");
    }
    const w = wc();
    await w.executeJavaScript(`(() => { const el = window.__shiro.els[${Number(op.ref) - 1}]; el.focus(); if (${op.append ? "false" : "true"} && el.select) el.select(); })()`, true);
    await w.insertText(String(op.text ?? "").slice(0, 2000));
    return snapshot({ typed: true });
  }

  async function doPress(op, approved) {
    const key = KEYS[op.key];
    if (!key) throw new Error(`쓸 수 없는 키야: ${op.key} (${Object.keys(KEYS).join(", ")})`);
    if (op.key === "Enter" && !approved) {
      const focused = await wc().executeJavaScript(FOCUSED_JS, true);
      if (focused) {
        // Enter on a button or link is a click. Enter in a field submits its form, unless that is a search box
        // (a text area just starts a new line).
        const submitsForm = focused.inForm && !focused.searchy && ["input", "select"].includes(focused.tag);
        const reason = riskReason(focused) || (submitsForm ? "양식을 제출할 수 있는 입력칸에서 Enter" : "");
        if (reason) return gate(op, focused, reason);
      }
    }
    const w = wc();
    const nav = settle(false);
    w.sendInputEvent({ type: "keyDown", keyCode: key });
    if (key === "Enter") w.sendInputEvent({ type: "char", keyCode: "\r" });
    w.sendInputEvent({ type: "keyUp", keyCode: key });
    await nav;
    return snapshot({ pressed: op.key, ...(approved ? { approved: true } : {}) });
  }

  async function perform(op, approved = false) {
    if (op.action !== "open" && !(win && !win.isDestroyed())) {
      throw new Error("열려 있는 페이지가 없어. 먼저 open 으로 열어");
    }
    switch (op.action) {
      case "open": {
        if (!urlAllowed(op.url, sites())) {
          throw new Error(`허용된 사이트가 아니야: ${String(op.url).slice(0, 120)} (허용: ${sites().join(", ")})`);
        }
        ensureWindow();
        blocked = [];
        const w = wc();
        const nav = settle(true);
        await Promise.race([
          w.loadURL(op.url).catch((err) => {
            // A redirect she was not allowed to follow aborts the load; that is reported below, not an error.
            if (!/ERR_ABORTED|-3\b/.test(String(err.message))) throw err;
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("페이지가 시간 안에 열리지 않았어")), LOAD_TIMEOUT_MS)),
        ]);
        await nav;
        return snapshot();
      }
      case "snapshot":
        ensureWindow();
        return snapshot();
      case "click":
        return doClick(op, approved);
      case "type":
        return doType(op);
      case "press":
        return doPress(op, approved);
      case "scroll": {
        const dy = Math.max(-5000, Math.min(5000, Number(op.amount) || 600));
        await wc().executeJavaScript(`window.scrollBy(0, ${dy})`, true);
        return snapshot();
      }
      case "back": {
        const w = wc();
        const history = w.navigationHistory;
        if (history ? !history.canGoBack() : !w.canGoBack()) throw new Error("더 뒤로 갈 곳이 없어");
        const nav = settle(true);
        if (history) history.goBack();
        else w.goBack();
        await nav;
        return snapshot();
      }
      case "screenshot":
        ensureWindow();
        return { ok: true, url: wc().getURL(), title: wc().getTitle(), screenshot: await screenshot() };
      default:
        throw new Error(`모르는 동작이야: ${op.action}`);
    }
  }

  async function exec(op) {
    if (!op || typeof op !== "object") return { ok: false, error: "요청이 이상해" };
    if (!enabled()) {
      return { ok: false, error: "브라우저가 꺼져 있어 (아바타 config.json 의 allowBrowser 와 browserSites)" };
    }
    const action = op.action;

    if (action === "status") {
      return { ok: true, loginMode, sites: sites(), open: !!(win && !win.isDestroyed()), url: win && !win.isDestroyed() ? win.webContents.getURL() : null, waiting: gated ? { label: gated.info.text, reason: gated.reason } : null };
    }
    if (action === "login") {
      ensureWindow();
      loginMode = true;
      gated = null;
      if (op.url && isHttp(op.url)) await wc().loadURL(op.url).catch(() => {});
      win.show();
      win.focus();
      return { ok: true, loginMode: true, message: "로그인 창을 띄웠어. 주인님이 직접 로그인하고 창을 닫으면 돼." };
    }
    if (action === "login_done") {
      loginMode = false;
      if (win && !win.isDestroyed()) {
        win.webContents.session.flushStorageData();
        // The window is thrown away rather than hidden: a page loaded into a window that has been shown and then
        // hidden stops receiving clicks. A fresh one opens on the next request; the sign-in is kept in the profile.
        if (cfg().browserShow !== true) win.destroy();
      }
      return { ok: true, loginMode: false, message: "로그인 창을 닫았어. 페이지는 open 으로 다시 열어줘." };
    }
    if (loginMode) {
      return { ok: false, loginMode: true, error: "주인님이 지금 로그인하는 중이야. 끝나면 알려달라고 해" };
    }
    if (action === "cancel") {
      const had = !!gated;
      gated = null;
      return { ok: true, cancelled: had };
    }
    if (action === "approve") {
      if (!gated || Date.now() - gated.at > GATE_TTL_MS) {
        gated = null;
        return { ok: false, error: "승인할 행동이 없거나 10분이 지났어" };
      }
      ensureWindow();
      if (wc().getURL() !== gated.url) {
        gated = null;
        return { ok: false, error: "그 사이 화면이 바뀌었어. 다시 확인하고 요청해줘" };
      }
      const pending = gated.op;
      gated = null;
      return pending.action === "press" ? doPress(pending, true) : doClick(pending, true);
    }
    // Doing anything else drops a pending approval: what the owner approves is exactly what was shown.
    if (action !== "screenshot") gated = null;
    return perform(op);
  }

  /** One action at a time, so two requests never interleave on the same page. */
  function run(op) {
    const next = chain.then(() => exec(op)).catch((err) => ({ ok: false, error: `브라우저 오류: ${err && err.message ? err.message : err}` }));
    chain = next.catch(() => {});
    return next;
  }

  function toggleLogin() {
    return run({ action: loginMode ? "login_done" : "login" });
  }

  return { run, toggleLogin, isLoginMode: () => loginMode };
}

module.exports = { createBrowser, normalizeSites, urlAllowed, isCredentialField, riskReason, looksLikeLogin };
