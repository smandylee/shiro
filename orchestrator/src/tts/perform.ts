// Text as it should be *performed* by a voice that reads bracketed audio tags (ElevenLabs v3/v4):
// what Koreans type to show a sound or a feeling ("ㅋㅋ", "ㅠㅠ", "ㅇㅇ") becomes the tag or the
// word that makes that sound, instead of being read out as letters. The reply text shown in Discord
// is untouched; this only shapes what goes to the voice. Runs after toSpokenText (typecast.ts),
// which has already removed emoji and markdown and put the line on one row.

const HANGUL = "ㄱ-ㅎㅏ-ㅣ가-힣";

// Chat shorthand that is a word spoken aloud ("ㅇㅇ" = 응응). Only when it stands alone, so it is
// never picked out of the middle of a longer run of letters.
const SHORTHAND: [string, string][] = [
  ["ㅇㅇ", "응응"],
  ["ㄴㄴ", "노노"],
  ["ㅇㅋ", "오케이"],
  ["ㄱㅅ", "감사"],
  ["ㅈㅅ", "죄송"],
  ["ㅊㅋ", "축하"],
  ["ㅅㄱ", "수고"],
  ["ㄱㄱ", "고고"],
];

// Sounds typed as runs of one letter. A longer run is the same sound said harder, so one tag covers it.
const SOUNDS: [RegExp, string][] = [
  [/ㅋ{2,}/g, " [laughs] "],
  [/ㅎ{2,}/g, " [laughs softly] "],
  [/[ㅠㅜ]{2,}/g, " [crying] "],
  [/ㅡㅡ+/g, " [sighs] "],
];

/** One line, shaped for the voice. May come back empty (nothing left to say). */
export function toPerformedText(spoken: string): string {
  let t = spoken;

  for (const [short, word] of SHORTHAND) {
    t = t.replace(new RegExp(`(^|[^${HANGUL}])${short}(?![${HANGUL}])`, "g"), `$1${word}`);
  }
  for (const [re, tag] of SOUNDS) t = t.replace(re, tag);

  return t
    .replace(/\^_\^|\^{2,}/g, "") // smiley faces are not speech
    .replace(/…/g, "...")
    .replace(/\.{4,}/g, "...") // a long trail reads no slower than three dots
    .replace(/[ㄱ-ㅎㅏ-ㅣ]+/g, " ") // letters left over would be read by name
    .replace(/\s{2,}/g, " ")
    .trim();
}
