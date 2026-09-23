import { broadcast, hasAvatarClient, setDevListener, setDeployListener } from "./avatar/bridge.js";
import { finishDeploy, finishDevTask, getDevTask, getRunningDevTask } from "./memory/devtasks.js";
import { getSetting } from "./memory/settings.js";

// Shiro asking for changes to herself. She writes the request in plain words;
// the owner approves it; Claude Code on the owner's PC does the work in an
// isolated git worktree and reports back with a branch.
//
// Shipping that branch is a second, separate yes. The build agent has no way to
// reach the server at all; the PC worker does, through one fixed script that
// only takes a branch name. So there are two approvals, and neither of them is
// Shiro's to give.

type SendableChannel = { send: (content: string) => Promise<unknown> };
type GetChannel = (channelId: string) => Promise<SendableChannel | null>;

/** Hands an approved request to the PC. Throws with a readable reason when it can't. */
export function sendDevTask(id: number, task: string): void {
  if (!hasAvatarClient()) {
    throw new Error("아바타가 꺼져 있어서 작업을 보낼 수 없어. 아바타를 켜고 다시 승인해줘.");
  }
  broadcast({ type: "dev_task", id, task });
  console.log(`[dev] sent task #${id} to the PC`);
}

/** Hands a finished branch to the PC's deploy script. Throws with a readable reason when it can't. */
export function sendDeploy(id: number, branch: string): void {
  if (!hasAvatarClient()) {
    throw new Error("PC 쪽이 꺼져 있어서 배포를 시킬 수 없어. 개발 워커를 켜고 다시 말해줘.");
  }
  broadcast({ type: "deploy", id, branch });
  console.log(`[dev] sent deploy of ${branch} (task #${id}) to the PC`);
}

export function startDevTasks(getChannel: GetChannel): void {
  setDevListener((result) => {
    const running = getRunningDevTask();
    finishDevTask(result.id, result);
    console.log(
      `[dev] task #${result.id} ${result.ok ? "done" : "failed"}` +
        (result.costUsd ? ` ($${result.costUsd.toFixed(2)})` : "") +
        (result.touchedGuardrails?.length ? ` — touched guardrails: ${result.touchedGuardrails.join(", ")}` : "")
    );

    void report(result, running?.task, getChannel).catch((err) =>
      console.error("[dev] could not report the result:", err)
    );
  });

  setDeployListener((result) => {
    const task = getDevTask(result.id);
    finishDeploy(result.id, result.ok, result.summary);
    console.log(`[dev] deploy of task #${result.id} ${result.ok ? "succeeded" : "failed"}`);

    void say(
      [
        result.ok ? `배포 끝났어! (요청 #${result.id})` : `배포 실패했어 (요청 #${result.id}).`,
        task?.task ? `> ${task.task.slice(0, 200)}` : "",
        "",
        result.summary.slice(0, 1200),
      ],
      getChannel
    ).catch((err) => console.error("[dev] could not report the deploy:", err));
  });
}

/** "Nothing was built" and "nothing was worth building" read very differently to
 *  the owner, and only one of them is still waiting for him. */
function headline(result: { id: number; ok: boolean; verdict?: string | null }): string {
  if (!result.ok) return `개발 요청 #${result.id} 실패했어.`;
  switch (result.verdict) {
    case "declined":
      return `개발 요청 #${result.id} — 안 해도 될 것 같아서 안 했대.`;
    case "escalated":
      return `개발 요청 #${result.id} — 할 만한데 자기가 못 하는 일이래. 클로드 코드한테 직접 시켜야 해.`;
    default:
      return `개발 요청 #${result.id} 끝났어!`;
  }
}

async function report(
  result: {
    id: number;
    ok: boolean;
    verdict?: string | null;
    summary: string;
    branch?: string | null;
    costUsd?: number | null;
    touchedGuardrails?: string[];
  },
  task: string | undefined,
  getChannel: GetChannel
): Promise<void> {
  const built = result.ok && result.verdict !== "declined" && result.verdict !== "escalated";
  const lines = [headline(result), task ? `> ${task.slice(0, 300)}` : "", "", result.summary.slice(0, 1200)];

  if (result.branch && built) {
    lines.push("", `브랜치: \`${result.branch}\` (아직 합치지도 배포하지도 않았어)`);
    if (!result.touchedGuardrails?.length) lines.push("확인해보고 괜찮으면 배포하라고 말해줘.");
  }
  if (typeof result.costUsd === "number") lines.push(`비용: $${result.costUsd.toFixed(2)}`);
  if (result.touchedGuardrails?.length) {
    lines.push(
      "",
      `⚠️ 건드리면 안 되는 파일이 바뀌었어: ${result.touchedGuardrails.join(", ")}`,
      "이건 내가 배포 못 해. 합치기 전에 꼭 직접 봐줘."
    );
  }
  await say(lines, getChannel);
}

async function say(lines: string[], getChannel: GetChannel): Promise<void> {
  const channelId = getSetting("ownerChannelId");
  const channel = channelId ? await getChannel(channelId) : null;
  if (!channel) return;
  const text = lines.filter((l) => l !== undefined).join("\n");
  for (let i = 0; i < text.length; i += 2000) await channel.send(text.slice(i, i + 2000));
}
