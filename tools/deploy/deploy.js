const { execFileSync } = require("node:child_process");
const path = require("node:path");

// Putting a finished dev-task branch on the server.
//
// This is the one path from Shiro's requests to the running bot, and it is
// deliberately a fixed script rather than a shell. Nothing here takes a command
// from anyone: the only thing the caller chooses is WHICH branch, and even that
// has to have come from a dev task the owner approved. The agent that wrote the
// code never runs this — it has no ssh at all. The worker does, with these steps
// and no others.
//
// Every refusal below is a case where a human should look first, not a case
// worth working around.

const REPO_DIR = path.join(__dirname, "..", "..");
const ORCHESTRATOR_DIR = path.join(REPO_DIR, "orchestrator");
const DEFAULT_REMOTE_DIR = "/home/ubuntu/orchestrator";
const DEFAULT_SERVICE = "shiro-orchestrator";
// The bot takes a few seconds to log in to Discord; below that we'd call a
// healthy deploy broken.
const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_POLL_MS = 3000;

/** Changes that need something this script cannot do (installing packages). */
const NEEDS_HANDS = ["orchestrator/package.json", "orchestrator/package-lock.json"];

class Refused extends Error {}

function run(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
}

function git(args, opts = {}) {
  return run("git", args, { cwd: REPO_DIR, ...opts });
}

