const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// Runs one approved development request through Claude Code, on the owner's PC.
// Shiro only supplies the wording of the request; everything about HOW it runs
// is fixed here, where she cannot reach it:
//   - a fresh git worktree, so the working checkout is never touched
//   - no network tools, no push, no ssh/scp — she cannot deploy anything
//   - a spend cap, and a wall-clock timeout
// The result is a branch for the owner to look at. Merging and deploying stay manual.

const REPO_DIR = path.join(__dirname, "..");
const DEFAULT_MODEL = "sonnet";
const DEFAULT_BUDGET_USD = 2;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// Changing any of these would change what Shiro is allowed to do, so a diff that
// touches them is reported loudly for the owner to look at before merging.
const GUARDRAIL_FILES = [
  "orchestrator/src/pc/commands.ts",
  "orchestrator/src/memory/devtasks.ts",
  "orchestrator/src/dev.ts",
  "orchestrator/src/openclaw/client.ts",
  "orchestrator/src/persona.ts",
  "avatar/devtask.js",
  "avatar/devworker.js",
  "tools/deploy/deploy.js",
];

// What the run decided to do. "I can't" is a real answer, and a different one
// from "not worth doing": the first needs the owner to pick the job up himself,
// the second needs nothing at all.
const VERDICTS = { 완료: "done", 반려: "declined", 넘김: "escalated" };

const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Bash(npx tsc *)",
  "Bash(node --check *)",
  "Bash(git diff *)",
  "Bash(git status *)",
  "Bash(git add *)",
  "Bash(git commit *)",
];

const DISALLOWED_TOOLS = [
  "WebFetch",
  "WebSearch",
  "Bash(git push *)",
  "Bash(ssh *)",
  "Bash(scp *)",
  "Bash(curl *)",
  "Bash(rm *)",
  "Bash(npm publish *)",
];

function gitLines(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_DIR, encoding: "utf8" })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The verdict line, and the explanation without it. What actually changed wins
 * over what the run says: a "완료" that touched no files did not build anything,
 * whatever it claims.
 */
function readVerdict(text, fileCount) {
  const body = (text || "").trim();
  const matches = [...body.matchAll(/^판정:\s*(완료|반려|넘김)\s*$/gm)];
  const last = matches[matches.length - 1];
  let verdict = last ? VERDICTS[last[1]] : fileCount ? "done" : "declined";
  if (verdict === "done" && !fileCount) verdict = "declined";
  return { verdict, summary: last ? body.replace(last[0], "").trim() : body };
}

/**
 * What the run changed, and whether any of it was a guardrail file. A run may
 * leave its work committed on the branch, uncommitted in the worktree, or both,
 * so both are counted — reporting only committed changes made real edits look
 * like "nothing happened".
 */
function inspectBranch(name, branch) {
  if (!branch) return { files: [], touchedGuardrails: [] };
  const worktreeDir = path.join(REPO_DIR, ".claude", "worktrees", name);
  // Three dots: what the branch added on top of where it started.
  const committed = gitLines(["diff", "--name-only", `HEAD...${branch}`]);
  // Anything still sitting in the worktree, staged or not, including new files.
  const working = gitLines(["-C", worktreeDir, "status", "--porcelain"]).map((line) =>
    // Lines arrive trimmed, so the status letters are 1-2 characters ("M", "??").
    line.replace(/^[^\s]{0,2}\s+/, "").replace(/^.* -> /, "").trim()
  );
  const files = [...new Set([...committed, ...working])].filter(Boolean);
  return { files, touchedGuardrails: files.filter((f) => GUARDRAIL_FILES.includes(f)) };
}

/**
 * A fresh worktree has no dependencies, so `tsc` cannot run inside it. A junction
 * (cheap on Windows, no copying) points at the real ones so the work can be
 * checked. Made after the run, not before, so the run never gets a path out —
 * and taken down as soon as the check is over, because anything that later
 * deletes the worktree (`git worktree remove -f`, a hand-cleanup) will walk
 * straight through a junction and empty the real node_modules behind it.
 */
