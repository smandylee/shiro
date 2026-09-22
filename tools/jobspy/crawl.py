# Runs on the owner's PC (not the server — its IP gets blocked far more easily).
# Reads public job-board search results with JobSpy (no login, no API key,
# LinkedIn's public guest search only) and drops one JSON file per run into
# output/, which the desktop avatar picks up and forwards to Shiro. Meant to
# be run by Windows Task Scheduler once or twice a day; see README.md.
import json
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from jobspy import scrape_jobs

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
OUTPUT_DIR = HERE / "output"
LOG_PATH = HERE / "crawl.log"
LOG_MAX_BYTES = 500_000


def log(line: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    text = f"{stamp}  {line}"
    print(text, flush=True)
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_MAX_BYTES:
            LOG_PATH.write_text("", encoding="utf-8")
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(text + "\n")
    except OSError:
        pass  # logging must never stop the run


def load_config() -> dict:
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def date_str(value) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    if isinstance(value, str):
        return value or None
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


def to_posting(row: "pd.Series", query: str) -> dict | None:
    job_url = row.get("job_url")
    if not isinstance(job_url, str) or not job_url:
        return None
    title = row.get("title")
    company = row.get("company")
    if not isinstance(title, str) or not title or not isinstance(company, str) or not company:
        return None
    location = row.get("location")
    return {
        "jobUrl": job_url,
        "title": title,
        "company": company,
        "location": location if isinstance(location, str) and location else None,
        "datePosted": date_str(row.get("date_posted")),
        "site": row.get("site") or "unknown",
        "query": query,
    }


def main() -> int:
    cfg = load_config()
    OUTPUT_DIR.mkdir(exist_ok=True)

    postings_by_url: dict[str, dict] = {}
    errors = 0

    for query in cfg["queries"]:
        for site in cfg["sites"]:
            try:
                df = scrape_jobs(
                    site_name=[site],
                    search_term=query,
                    location=cfg["location"],
                    country_indeed=cfg.get("countryIndeed"),
                    results_wanted=cfg.get("resultsPerQuery", 20),
                    hours_old=cfg.get("hoursOld", 720),
                    linkedin_fetch_description=bool(cfg.get("fetchLinkedinDescriptions", False)),
                    verbose=0,
                )
            except Exception:  # a blocked or changed site must not stop the rest of the run
                errors += 1
                log(f"{site:9s} {query!r} FAILED:\n{traceback.format_exc(limit=2)}")
                time.sleep(cfg.get("requestGapSeconds", 4))
                continue

            new_count = 0
            for _, row in df.iterrows():
                posting = to_posting(row, query)
                if posting and posting["jobUrl"] not in postings_by_url:
                    postings_by_url[posting["jobUrl"]] = posting
                    new_count += 1
            log(f"{site:9s} {query!r:34s} {len(df):3d} results ({new_count} new)")
            time.sleep(cfg.get("requestGapSeconds", 4))
        time.sleep(cfg.get("queryGapSeconds", 6))

    postings = list(postings_by_url.values())
    if not postings:
        log(f"nothing found this run ({errors} site/query failure(s)) — no file written")
        return 1 if errors == len(cfg["queries"]) * len(cfg["sites"]) else 0

    out_file = OUTPUT_DIR / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    out_file.write_text(json.dumps(postings, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"wrote {len(postings)} unique posting(s) to {out_file.name} ({errors} site/query failure(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
