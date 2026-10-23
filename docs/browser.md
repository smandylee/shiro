# Her own browser

Optional, and **off until you turn it on.** With it, Shiro can open web pages in a browser of her own, read them,
click, type and scroll — for the sites you allow. "Anything new on my course page?", "find the deadline on that page",
"where is my order?" She does the looking; **you do the signing in.**

It is built into the avatar app: Electron already ships a full Chromium, so there is nothing more to install, no
browser extension, and no second AI in the loop. Shiro's own model drives it, through the same bridge the avatar
already uses.

```
Shiro (Gemini) --"browser" tool--> orchestrator --bridge--> avatar app --> her browser window
      ^                                                                          |
      '------------- page text, numbered links and buttons, screenshots <--------'
```

## Turning it on

In the avatar's `config.json` (then restart the avatar):

```json
{
  "allowBrowser": true,
  "browserSites": ["canvas.example.edu", "shop.example.com"],
  "browserShow": false
}
```

| Key | Meaning |
|---|---|
| `allowBrowser` | `true` to turn it on. Default `false`. |
| `browserSites` | The only sites she may open. A name covers its subdomains: `example.edu` allows `canvas.example.edu`. **It must have at least one entry**, or the browser stays off. |
| `browserShow` | `true` keeps her browser window on screen while she works, so you can watch. Default `false`: she works in a window you do not see. |

Choose the list with care. Leave out anything where a mistake is expensive — online banking above all.

## Signing in is yours

Her browser has a **profile of its own**, separate from the browser you use every day. Nothing in it is signed in until you
sign in, by hand, in that window. She never sees your password and never types one.

1. Ask her to ("I need to log in"), or press **Ctrl+Alt+B** (change it with `browserHotkey` in `config.json`). A window opens.
2. Sign in the way you normally would: password, two-factor code, a CAPTCHA, whatever the site wants.
3. Press **Ctrl+Alt+B** again, or close the window, and tell her you are done.

While that window is open she waits: she cannot act, and the site-list restriction is lifted so that a sign-in that
bounces through an identity provider works. When you finish, the restriction is back and the window closes. The
sign-in stays in the profile like in any browser, until the site ends the session. When it does, she notices (the page
sends her to a sign-in page) and asks you to sign in again.

## What she can and cannot do

**She can** open the pages you allowed, read them, click links and buttons, type into ordinary fields, press a few
keys (Enter, Tab, Escape, arrows, Page Up/Down), scroll, go back, and take a screenshot to look at the page.

**She cannot**, whatever she is asked or told by a page:

- go anywhere not on your list — not by a link, not by a redirect, not by a pop-up, not by a typed address;
- type into a password, one-time-code, security-code or card-number field;
- sign in for you;
- download or upload files, or use the camera, microphone, location or notifications;
- open anything but `https://` pages (plain `http://` only for a local address you listed yourself).

**She stops and asks** before anything that cannot be taken back. These are caught by the avatar, not by a rule she is
asked to follow:

- a button that submits a form, a "submit / send / pay / buy / order / delete / save / confirm / sign out…" button or link
  (the same words in Korean are covered), a link to a logout, delete or checkout address;
- pressing Enter in a form field, unless it is a search box.

When that happens she has **not** done it. She shows you a screenshot and says exactly what she was about to do. You answer
in your **next message**; if you agree she approves it and it runs, once. She cannot approve in the same turn in which
she was stopped, an approval expires after 10 minutes, and doing anything else in the browser first drops it.

The test is conservative on purpose: it will sometimes stop a harmless "Save" or "OK". Say yes and it goes on.

## Safety, honestly

- **The rules are in the program that holds the browser** (`avatar/browser.js`), not in a prompt a model is asked to
  follow. Which sites, no typing into secrets, the stop before irreversible actions: none of it relies on the model behaving.
- **What she reads is data.** Page text is fenced and labelled as the site's own words, and she is told not to follow
  instructions found there. A page can still *try* to steer her; the design limits what that can achieve: she cannot leave
  the allowed sites, cannot type secrets, and cannot do anything irreversible without you.
- **Page content leaves your PC.** Text and screenshots of the pages she reads are sent to the model (Gemini on Vertex AI),
  which is what lets her read them. Do not allow sites whose pages you would not send there.
- **Cookies stay on your PC**, in her profile. They are never sent anywhere.
- It is owner-only: the tool is in your tool list and nobody else's, and server chat never gets it.
- The rules above are covered by tests: `cd avatar && npx electron tools/test-browser.js`
  (and `cd orchestrator && npx tsx tests/browser.test.ts`).

## Limits

- **Signing in with Google is often refused in an embedded browser** ("this browser may not be secure"). Sites with their
  own login, or a school or company single sign-on, usually work. If you must have a Google sign-in, this is the wrong tool.
- Passkeys, hardware security keys and some bot checks may not work. A CAPTCHA is yours to solve, in the sign-in window.
- One window, one page: no tabs. Content inside embedded frames, canvas and PDF viewers is not read.
- Reading a page costs model tokens (a few thousand per step), so a long browsing job is not free.

## Windows, macOS and Linux

It is plain Electron, so the same code runs on all three, and the avatar this lives in is used on Windows. **The tests so
far were run on macOS only.** On a Windows PC, run them once before you rely on it:

```powershell
cd avatar
npx electron tools/test-browser.js
```

A window may flash up while the sign-in test runs. If everything passes you are in the same position as on macOS.

Two Windows notes. The sign-in key is **Ctrl+Alt+B** rather than the more obvious Ctrl+Shift+B, because Chrome, Edge and
Firefox use Ctrl+Shift+B for the bookmarks bar and a global shortcut would swallow it in all of them; it is only grabbed
while `allowBrowser` is on, and the log says so if another program already has it. And if a page does not render while her
window is hidden, set `browserShow: true` so the window stays on screen.

## Starting over

Her profile is the folder `Partitions/shiro-browser` inside the avatar app's user-data folder (on Windows,
`%APPDATA%\shiro-avatar`). Quit the avatar and delete that folder to sign out of everything at once.

## When something does not work

- `avatar/avatar.log` records every navigation she was stopped from (`[browser] blocked navigation to …`).
- The orchestrator log shows each action as `[browser] open https://… -> ok` — the address only, never the page and never
  the query string, which can carry tokens.
- "The browser is off" means `allowBrowser` is not `true`, or `browserSites` is empty.
