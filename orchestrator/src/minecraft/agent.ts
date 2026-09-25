import { broadcast, setMinecraftListener, type McStateMessage } from "../avatar/bridge.js";
import { decide } from "./planner.js";

// The wire between her body on the PC and the part of her that decides.
//
// The PC asks — here is where I am, here is what just happened, what now — and
// this answers with a short list of skills. That is the entire exchange. She
// plays on her own because nobody is telling her what to want; the owner never
// joins that server.
//
// Whatever arrives here came out of a game: chat from strangers, block names,
// the contents of a bag. It is described to the planner as a situation, never
// handed to it as an instruction, and the planner has no tools to act on one
// even if it wanted to.

type SendableChannel = { send: (content: string) => Promise<unknown> };
type GetChannel = (channelId: string) => Promise<SendableChannel | null>;

let thinking = false;

export function startMinecraft(_getChannel: GetChannel): void {
  setMinecraftListener((state: McStateMessage) => {
    // One at a time. A second request while the first is in flight would spend
    // twice to answer the same question.
    if (thinking) return;
    thinking = true;

    void decide(state)
      .then((plan) => {
        if (!plan) {
          // No plan is a real answer: the PC waits and asks again shortly.
          broadcast({ type: "mc_plan", goal: "", steps: [] });
          return;
        }
        console.log(`[mc] ${plan.goal} — ${plan.steps.length}단계`);
        broadcast({ type: "mc_plan", goal: plan.goal, say: plan.say, steps: plan.steps });
      })
      .catch((err) => {
        console.error("[mc] could not answer:", err);
        broadcast({ type: "mc_plan", goal: "", steps: [] });
      })
      .finally(() => {
        thinking = false;
      });
  });
}
