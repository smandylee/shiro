// Same sentences in the voice before and after the tag changes, to listen to and compare.
// Spends a little ElevenLabs credit (about twenty short clips). Run where the keys are, with the
// service's environment, from a folder that can see node_modules:
//
//   set -a; . /etc/shiro.env; set +a
//   TTS_PROVIDER=elevenlabs npx tsx scripts/voice-samples.ts     # writes data/voice-samples/*.mp3
//
// Files are named <group>-<name>.mp3: "tag-sad-old" is the old tag, "tag-sad-new" the current one;
// "ctx-line2-alone" is the second line voiced by itself, "ctx-line2-after-line1" with the first line given.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Emotion } from "../src/persona.js";
import { synthesizeStream } from "../src/tts/elevenlabs.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "voice-samples");
mkdirSync(OUT, { recursive: true });

// What each feeling was before: the five tags, nothing for the rest.
const OLD_TAGS: Partial<Record<Emotion, string>> = {
  happy: "[excited]",
  sad: "[sorrowful]",
  angry: "[frustrated]",
  surprised: "[gasps]",
  embarrassed: "[nervous]",
};

const LINES: Record<Emotion, string> = {
  neutral: "오늘 일정은 오후에 수업 하나야.",
  happy: "당연하지, 내가 누군데! 간식 줘.",
  sad: "...어떡해. 괜찮아? 일단 뭐 좀 먹고 와.",
  angry: "바보 아니거든! 주인님이 더 바보야!",
  surprised: "어, 진짜? 벌써 그 시간이야?",
  embarrassed: "어, 아닌데... 아 맞네. 내가 틀렸다.",
  thinking: "음... 그건 좀 더 생각해 봐야겠는데.",
  love: "주인님이 옆에 있으면 그냥 좋아.",
};

async function save(name: string, audio: AsyncGenerator<Buffer> | null): Promise<void> {
  if (!audio) return console.log(`${name}: no audio`);
  const parts: Buffer[] = [];
  for await (const c of audio) parts.push(c);
  const bytes = Buffer.concat(parts);
  writeFileSync(join(OUT, `${name}.mp3`), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}

const signal = new AbortController().signal;

// The old way is sent as it was: the tag in front of the plain line, no shaping, no context.
async function oldWay(emotion: Emotion): Promise<AsyncGenerator<Buffer> | null> {
  const tag = OLD_TAGS[emotion];
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: tag ? `${tag} ${LINES[emotion]}` : LINES[emotion],
        model_id: process.env.ELEVENLABS_MODEL || "eleven_v4",
      }),
    }
  );
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return (async function* () {
    yield buf;
  })();
}

for (const emotion of Object.keys(LINES) as Emotion[]) {
  await save(`tag-${emotion}-old`, await oldWay(emotion));
  await save(`tag-${emotion}-new`, await synthesizeStream(LINES[emotion], emotion, signal));
}

// Chat shorthand: typed as the user would, spoken as sound and word.
await save("shape-laugh", await synthesizeStream("ㅋㅋㅋ 주인님 그게 뭐야, 진짜 웃기다ㅋㅋ", "happy", signal));
await save("shape-cry", await synthesizeStream("ㅠㅠ 나 두고 가는 거야? 너무해...", "sad", signal));
await save("shape-word", await synthesizeStream("ㅇㅇ 알겠어. ㅇㅋ 바로 할게.", "neutral", signal));

// Two lines of one reply, the second with and without the first given.
const first = "주인님, 방금 뭐라고 했어?";
const second = "...잘못 들은 거 아니지? 다시 말해 봐.";
await save("ctx-line2-alone", await synthesizeStream(second, "embarrassed", signal));
await save("ctx-line2-after-line1", await synthesizeStream(second, "embarrassed", signal, { previousText: first }));
