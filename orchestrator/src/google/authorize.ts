import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import http from "node:http";
import { google } from "googleapis";
import { SCOPES, saveToken } from "./client.js";

const CLIENT_PATH = process.env.GOOGLE_OAUTH_CLIENT_PATH ?? `${homedir()}/.openclaw/secrets/google-oauth-client.json`;
const PORT = 51894;
const redirectUri = `http://localhost:${PORT}`;

const { installed } = JSON.parse(readFileSync(CLIENT_PATH, "utf-8")) as {
  installed: { client_id: string; client_secret: string };
};

const client = new google.auth.OAuth2(installed.client_id, installed.client_secret, redirectUri);

const authUrl = client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

console.log("\n다음 URL로 접속해서 구글 계정 로그인 및 권한 승인을 해주세요:\n");
console.log(authUrl);
console.log("\n대기 중...\n");

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/")) return;
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("code 파라미터가 없어요.");
    return;
  }

  try {
    const { tokens } = await client.getToken(code);
    saveToken(tokens);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>인증 완료!</h1><p>이 창은 닫아도 돼요.</p>");
    console.log("토큰 저장 완료!");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("토큰 교환 실패");
    console.error(err);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 500);
  }
});

server.listen(PORT);
