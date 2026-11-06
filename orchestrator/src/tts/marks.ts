import { EMOTIONS, type Emotion } from "../persona.js";

// The marks the model writes into a reply for the voice, besides the opening "[emotion:x]" that
// sets her expression (persona.ts, reply.ts):
//
//   [emotion:love]            the feeling changes here: from this line on the voice carries it
//   [voice:whispering, shy]   a finer cue than the eight feelings, for the voice only
//
// A new [emotion:…] clears the voice cue unless a [voice:…] comes with it. Neither mark is ever
// shown in Discord or kept in her memory; the expression on the avatar follows the opening tag only.

const EMOTION_MARK = /\[emotion:([a-z]+)\]\s*/gi;
const VOICE_MARK = /\[voice:\s*([^\]\n]{0,80})\]\s*/gi;

export const MAX_CUE_LENGTH = 40;

/**
 * A voice cue as it may be sent on: lower-case English words and commas, short. Anything else
 * (another language, brackets, a sentence, nothing) is not a cue, and the feeling's own tag is used.
 */
export function cleanCue(raw: string): string | null {
  const cue = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!cue || cue.length > MAX_CUE_LENGTH) return null;
  return /^[a-z][a-z ,'-]*$/.test(cue) ? cue : null;
}

export type LineMarks = {
  /** The line with every mark taken out. */
  line: string;
  /** The feeling this line changes to, when it carries a mark for one. */
  emotion?: Emotion;
  /** The voice cue from this line on: a string sets it, null clears it, undefined leaves it as it was. */
  cue?: string | null;
};

function isEmotion(value: string): value is Emotion {
  return (EMOTIONS as readonly string[]).includes(value);
}

/** Reads and removes the marks in one line of a reply. The last of each kind wins. */
export function readLineMarks(raw: string): LineMarks {
  let emotion: Emotion | undefined;
  let cue: string | null | undefined;

  const withoutEmotion = raw.replace(EMOTION_MARK, (_all, name: string) => {
    const lower = name.toLowerCase();
    if (isEmotion(lower)) {
      emotion = lower;
      cue = null; // a new feeling starts without the old cue, unless a voice mark follows
    }
    return "";
  });
  const line = withoutEmotion
    .replace(VOICE_MARK, (_all, text: string) => {
      cue = cleanCue(text);
      return "";
    })
    .trim();

  return { line, ...(emotion ? { emotion } : {}), ...(cue !== undefined ? { cue } : {}) };
}

/** Text with every mark removed, for what is kept (memory, logs). */
export function stripMarks(text: string): string {
  return text.replace(EMOTION_MARK, "").replace(VOICE_MARK, "").trim();
}
