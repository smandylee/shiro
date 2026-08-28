import { google } from "googleapis";
import { getAuthedClient } from "./client.js";

const VAULT_FOLDER_NAME = "Shiro Notes";

let cachedFolderId: string | null = null;

async function getVaultFolderId(): Promise<string> {
  if (cachedFolderId) return cachedFolderId;

  const drive = google.drive({ version: "v3", auth: getAuthedClient() });

  const existing = await drive.files.list({
    q: `name = '${VAULT_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (existing.data.files && existing.data.files.length > 0) {
    cachedFolderId = existing.data.files[0].id!;
    return cachedFolderId;
  }

  const created = await drive.files.create({
    requestBody: {
      name: VAULT_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  cachedFolderId = created.data.id!;
  return cachedFolderId;
}

// Drive's query language uses single quotes as string delimiters, so a title
// containing one would otherwise break the query (or worse, alter it).
function escapeForQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const MAX_NOTE_CHARS = 6000;

export async function listNotes(maxResults = 30): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getAuthedClient() });
  const folderId = await getVaultFolderId();

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: maxResults,
    spaces: "drive",
  });

  const files = res.data.files ?? [];
  if (files.length === 0) return "아직 저장한 노트가 없어.";

  const lines = files.map((f) => {
    const title = (f.name ?? "").replace(/\.md$/, "");
    const when = f.modifiedTime ? ` (수정: ${f.modifiedTime.slice(0, 10)})` : "";
    return `- ${title}${when}`;
  });
  return `저장된 노트 ${files.length}개:\n${lines.join("\n")}`;
}

export async function readNote(title: string): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getAuthedClient() });
  const folderId = await getVaultFolderId();
  const fileName = title.endsWith(".md") ? title : `${title}.md`;

  const found = await drive.files.list({
    q: `name = '${escapeForQuery(fileName)}' and '${folderId}' in parents and trashed = false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  const file = found.data.files?.[0];
  if (!file?.id) return `"${title}" 라는 노트를 못 찾았어. list_notes로 목록을 먼저 확인해봐.`;

  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "text" }
  );

  const content = typeof res.data === "string" ? res.data : String(res.data);
  const trimmed =
    content.length > MAX_NOTE_CHARS
      ? `${content.slice(0, MAX_NOTE_CHARS)}\n\n...(노트가 길어서 여기까지만 읽었어)`
      : content;

  return `노트 "${title}":\n\n${trimmed}`;
}

export async function searchNotes(query: string, maxResults = 10): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getAuthedClient() });
  const folderId = await getVaultFolderId();

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and fullText contains '${escapeForQuery(query)}'`,
    fields: "files(name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: maxResults,
    spaces: "drive",
  });

  const files = res.data.files ?? [];
  if (files.length === 0) return `"${query}" 가 들어간 노트를 못 찾았어.`;

  const lines = files.map((f) => `- ${(f.name ?? "").replace(/\.md$/, "")}`);
  return `"${query}" 검색 결과 ${files.length}개 (내용을 보려면 read_note로 열어):\n${lines.join("\n")}`;
}

export async function saveNote(title: string, content: string): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getAuthedClient() });
  const folderId = await getVaultFolderId();
  const fileName = `${title}.md`;

  const existing = await drive.files.list({
    q: `name = '${escapeForQuery(fileName)}' and '${folderId}' in parents and trashed = false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  const media = { mimeType: "text/markdown", body: content };

  if (existing.data.files && existing.data.files.length > 0) {
    const fileId = existing.data.files[0].id!;
    await drive.files.update({ fileId, media });
    return `노트 업데이트했어: ${title}`;
  }

  await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType: "text/markdown" },
    media,
    fields: "id",
  });
  return `노트 새로 저장했어: ${title}`;
}
