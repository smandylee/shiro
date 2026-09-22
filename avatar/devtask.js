const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");

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
    // Asking for a commit makes the branch reviewable on its own; the diff check
    // below still catches work left uncommitted.
    const prompt =
      `${task}

` +
      "끝나면 바꾼 내용을 git 으로 커밋해줘 (push 는 하지 마). 무엇을 왜 바꿨는지 한국어로 짧게 설명해줘.";
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

      if (code === 0 && parsed) {
        log(`[dev] #${id} finished, ${files.length} file(s), $${parsed.total_cost_usd ?? "?"}`);
        return done({
          ok: true,
          summary: `${(parsed.result || "(설명 없음)").slice(0, 1500)}${changed}`,
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
