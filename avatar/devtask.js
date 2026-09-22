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
];

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
 * A fresh worktree has no dependencies, so `tsc` cannot run inside it. Junctions
 * (cheap on Windows, no copying) point at the real ones so the work can be
 * checked. Done after the run, not before, so the run never gets a path out.
 */
function typecheckWorktree(name, log) {
  const worktreeDir = path.join(REPO_DIR, ".claude", "worktrees", name);
  const orchestrator = path.join(worktreeDir, "orchestrator");
  if (!fs.existsSync(orchestrator)) return null;

  const link = path.join(orchestrator, "node_modules");
  if (!fs.existsSync(link)) {
    try {
      fs.symlinkSync(path.join(REPO_DIR, "orchestrator", "node_modules"), link, "junction");
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
      "--- 위 요청은 시로(비서 AI)가 보낸 것이고, 시로는 코드를 읽지 못해. 아래를 지켜줘 ---\n" +
      "1. 먼저 이 요청이 할 만한 일인지 판단해. 이미 되어 있거나, 효과가 없거나, 오히려 나쁘거나, " +
      "무엇을 원하는지 알 수 없을 만큼 막연하면 **아무것도 바꾸지 말고** 왜 안 했는지 설명만 해줘. " +
      "억지로 그럴듯한 변경을 만들어내지 마.\n" +
      "2. 할 만한 일이면 필요한 만큼만 바꿔. 요청에 없는 것까지 손대지 마.\n" +
      "3. 코드를 바꿨으면 타입 체크로 확인해 (orchestrator: npx tsc --noEmit, avatar: node --check).\n" +
      "4. 끝나면 바꾼 내용을 git 으로 커밋해 (push 는 하지 마).\n" +
      "5. 마지막에 한국어로 짧게 설명해. 안 한 경우에는 왜 안 했는지가 설명이야.";
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
        log(`[dev] #${id} finished, ${files.length} file(s), $${parsed.total_cost_usd ?? "?"}`);
        return done({
          ok: !check || check.ok,
          summary: `${(parsed.result || "(설명 없음)").slice(0, 1500)}${changed}${checkNote}`,
          branch,
          costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
          touchedGuardrails,
        });
      }

      const why = (parsed && parsed.result) || stderr.slice(-800) || stdout.slice(-800) || "(출력 없음)";
      log(`[dev] #${id} failed with exit ${code}`);
      done({
        ok: false,
        summary: `실패했어 (종료 코드 ${code}).\n${why}${changed}`,
        branch: files.length ? branch : null,
        costUsd: parsed && typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
        touchedGuardrails,
      });
    });
  });
}

module.exports = { runDevTask, GUARDRAIL_FILES };
