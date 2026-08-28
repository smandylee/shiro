import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { google } from "googleapis";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const CLIENT_PATH = process.env.GOOGLE_OAUTH_CLIENT_PATH ?? `${homedir()}/.openclaw/secrets/google-oauth-client.json`;
const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN_PATH ?? `${homedir()}/.openclaw/secrets/google-oauth-token.json`;

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.file",
];

type ClientSecretFile = {
  installed: { client_id: string; client_secret: string; redirect_uris: string[] };
};

export function loadOAuthClient(): OAuth2Client {
  const { installed } = JSON.parse(readFileSync(CLIENT_PATH, "utf-8")) as ClientSecretFile;
  return new google.auth.OAuth2(installed.client_id, installed.client_secret, installed.redirect_uris[0]);
}

export function hasStoredToken(): boolean {
  return existsSync(TOKEN_PATH);
}

export function saveToken(tokens: object): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

let cachedClient: OAuth2Client | null = null;

export function getAuthedClient(): OAuth2Client {
  if (cachedClient) return cachedClient;

  if (!hasStoredToken()) {
    throw new Error(
      `Google OAuth token not found at ${TOKEN_PATH}. Run "npm run google:authorize" first.`
    );
  }

  const client = loadOAuthClient();
  const tokens = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    saveToken({ ...tokens, ...newTokens });
  });

  cachedClient = client;
  return client;
}