function gitLines(args, opts = {}) {
  try {
    return git(args, opts).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function sshArgs(config) {
  return [
    "-i",
    config.deployKeyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
}

function ssh(config, command) {
  return run("ssh", [...sshArgs(config), config.deployHost, command]);
}

/** The worktree a branch is checked out in, if any — its uncommitted work would be left behind. */
function worktreeFor(branch) {
  const lines = gitLines(["worktree", "list", "--porcelain"]);
  let dir = null;
  for (const line of lines) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length).trim();
    else if (line === `branch refs/heads/${branch}`) return dir;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refuses unless everything about this deploy is ordinary: a clean checkout on
 * main, a branch that actually changed server code, and nothing left behind.
 */
function preflight(branch, config) {
  if (config.allowDeploy !== true) {
    throw new Refused("배포가 꺼져 있어 (아바타 config.json 의 allowDeploy).");
  }
  for (const key of ["deployHost", "deployKeyPath"]) {
    if (!config[key]) throw new Refused(`배포 설정이 없어 (config.json 의 ${key}).`);
  }
  if (!/^[\w.\-/]+$/.test(branch)) throw new Refused(`브랜치 이름이 이상해: ${branch}`);

  const head = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (head !== "main") throw new Refused(`지금 main 이 아니라 ${head} 에 있어서 합칠 수 없어.`);

  const dirty = gitLines(["status", "--porcelain"]);
  if (dirty.length) {
    throw new Refused(`아직 커밋 안 된 변경이 ${dirty.length}개 있어서 안 합쳤어. 정리하고 다시 시켜줘.`);
  }

  const worktree = worktreeFor(branch);
  if (worktree) {
    const left = gitLines(["-C", worktree, "status", "--porcelain"]);
    if (left.length) {
      throw new Refused(
        `그 브랜치 작업 폴더에 커밋 안 된 변경이 ${left.length}개 남아 있어. 커밋 안 된 건 배포해도 반영이 안 돼.`
      );
    }
  }

  const changed = gitLines(["diff", "--name-only", `HEAD...${branch}`]);
  if (!changed.length) throw new Refused("그 브랜치에 main 과 다른 내용이 없어. 배포할 게 없어.");

  const needsHands = changed.filter((f) => NEEDS_HANDS.includes(f));
  if (needsHands.length) {
    throw new Refused(
      `${needsHands.join(", ")} 이 바뀌었어. 서버에서 패키지를 새로 깔아야 하는 거라 내가 못 해 — 주인님이 직접 해줘.`
    );
  }

  const server = changed.filter((f) => f.startsWith("orchestrator/"));
  const strays = server.filter((f) => !f.startsWith("orchestrator/src/"));
  if (strays.length) {
    throw new Refused(`${strays.join(", ")} 는 내가 올리는 범위(orchestrator/src) 밖이야. 주인님이 직접 올려줘.`);
  }
  if (!server.length) {
    throw new Refused("서버 코드는 안 바뀌었어 (PC 쪽만 바뀜). 합치기만 하면 되니 배포는 필요 없어.");
  }
  return { changed, server, worktree };
}

/**
 * Merges, checks, uploads, restarts, and puts everything back the way it was if
 * the bot doesn't come up. Never throws: a failed deploy still has to be an answer.
 */
async function deploy({ branch, config, log }) {
  let prevCommit = null;
  let merged = false;
  let uploaded = false;
  const remoteDir = config.deployRemoteDir || DEFAULT_REMOTE_DIR;
  const service = config.deployService || DEFAULT_SERVICE;

  const rollback = (why) => {
    const notes = [];
    if (uploaded) {
      try {
        ssh(
          config,
          `cd ${remoteDir} && rm -rf src.failed && mv src src.failed && mv src.bak src && sudo systemctl restart ${service}`
        );
        notes.push("서버는 이전 코드로 되돌리고 재시작했어.");
      } catch (err) {
        notes.push(`⚠️ 서버 되돌리기도 실패했어: ${String(err.message).slice(0, 200)} — 직접 봐줘.`);
      }
    }
    if (merged && prevCommit) {
      try {
        git(["reset", "--hard", prevCommit]);
        notes.push("main 도 합치기 전으로 되돌렸어.");
      } catch (err) {
        notes.push(`⚠️ main 되돌리기 실패: ${String(err.message).slice(0, 200)}`);
      }
    }
    return [why, ...notes].join("\n");
  };

  try {
    const { changed, server } = preflight(branch, config);
    prevCommit = git(["rev-parse", "HEAD"]).trim();

    try {
      git(["merge", "--no-ff", "--no-edit", branch]);
      merged = true;
    } catch (err) {
      try {
        git(["merge", "--abort"]);
      } catch {
        /* nothing to abort */
      }
      return {
        ok: false,
        summary: `합치다가 충돌났어. 아무것도 안 바꿨어.\n${String(err.message).slice(0, 400)}`,
      };
    }

    try {
      run("npx", ["tsc", "--noEmit"], { cwd: ORCHESTRATOR_DIR, shell: true, timeout: 180_000 });
    } catch (err) {
      const output = `${err.stdout || ""}${err.stderr || ""}`.trim().split(/\r?\n/).slice(0, 10).join("\n");
      return { ok: false, summary: rollback(`합치고 나니 타입 체크가 깨져서 배포 안 했어:\n${output}`) };
    }

    log(`[deploy] uploading ${server.length} changed server file(s)`);
    // Whole tree into a staging folder, then swap — so files deleted on the
    // branch actually disappear on the server instead of lingering.
    ssh(config, `rm -rf ${remoteDir}/src.new`);
    run("scp", [
      ...sshArgs(config),
      "-r",
      path.join(ORCHESTRATOR_DIR, "src"),
      `${config.deployHost}:${remoteDir}/src.new`,
    ]);
    ssh(config, `cd ${remoteDir} && rm -rf src.bak && mv src src.bak && mv src.new src`);
    uploaded = true;

    const since = ssh(config, "date +%s").trim();
    ssh(config, `sudo systemctl restart ${service}`);

    // Up means Discord actually accepted it, not just that systemd started a process.
    let healthy = false;
    let lastState = "";
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(HEALTH_POLL_MS);
      try {
        lastState = ssh(config, `systemctl is-active ${service} || true`).trim();
        if (lastState !== "active") continue;
        const hits = ssh(
          config,
          `sudo journalctl -u ${service} --since "@${since}" --no-pager | grep -c "logged in as" || true`
        ).trim();
        if (Number(hits) > 0) {
          healthy = true;
          break;
        }
      } catch {
        /* the box may be busy restarting; keep polling until the deadline */
      }
    }

    if (!healthy) {
      let tail = "";
      try {
        tail = ssh(config, `sudo journalctl -u ${service} --since "@${since}" --no-pager | tail -n 12`).trim();
      } catch {
        /* the log is a nicety, not worth failing the rollback over */
      }
      return {
        ok: false,
        summary: rollback(
          `올리고 재시작했는데 시로가 안 올라와 (상태: ${lastState || "확인 불가"}).\n${tail.slice(0, 600)}`
        ),
      };
    }

    log(`[deploy] ${branch} is live`);
    const pcOnly = changed.filter((f) => !f.startsWith("orchestrator/"));
    const lines = [
      `배포했어! ${branch} 를 main 에 합치고 서버에 올렸어.`,
      `서버 파일 ${server.length}개 반영됨.`,
    ];
    if (pcOnly.length) {
      lines.push(
        `PC 쪽 파일도 ${pcOnly.length}개 바뀌었는데(${pcOnly.slice(0, 5).join(", ")}) 그건 아바타를 다시 켜야 적용돼.`
      );
    }
    lines.push("서버에 이전 코드가 src.bak 으로 남아 있어서 되돌릴 수 있어.");
    return { ok: true, summary: lines.join("\n") };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, summary: `배포 안 했어 — ${err.message}` };
    return { ok: false, summary: rollback(`배포하다가 오류났어: ${String(err.message).slice(0, 400)}`) };
  }
}

module.exports = { deploy };
