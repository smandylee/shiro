// Record the real avatar renderer as a GIF, without Electron.
//
// The renderer only needs one thing from Electron: the `window.shiro` object its
// preload script provides. This serves the avatar folder from a tiny local server
// that adds a do-nothing stand-in for it, opens the page in headless Chrome, clicks
// through the emotions of the control panel, screenshots the canvas, and lets
// ffmpeg turn the frames into a GIF. So what you see is the real thing: the layered
// rig, the tail, the mesh-engine face and its idle motion.
//
//   cd avatar
//   npm install --no-save puppeteer-core     # once; not a dependency of the app
//   node tools/record-demo.mjs [out.gif]     # default: ../docs/images/shiro-demo.gif
//
// Needs Chrome (set CHROME_PATH if it is not in the usual place) and ffmpeg on PATH.
// It runs on the GPU if there is one; with software rendering it is very slow.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "..", "docs", "images", "shiro-demo.gif"));

// [emotion, seconds to hold it]. "embarrassed" is left out to keep the file small.
const PLAN = [["neutral", 1.6], ["happy", 2.2], ["surprised", 1.8], ["sad", 2.2], ["angry", 1.8], ["love", 2.2], ["neutral", 1.4]];
const GIF = { fps: 10, width: 340, colors: 180 };

let puppeteer;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch {
  console.error("puppeteer-core is not installed. Run:  npm install --no-save puppeteer-core");
  process.exit(1);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH to its executable.");
  return found;
}

// What Electron's preload would give the page. Everything does nothing, and the
// bridge URL points nowhere: the renderer retries quietly.
const STUB = `<script>
window.shiro = {
  getConfig: async () => ({ scale: 0.5, showBubble: false, mesh: true, bridgeUrl: "ws://127.0.0.1:9", bridgeToken: "demo" }),
  captureScreen: async () => null, onMic() {}, onWatch() {}, onWatchFrame() {}, onJobResults() {}, jobResultsAck() {},
  setWatching() {}, onInteractive() {}, setInteractive() {}, setMouseCapture() {}, resizeWindow() {}, dragStart() {}, dragEnd() {}, quit() {},
};
</script>`;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const file = normalize(join(ROOT, path === "/renderer/" ? "/renderer/index.html" : path));
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  let body = readFileSync(file);
  if (file.endsWith(join("renderer", "index.html"))) {
    body = Buffer.from(body.toString("utf8").replace('<script type="module"', `${STUB}<script type="module"`));
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/renderer/index.html`;

const work = mkdtempSync(join(tmpdir(), "shiro-demo-"));
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});
const frames = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "load" });
  await page.bringToFront();
  await page.addStyleTag({
    content:
      "html,body{background:#f6f3f0 !important}" +
      "#cap{position:fixed;left:14px;top:14px;padding:7px 12px;border-radius:10px;background:rgba(60,50,60,.85);" +
      "color:#fff;font:600 17px ui-monospace,Menlo,Consolas,monospace;z-index:9}",
  });
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "cap";
    document.body.appendChild(d);
  });

  // The mesh engine takes a few seconds to start; the canvas is sized once it is drawing.
  let box = null;
  for (let i = 0; i < 80 && !box; i++) {
    box = await page.evaluate(() => {
      const c = document.getElementById("shiro");
      const r = c.getBoundingClientRect();
      return c.width > 400 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    });
    if (!box) await new Promise((r) => setTimeout(r, 250));
  }
  if (!box) throw new Error("The renderer never drew. Is the avatar folder complete (layers/)?");
  await new Promise((r) => setTimeout(r, 1500));
  // The caption lives inside the shot, so move it to the canvas's own corner.
  await page.evaluate((b) => Object.assign(document.getElementById("cap").style, { left: `${b.x + 14}px`, top: `${b.y + 14}px` }), box);

  const t0 = Date.now();
  let n = 0;
  for (const [emotion, hold] of PLAN) {
    await page.evaluate((e) => {
      [...document.querySelectorAll("#emotions button")].find((b) => b.textContent.trim() === e)?.click();
      document.getElementById("cap").textContent = `[emotion:${e}]`;
    }, emotion);
    const until = Date.now() + hold * 1000;
    while (Date.now() < until) {
      const file = join(work, `${String(n).padStart(4, "0")}.jpg`);
      await page.screenshot({ path: file, type: "jpeg", quality: 90, clip: box });
      frames.push({ file, at: Date.now() - t0 });
      n++;
    }
  }
  console.log(`captured ${n} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally {
  await browser.close();
  server.close();
}

// Real timing: each frame lasts until the next was taken, so a slow capture does not play fast.
const list = frames
  .map((f, i) => `file '${f.file.replace(/\\/g, "/")}'\nduration ${(((frames[i + 1]?.at ?? f.at + 80) - f.at) / 1000).toFixed(4)}`)
  .concat(`file '${frames[frames.length - 1].file.replace(/\\/g, "/")}'`)
  .join("\n");
writeFileSync(join(work, "list.txt"), list);
mkdirSync(dirname(OUT), { recursive: true });
const filter =
  `fps=${GIF.fps},scale=${GIF.width}:-1:flags=lanczos,split[a][b];` +
  `[a]palettegen=max_colors=${GIF.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"), "-vf", filter, "-loop", "0", OUT], { stdio: "inherit" });
console.log(`wrote ${OUT} (${Math.round(readFileSync(OUT).length / 1024)} KB)`);
