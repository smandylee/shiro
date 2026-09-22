import { broadcast, hasAvatarClient, setDevListener } from "./avatar/bridge.js";
import { finishDevTask, getRunningDevTask } from "./memory/devtasks.js";
import { getSetting } from "./memory/settings.js";

// Shiro asking for changes to herself. She writes the request in plain words;
// the owner approves it; Claude Code on the owner's PC does the work in an
// isolated git worktree and reports back. Nothing here deploys anything: the
// result is a branch for the owner to look at, and putting it on the server
// stays a manual step.

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
}

async function report(
  result: { id: number; ok: boolean; summary: string; branch?: string | null; costUsd?: number | null; touchedGuardrails?: string[] },
  task: string | undefined,
  getChannel: GetChannel
): Promise<void> {
  const channelId = getSetting("ownerChannelId");
  const channel = channelId ? await getChannel(channelId) : null;
  if (!channel) return;

  const lines = [
    result.ok ? `개발 요청 #${result.id} 끝났어!` : `개발 요청 #${result.id} 실패했어.`,
    task ? `> ${task.slice(0, 300)}` : "",
    "",
    result.summary.slice(0, 1200),
  ];
  if (result.branch) lines.push("", `브랜치: \`${result.branch}\` (아직 합치지도 배포하지도 않았어)`);
  if (typeof result.costUsd === "number") lines.push(`비용: $${result.costUsd.toFixed(2)}`);
  if (result.touchedGuardrails?.length) {
    lines.push(
      "",
      `⚠️ 건드리면 안 되는 파일이 바뀌었어: ${result.touchedGuardrails.join(", ")}`,
      "합치기 전에 이 부분 꼭 직접 확인해줘."
    );
  }

  const text = lines.filter((l) => l !== undefined).join("\n");
  for (let i = 0; i < text.length; i += 2000) await channel.send(text.slice(i, i + 2000));
}
