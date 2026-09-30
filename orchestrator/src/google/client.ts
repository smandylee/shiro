import { readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { google } from "googleapis";
import { GoogleAuthError, describeError, installSafeErrorPrinting, isInvalidGrant } from "./errors.js";

installSafeErrorPrinting();

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

export function loadOAuthClient(ClientClass: typeof google.auth.OAuth2 = google.auth.OAuth2): OAuth2Client {
  const { installed } = JSON.parse(readFileSync(CLIENT_PATH, "utf-8")) as ClientSecretFile;
  return new ClientClass(installed.client_id, installed.client_secret, installed.redirect_uris[0]);
}

export function hasStoredToken(): boolean {
  return existsSync(TOKEN_PATH);
}

export function saveToken(tokens: object): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { encoding: "utf-8", mode: 0o600 });
  // `mode` only applies when the file is created, and this one already exists
  // on every machine that has ever been authorized.
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    /* not every filesystem has permissions; the write above still succeeded */
  }
}

// --- Knowing when the token has died ---------------------------------------
//
// A dead refresh token used to fail silently: every five-minute check threw,
// the log filled up, and the owner found out by noticing she could no longer
// see mail. So the first failure is reported once, and re-authorizing takes
// effect on the next call instead of waiting for a restart.

type AlertFn = (message: string) => void | Promise<void>;
let alertOwner: AlertFn | null = null;

/** Registers how to tell the owner. Kept as a callback so this file knows nothing about Discord. */
export function setGoogleAuthAlert(fn: AlertFn): void {
  alertOwner = fn;
}

// A reminder a day while it stays broken, not one every five minutes.
const ALERT_EVERY_MS = 24 * 60 * 60 * 1000;
let lastAlertAt = 0;
let wasDead = false;

const ALERT_TEXT = [
  "구글 인증이 끊겼어. 지금 Gmail이랑 캘린더를 못 봐.",
  "구글 비밀번호를 바꿨거나, 계정 보안 페이지에서 시로 권한을 뺐을 때 이렇게 돼.",
  "PC에서 `node tools/google-reauth.js` 를 실행하고 뜨는 창에서 로그인해줘. 재시작은 안 해도 돼.",
  "(계속 안 되면 하루에 한 번만 다시 말할게)",
].join("\n");

function authDied(): void {
  // Forget the cached client. The next call re-reads the token file, so a
  // fresh authorization is picked up without restarting the service.
  cachedClient = null;
  wasDead = true;
  if (!alertOwner || Date.now() - lastAlertAt < ALERT_EVERY_MS) return;
  lastAlertAt = Date.now();
  console.error("[google] refresh token is dead — telling the owner");
  void Promise.resolve(alertOwner(ALERT_TEXT)).catch((err) =>
    console.error("[google] could not send the re-authorization notice:", describeError(err))
  );
}

/**
 * The client the service actually uses. Every API call gets its auth headers
 * through getRequestMetadataAsync, and that is where a failed refresh surfaces,
 * so this is the one place to do two things: notice a dead token, and make sure
 * the failed request — which carries the refresh token and client secret in its
 * form body — is never what gets thrown.
 */
class WatchedOAuth2Client extends google.auth.OAuth2 {
  protected override async getRequestMetadataAsync(url?: string | null) {
    try {
      const result = await super.getRequestMetadataAsync(url);
      if (wasDead) {
        wasDead = false;
        lastAlertAt = 0; // if it dies again, say so right away
        console.log("[google] authorization is working again");
      }
      return result;
    } catch (err) {
      const dead = isInvalidGrant(err);
      if (dead) authDied();
      throw new GoogleAuthError(describeError(err), dead);
    }
  }
}

let cachedClient: OAuth2Client | null = null;

export function getAuthedClient(): OAuth2Client {
  if (cachedClient) return cachedClient;

  if (!hasStoredToken()) {
    throw new Error(
      `Google OAuth token not found at ${TOKEN_PATH}. Run "npm run google:authorize" first.`
    );
  }

  const client = loadOAuthClient(WatchedOAuth2Client);
  const tokens = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    saveToken({ ...tokens, ...newTokens });
  });


  cachedClient = client;
  return client;
}
