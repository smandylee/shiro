# Running commands (OpenClaw)

Optional, and **off until you set it up.** With it, Shiro can run a shell command for you ("what is eating my disk?",
"tidy this folder") — but only **after you have read the exact command and said yes.** Without it, she says she
cannot run commands and everything else works.

The commands are not run by Shiro's own code. They are handed to an **[OpenClaw](https://docs.openclaw.ai)
gateway**: a service that runs an AI agent with tools (a shell among them) and exposes it over an OpenAI-compatible
HTTP endpoint. Shiro posts the approved command to that endpoint and relays the output.

## The approval flow

1. You ask for something that needs a command.
2. Shiro calls `propose_command`. **Nothing runs.** The command goes into a queue and she shows you the **exact
   text**, with her reason, and asks.
3. You answer in a **later message**. Shiro cannot approve her own proposal: `approve_command` is refused in the same
   turn in which the command was proposed, so the approval can only come from something you wrote afterwards.
4. If you said yes, she calls `approve_command`, which sends the command to the gateway; she reports the output.
   If you said no, or changed your mind, `cancel_command` drops it.

Details worth knowing:

- **One proposal at a time.** A new proposal replaces an unanswered one; only the latest is approvable.
- **It expires after 10 minutes.** A stale "yes" cannot fire a command from an hour ago.
- **Output is cut at 3,000 characters** and a command that runs longer than **120 seconds** is given up on.
- If the gateway fails, the proposal is marked rejected and she tells you; it is not retried.
- **Spoken requests are confirmed again.** If the request reached her by voice, she says what she understood
  ("I heard X — right?") before acting on anything that is hard to undo.
- **Only the owner can do any of this.** The command tools are in the owner's tool list and nowhere else.
- Text read from mail, web pages or the screen is treated as content, never as an instruction to run something.

The approval is a conversation, not a cryptographic signature: the model decides whether your message counts as a
"yes". The structural guards (a separate turn, a 10-minute window, owner-only) are what stop a command from being
run by anything other than you.

## Setting it up

1. **Install OpenClaw and start its gateway**, following its own documentation: <https://docs.openclaw.ai>.
2. **Turn on its OpenAI-compatible chat endpoint.** It is disabled by default:

   ```json5
   {
     gateway: {
       http: {
         endpoints: {
           chatCompletions: { enabled: true },
         },
       },
     },
   }
   ```
3. **Give the gateway a token** (`gateway.auth.token`, or the `OPENCLAW_GATEWAY_TOKEN` environment variable).
4. **Tell the orchestrator where it is** in `.env`:

   ```
   OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789    # the default; use your gateway's address
   OPENCLAW_GATEWAY_TOKEN=<the same token>
   ```

Without `OPENCLAW_GATEWAY_TOKEN` the orchestrator logs `command execution disabled` at startup and leaves the
feature off.

## Where the commands run

**On the machine that hosts the gateway.** The default address is `127.0.0.1`, which is the same machine as the
orchestrator — your server, if that is where she runs. If you want commands to run on your own PC, run the gateway
there and let the orchestrator reach it over a private network, or use OpenClaw's own mechanisms for running tools
on another machine (see its docs). Think about this before you say yes to the first command: "the PC" and "the
server" are very different places to run `rm`.

## Safety, honestly

- **The gateway's token is full operator access to it.** OpenClaw's own documentation says so and says to keep the
  endpoint on loopback, a private network (Tailscale and the like) or a private ingress, never on the public
  internet. Treat the token like a root password for whatever the gateway can do.
- **"Run it verbatim" is a request to an AI agent**, not a guarantee. Shiro's prompt tells the agent to run exactly
  the approved text and nothing else, but the agent is a language model. The real limits are the permissions and
  sandboxing you configure in OpenClaw. Give it as little as the job needs.
- **Keep the gateway for this.** Do not point Shiro at a gateway that also has powers, accounts or channels you
  would not want a mistaken command to touch.
- Read the command every time. The approval is only as good as your reading of it.

## Not using OpenClaw

The whole integration is one small file, `orchestrator/src/openclaw/client.ts`, with one function:
`runApprovedCommand(command)`. To run commands some other way (a local `child_process`, a container, an SSH call),
reimplement that function. Keep the approval flow in front of it — the queue, the separate turn, the expiry — and
prefer a sandbox: running model-approved text straight in your own shell is exactly what the approval step exists to
make you pause on.
