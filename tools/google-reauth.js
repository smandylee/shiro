// Getting Google access back, in one command.
//
//   node tools/google-reauth.js
//
// The token lives on the server, but signing in needs a browser, and Google
// sends the browser back to http://localhost:51894 when it is done. So this
// opens a tunnel from this PC's port 51894 to the server's, runs the server's
// authorize script through it, and opens the sign-in page here.
//
// Nothing is entered on the owner's behalf. The sign-in and the consent are
// theirs; this only removes the plumbing. When the new token is written the
// running service picks it up on its next check, so no restart is needed.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "avatar", "config.json");
const PORT = 51894;
const WAIT_SECONDS = 900;
const DEFAULT_REMOTE_DIR = "/home/ubuntu/orchestrator";
const LOGIN_URL = /https:\/\/accounts\.google\.com\/[^\s]+/;

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function loadConfig() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    fail(`avatar/config.json 을 읽지 못했어: ${err.message}`);
  }
  for (const key of ["deployHost", "deployKeyPath"]) {
    if (!config[key]) fail(`avatar/config.json 에 ${key} 가 없어. (배포 설정과 같은 값을 쓴다)`);
  }
  return {
    host: config.deployHost,
    key: config.deployKeyPath,
    remoteDir: config.deployRemoteDir || DEFAULT_REMOTE_DIR,
  };
}

/** The sign-in page has to be able to reach us on this port. */
function portIsFree() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(PORT, "127.0.0.1");
  });
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]] // no shell: the & in the URL stays a &
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the URL is printed too; opening it by hand works */
  }
}

async function main() {
  const { host, key, remoteDir } = loadConfig();

  if (!(await portIsFree())) {
    fail(`이 PC 의 ${PORT} 번 포트를 이미 쓰고 있어. 이전에 열어둔 재인증이 남았는지 확인해줘.`);
  }

  console.log("서버에 로그인 대기를 여는 중…");
  const child = spawn(
    "ssh",
    [
      // A terminal on the far end, so that closing this connection also ends the
      // authorize script there instead of leaving it holding the port.
      "-tt",
      "-i", key,
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-L", `${PORT}:localhost:${PORT}`,
      host,
      `cd ${remoteDir} && timeout ${WAIT_SECONDS} npm run google:authorize`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );

  let output = "";
  let opened = false;
  const giveUp = setTimeout(() => {
    child.kill();
    fail("15분 안에 로그인이 끝나지 않았어. 다시 실행해줘.");
  }, WAIT_SECONDS * 1000);

  const onData = (chunk) => {
    output += chunk.toString();

    if (!opened) {
      const match = output.match(LOGIN_URL);
      if (match) {
        opened = true;
        console.log("\n브라우저에서 구글 로그인 창이 열려. 열리지 않으면 아래 주소를 직접 열어줘:\n");
        console.log(match[0]);
        console.log("\n'확인되지 않은 앱' 경고가 뜨면 [고급] → [이동] 을 눌러. 권한 세 가지를 모두 허용하면 끝나.\n");
        openBrowser(match[0]);
      }
    }

    if (output.includes("토큰 저장 완료")) {
      clearTimeout(giveUp);
      console.log("완료! 새 토큰이 저장됐어. 재시작은 필요 없고, 시로가 다음 확인 때 알아서 새 토큰을 읽어.");
      child.kill();
      process.exit(0);
    }
    if (output.includes("토큰 교환 실패")) {
      clearTimeout(giveUp);
      child.kill();
      fail("구글이 코드를 받아주지 않았어. 다시 실행해서 처음부터 해줘.");
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("error", (err) => fail(`ssh 를 실행하지 못했어: ${err.message}`));
  child.on("close", (code) => {
    clearTimeout(giveUp);
    if (!output.includes("토큰 저장 완료")) {
      fail(`서버 연결이 끝났어 (종료 코드 ${code}). 로그인이 끝나기 전에 끊긴 것 같아. 다시 실행해줘.`);
    }
  });
}

main();
