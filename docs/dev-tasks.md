# Development requests: Shiro asking for changes to herself

Optional, and **off by default**. Shiro does not write code herself. She states what she wants **in words**; once
you approve, Claude Code on your PC works in an isolated git worktree and reports back. Shipping the result is a
second, separate "yes".

You need [Claude Code](https://claude.com/claude-code) installed on the PC that runs the avatar.

## The flow

1. Shiro files a request with the `request_dev_task` tool (for example: "checking mail keeps failing"). **Nothing
   runs yet.**
2. You approve (`approve_dev_task`). The request goes over the bridge to your PC and Claude Code runs.
3. When it finishes you get a Discord DM with what changed and what it cost, and a verdict:
   - **Done** — it built something; there is a branch.
   - **Declined** — it was already done, would have no effect, or was too vague. Nothing changed.
   - **Handed back** — worth doing, but outside what the worker may do (installing packages, server configuration).
     You do it yourself in a Claude Code session.
4. If you like the result, say **"deploy it"**: `deploy_dev_task` puts it on the server. If you say nothing, it stays
   a branch.

## Turning it on

In the avatar's `config.json`: `"allowDevTasks": true` (default `false`). `devModel` (default `sonnet`) and
`devMaxBudgetUsd` (default `2`) set the model and the spending cap.

Requests are handled by a **separate worker**, not by the avatar window, so they still work when the avatar is
closed. It is a small process that reads the same config file:

```powershell
cd avatar
npm run devworker
```

It starts at logon if you installed the [autostart tasks](getting-started.md#5-keeping-the-pc-side-running-windows).
If the worker is off, Shiro says at the approval step that she cannot send the job. Its log is
`avatar/devworker.log`.

## Deploying

Say "deploy it" to ship a result you like. It is **not Claude Code that deploys**: the worker runs
`tools/deploy/deploy.js` as written. The agent that wrote the code has no `ssh` at all, and the script takes one
argument — a branch name — so it cannot be told what to do on the server.

The steps: merge into `main` → `tsc` → upload `orchestrator/src` → restart the service → check the log for the
Discord login. **If she does not come back, the server is rolled back to the previous code, `main` is reverted,**
and she tells you why.

It will not deploy, and hands the change to you, when:

- `package.json` changed (packages must be installed on the server);
- files outside `orchestrator/src` changed;
- a guardrail file changed;
- the checkout is dirty, not on `main`, or the worktree has uncommitted work.

To enable: `"allowDeploy": true` plus `deployHost` and `deployKeyPath` in `config.json`
(`deployRemoteDir` and `deployService` have defaults). Off by default.

## Safety

- **Worktree isolation.** Work happens only on a separate branch under `.claude/worktrees/`. The main checkout
  cannot be touched.
- **No way out.** The coding agent is forbidden `git push`, `ssh`, `scp`, `curl` and `WebFetch`. The only road to
  the server is the deploy path above, which you approve separately and which follows a fixed sequence.
- **Cleaning up worktrees.** The `node_modules` junction used for type-checking is removed as soon as the check
  ends. Running `git worktree remove -f` while it is still attached follows the link and **empties the real
  `node_modules`** (this happened once).
- **Nothing runs without approval.** A phishing instruction read from a mail, a web page or the screen that gets
  turned into a request still lands in front of you first.
- **Guardrail warning.** If an approval gate, the persona's safety rules or the like change, the result is flagged
  with ⚠️ (`GUARDRAIL_FILES` in `avatar/devtask.js`).
- **Pointless requests are cut.** A vague, already-done or ineffective request changes no code; she is told why.
- **Type-check.** After the work, `tsc` runs in the worktree and its result is reported. A failure is never reported
  as success.
- One at a time, with a spending cap and a time limit (15 minutes by default).

## Cost

About $0.2–0.5 per request: the agent reads the project's context every time, so even a short job has a base cost.
