# Google integration: Gmail, Calendar and Drive notes

Optional. Without it, the mail, calendar and note tools report an error and everything else works.

Scopes requested: `gmail.modify`, `calendar`, `drive.file` (Drive access is limited to files Shiro created).

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com/), in the project you use for Vertex AI, enable
   the **Gmail API**, **Google Calendar API** and **Google Drive API**.
2. Create an **OAuth client ID** of type *Desktop app* and download its JSON.
3. Put it where the orchestrator looks (or point the variables at your own paths):

   ```
   ~/.openclaw/secrets/google-oauth-client.json   OAuth client (client_id / client_secret)    GOOGLE_OAUTH_CLIENT_PATH
   ~/.openclaw/secrets/google-oauth-token.json    the login token (created in the next step)  GOOGLE_OAUTH_TOKEN_PATH
   ```

   Both files should be mode `600`.
4. Sign in once:

   ```bash
   cd orchestrator
   npm run google:authorize
   ```

   A browser window opens; sign in and approve. The token file is written for you.

If the orchestrator runs on a server and you sign in from your PC, use the helper instead (see
[Re-authorising](#re-authorising-from-a-pc) below).

## When the token dies

**Symptom:** she cannot see mail or events, and the log says
`invalid_grant — Token has been expired or revoked`.

She notices and **tells you in a Discord DM** (once a day if it keeps failing). The server drops the dead token
and reads a new one on the next check, within five minutes — **no restart needed.**

### Re-authorising from a PC

```bash
node tools/google-reauth.js
```

This opens an SSH tunnel to the server, runs the authorisation script there, and opens the sign-in window on your
PC. You only sign in and approve. It uses `deployHost` and `deployKeyPath` from `avatar/config.json`.

### Why it broke every week

If the OAuth consent screen is in **"Testing"** status, Google expires refresh tokens after **7 days**. Signing in
again only gets you another 7-day token, so it repeats forever. **Publish the app to "In production"** and the
rule goes away.

- Console: <https://console.cloud.google.com/auth/audience> → **Publish app**.
- Publishing does **not** require verification. For a personal app you simply get the "unverified app" warning and a
  100-user cap. (Gmail scopes are a restricted category: real verification takes months and a security review.)
- **Sign in after publishing.** A token issued before that is still a 7-day token.
- How to tell which kind you have: if the token file has a `refresh_token_expires_in` key it is a 7-day token; if it
  does not, it is not. (Look at the key name only — do not print the values.)

It can still stop working after publishing if you **change your Google password** (tokens carrying Gmail scopes are
invalidated), if you **revoke access** on your account's security page, or if it goes unused for six months.

## A lesson in logging

When a Google call failed, the whole error object used to be printed to the log — and it contains the **request
body**. For a failed token refresh that means the `refresh_token` and `client_secret` in plain text. While it failed
every five minutes, thousands of lines piled up in the journal.

`orchestrator/src/google/errors.ts` now blocks this in two places:

- a failed token refresh is rethrown as a `GoogleAuthError` that carries no request;
- printing any `GaxiosError` produces a one-line summary (`Google 400 invalid_grant — ...`).

When you log an error, use `describeError(err)` instead of `console.error(err)`.

If you ever find secrets in a log, the reliable fix is to **rotate them** (create a new client secret and sign in
again), not to hunt for every copy: system logs and rotated archives keep their own.
