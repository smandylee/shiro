import { google, type gmail_v1 } from "googleapis";
import { getAuthedClient } from "./client.js";

// Email bodies can run to tens of thousands of characters; anything past this
// is noise for a chat reply and just burns context.
const MAX_BODY_CHARS = 4000;

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodePart(part: gmail_v1.Schema$MessagePart): string {
  const data = part.body?.data;
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf-8");
}

// Walk the MIME tree depth-first looking for the first part of the given type.
// Multipart mail nests arbitrarily (multipart/alternative inside
// multipart/mixed, etc.), so this can't just scan the top level.
function findPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string
): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

// Gmail's `snippet` field arrives HTML-escaped too, so this is shared rather
// than folded into stripHtml.
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function stripHtml(html: string): string {
  const withoutTags = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withoutTags);
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  const plain = findPart(payload, "text/plain");
  if (plain) return decodePart(plain);

  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodePart(html));

  // Single-part message: the body hangs directly off the payload.
  return decodePart(payload);
}

function tidy(text: string): string {
  const collapsed = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return collapsed.length > MAX_BODY_CHARS
    ? `${collapsed.slice(0, MAX_BODY_CHARS)}\n\n...(본문이 길어서 여기까지만 읽었어)`
    : collapsed;
}

async function summarizeList(
  gmail: gmail_v1.Gmail,
  messages: gmail_v1.Schema$Message[]
): Promise<string[]> {
  return Promise.all(
    messages.map(async (m) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      const headers = msg.data.payload?.headers ?? undefined;
      const from = header(headers, "From") || "(알 수 없음)";
      const subject = header(headers, "Subject") || "(제목 없음)";
      const date = header(headers, "Date");
      const snippet = msg.data.snippet ? ` — ${decodeEntities(msg.data.snippet).slice(0, 100)}` : "";
      return `- [id:${m.id}] ${from} / ${subject}${date ? ` (${date})` : ""}${snippet}`;
    })
  );
}

export async function listUnreadEmails(maxResults = 10): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth: getAuthedClient() });

  const list = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults,
  });

  const messages = list.data.messages ?? [];
  if (messages.length === 0) return "안 읽은 메일이 없어.";

  const summaries = await summarizeList(gmail, messages);
  return `안 읽은 메일 ${messages.length}개 (본문을 보려면 id를 read_email에 넘겨):\n${summaries.join("\n")}`;
}

export async function searchEmails(query: string, maxResults = 10): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth: getAuthedClient() });

  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const messages = list.data.messages ?? [];
  if (messages.length === 0) return `"${query}" 조건에 맞는 메일을 못 찾았어.`;

  const summaries = await summarizeList(gmail, messages);
  return `검색 결과 ${messages.length}개 (본문을 보려면 id를 read_email에 넘겨):\n${summaries.join("\n")}`;
}

export async function readEmail(messageId: string): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth: getAuthedClient() });

  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = msg.data.payload?.headers ?? undefined;
  const from = header(headers, "From") || "(알 수 없음)";
  const to = header(headers, "To");
  const subject = header(headers, "Subject") || "(제목 없음)";
  const date = header(headers, "Date");

  const body = tidy(extractBody(msg.data.payload ?? undefined));

  return [
    `보낸사람: ${from}`,
    to ? `받는사람: ${to}` : "",
    `제목: ${subject}`,
    date ? `날짜: ${date}` : "",
    "",
    body || "(본문을 읽을 수 없었어)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