function typecheckWorktree(name, log) {
  const worktreeDir = path.join(REPO_DIR, ".claude", "worktrees", name);
  const orchestrator = path.join(worktreeDir, "orchestrator");
  if (!fs.existsSync(orchestrator)) return null;

  const link = path.join(orchestrator, "node_modules");
  let linked = false;
  if (!fs.existsSync(link)) {
    try {
      fs.symlinkSync(path.join(REPO_DIR, "orchestrator", "node_modules"), link, "junction");
      linked = true;
    } catch (err) {
      log(`[dev] could not link node_modules for the check: ${err.message}`);
      return null;
    }
  }
  try {
    execFileSync("npx", ["tsc", "--noEmit"], { cwd: orchestrator, encoding: "utf8", shell: true, timeout: 180_000 });
    return { ok: true, output: "" };
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`.trim();
    return { ok: false, output: output.split(/\r?\n/).slice(0, 12).join("\n") };
  } finally {
    // rmdir, not rm -r: it unlinks the junction itself and never follows it.
    if (linked) {
      try {
        fs.rmdirSync(link);
      } catch (err) {
        log(`[dev] ⚠️ left a node_modules junction behind in ${name}: ${err.message}`);
      }
    }
  }
}

/**
 * Runs one request. Resolves with what to report back — it never throws, because
 * a failure here still has to reach the owner as an answer.
 */
function runDevTask({ id, task, config, log }) {
  return new Promise((resolve) => {
    if (config.allowDevTasks !== true) {
      return resolve({
        id,
        ok: false,
        summary: "개발 요청 실행이 꺼져 있어 (아바타 config.json 의 allowDevTasks).",
      });
    }

    const name = `shiro-dev-${id}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    // Claude Code names the branch after the worktree, with its own prefix.
    const branch = `worktree-${name}`;
    // The request comes from Shiro, who cannot read the code and does not know
    // what is already there. Judging whether it is worth doing is part of the
    // job — doing pointless work quietly is worse than saying no.
    const prompt =
      `${task}\n\n` +
      "--- 위 요청은 시로(비서 AI)가 보낸 것이고, 시로는 코드를 읽지 못해. 아래를 지켜줘 ---\n\n" +
      "네가 못 하는 건 이것뿐이야:\n" +
      "- 패키지 설치 (npm install 이 없어). package.json 에 새 의존성이 필요한 일.\n" +
      "- 인터넷 접근 (WebFetch/WebSearch/curl 없음).\n" +
      "- 서버 접근 (ssh/scp 없음). 서버에 프로그램을 깔아야 하는 일.\n" +
      "- 배포. 네 결과는 브랜치까지고, 서버에 올리는 건 주인님이 따로 시켜.\n" +
      "그 밖에는 이 저장소의 코드를 읽고 고치고 커밋하는 게 다 범위 안이야. " +
      "이미 있는 의존성만 쓴다면 기능 추가든 버그 수정이든 해도 돼.\n\n" +
      "1. 먼저 셋 중 하나를 정해:\n" +
      "   - 할 만하고 네가 할 수 있다 → 만든다\n" +
      "   - 이미 되어 있거나, 효과가 없거나, 오히려 나쁘거나, 무엇을 원하는지 알 수 없을 만큼 막연하다 → 반려\n" +
      "   - 할 만한데 위에 적은 '못 하는 것' 때문에 네가 못 한다 → 넘김 (주인님이 직접 하도록)\n" +
      "   할 수 있는 일을 크거나 복잡하다는 이유로 반려하지 마. 억지로 그럴듯한 변경을 만들어내지도 마.\n" +
      "2. 만들 때는 필요한 만큼만 바꿔. 요청에 없는 것까지 손대지 마.\n" +
      "3. 코드를 바꿨으면 타입 체크로 확인해 (orchestrator: npx tsc --noEmit, avatar: node --check).\n" +
      "4. 끝나면 바꾼 내용을 git 으로 커밋해 (push 는 하지 마).\n" +
      "5. 한국어로 짧게 설명하고, 맨 마지막 줄에 판정을 정확히 이 형식으로 적어:\n" +
      "   판정: 완료   /   판정: 반려   /   판정: 넘김\n" +
      "   넘김이면 무엇이 필요한지 한 줄로 같이 적어 (예: 'X 패키지 설치와 서버 설정이 필요함').";
    const args = [
      "-p",
      prompt,
      "--worktree",
      name,
      // Branch from what this checkout actually has. The default ("fresh") uses
      // the repository's default branch, which here resolves to origin/main —
      // and that is many commits behind, so tasks would edit stale code.
      "--settings",
      JSON.stringify({ worktree: { baseRef: "head" } }),
      "--model",
      config.devModel || DEFAULT_MODEL,
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--output-format",
      "json",
      "--max-budget-usd",
      String(config.devMaxBudgetUsd || DEFAULT_BUDGET_USD),
      "--allowedTools",
      ...ALLOWED_TOOLS,
      "--disallowedTools",
      ...DISALLOWED_TOOLS,
    ];

    log(`[dev] #${id} starting on ${branch}`);
    // No shell: the request text is one argument, so nothing in it can be read as a command.
    const child = spawn("claude", args, { cwd: REPO_DIR, shell: false, windowsHide: true });

    let stdout = "";
    let stderr = "";
    let finished = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      if (finished) return;
      log(`[dev] #${id} timed out, killing`);
      child.kill();
    }, config.devTimeoutMs || DEFAULT_TIMEOUT_MS);

    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ id, ...result });
    };

    child.on("error", (err) => {
      log(`[dev] #${id} could not start: ${err.message}`);
      done({ ok: false, summary: `Claude Code를 실행하지 못했어: ${err.message}` });
    });

    child.on("close", (code) => {
      const { files, touchedGuardrails } = inspectBranch(name, branch);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        /* not JSON — fall back to the raw text below */
      }

      const changed = files.length
        ? `\n\n바뀐 파일 ${files.length}개:\n${files.slice(0, 25).map((f) => `- ${f}`).join("\n")}`
        : "\n\n(바뀐 파일 없음)";

      // Only worth checking when something actually changed.
      const check = files.length ? typecheckWorktree(name, log) : null;
      const checkNote = !check
        ? ""
        : check.ok
          ? "\n\n타입 체크 통과."
          : `\n\n⚠️ 타입 체크 실패:\n${check.output}`;

      if (code === 0 && parsed) {
        const { verdict, summary } = readVerdict(parsed.result, files.length);
        log(`[dev] #${id} ${verdict}, ${files.length} file(s), $${parsed.total_cost_usd ?? "?"}`);
        return done({
          ok: !check || check.ok,
          verdict,
          summary: `${summary.slice(0, 1500) || "(설명 없음)"}${changed}${checkNote}`,
          branch,
          costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
          touchedGuardrails,
        });
      }

      const why = (parsed && parsed.result) || stderr.slice(-800) || stdout.slice(-800) || "(출력 없음)";
      log(`[dev] #${id} failed with exit ${code}`);
      done({
        ok: false,
        verdict: "failed",
        summary: `실패했어 (종료 코드 ${code}).\n${why}${changed}`,
        branch: files.length ? branch : null,
        costUsd: parsed && typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
        touchedGuardrails,
      });
    });
  });
}

module.exports = { runDevTask, GUARDRAIL_FILES };
