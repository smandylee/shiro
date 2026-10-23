# JobSpy crawler (the job-postings feature)

A small crawler that runs on **your own PC**. It uses [JobSpy](https://github.com/speedyapply/JobSpy) to query a
modest number of job postings (configured for Hong Kong) and writes them as JSON into `output/`. The running avatar
reads those files and passes them to the server. **No login and no API key is needed**: LinkedIn is searched through
its public, logged-out pages only.

**Never run it on your server (a cloud VM).** Datacenter IP addresses get blocked far more easily.

## Install (once)

```powershell
cd tools\jobspy
py -3.12 -m venv venv
venv\Scripts\pip install -r requirements.txt
```

(On macOS/Linux: `python3 -m venv venv && venv/bin/pip install -r requirements.txt`.)

## Try it

```powershell
venv\Scripts\python crawl.py
```

A file such as `20260922T120000Z.json` in `output/` means it worked. `crawl.log` records how many results each site
returned. With the avatar running, it reads the file within a minute, sends it to the server and deletes it (if
sending fails it tries again next time and the file stays).

## Running it on a schedule (Windows Task Scheduler)

**The one-line way** — runs daily at 09:00 and 21:00 with no console window, and once at the next boot if the PC was
off:

```powershell
powershell -ExecutionPolicy Bypass -File tools\autostart\install.ps1
```

(The same script also registers logon autostart for the avatar, the dev worker and the server tunnel. Postings only
reach Shiro while the avatar is running. See [Getting started](../../docs/getting-started.md#5-keeping-the-pc-side-running-windows).)

By hand:

1. Open **Task Scheduler** → **Create Basic Task**.
2. Trigger: daily, once or twice a day (for example 9 a.m.).
3. Action: start a program.
   - Program: `<repo>\tools\jobspy\venv\Scripts\python.exe`
   - Arguments: `crawl.py`
   - Start in: `<repo>\tools\jobspy`
4. "Run with highest privileges" is not needed. If the PC is off that day it is skipped, which is fine.

## Settings (`config.json`)

| Field | Meaning |
|---|---|
| `queries` | List of search terms, queried one after another. |
| `location`, `countryIndeed` | Where to search. Hong Kong by default. |
| `sites` | `linkedin`, `indeed` (Google and Glassdoor break often, so they are left out). |
| `resultsPerQuery` | Maximum results for each search term. |
| `hoursOld` | Only postings newer than this (default 720 hours = 30 days). |
| `requestGapSeconds`, `queryGapSeconds` | Pauses between requests. Shortening them raises the risk of being blocked. |
| `fetchLinkedinDescriptions` | Fetch each LinkedIn posting's full text. **Every posting then costs an extra request**, so it is off by default. |

## Asking Shiro

In Discord, ask "any new postings?" and she tells you about the ones she has not shown yet, ten at a time; ask for
more and she gives the next ten. A posting she has shown you does not come up again. She never brings them up on her
own — she only checks when you ask.

## Rules to keep

- **Do not put a LinkedIn password or cookie in any file in this folder.** It works logged out, by design.
- **Once or twice a day is plenty.** The more often it runs, the more likely your IP is blocked.
- `venv/`, `output/` and `crawl.log` are not committed (`.gitignore`).
