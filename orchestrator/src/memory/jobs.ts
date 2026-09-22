import { db } from "./db.js";

// Job postings JobSpy found on the owner's PC (Hong Kong, no login) and sent up
// through the avatar bridge. Nothing is fetched from here — this only stores
// what arrived and tells check_jobs what the owner hasn't seen yet.

db.exec(`
  CREATE TABLE IF NOT EXISTS job_postings (
    job_url TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT,
    date_posted TEXT,
    site TEXT NOT NULL,
    query TEXT,
    found_at INTEGER NOT NULL,
    shown_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_job_postings_shown ON job_postings(shown_at);
`);

export type JobPosting = {
  jobUrl: string;
  title: string;
  company: string;
  location: string | null;
  datePosted: string | null;
  site: string;
  query: string | null;
};

const MAX_STORED = 2000;

const insertStmt = db.prepare(
  `INSERT INTO job_postings (job_url, title, company, location, date_posted, site, query, found_at)
   VALUES (@jobUrl, @title, @company, @location, @datePosted, @site, @query, @foundAt)
   ON CONFLICT(job_url) DO NOTHING`
);
const pruneStmt = db.prepare(
  `DELETE FROM job_postings WHERE job_url NOT IN (
     SELECT job_url FROM job_postings ORDER BY found_at DESC LIMIT ${MAX_STORED}
   )`
);

/** Stores newly found postings, skipping ones already known by their URL. Returns how many were new. */
export function storeJobPostings(postings: JobPosting[]): number {
  const now = Date.now();
  let added = 0;
  const insertMany = db.transaction((rows: JobPosting[]) => {
    for (const p of rows) {
      const result = insertStmt.run({
        jobUrl: p.jobUrl,
        title: p.title,
        company: p.company,
        location: p.location,
        datePosted: p.datePosted,
        site: p.site,
        query: p.query,
        foundAt: now,
      });
      if (result.changes > 0) added++;
    }
  });
  insertMany(postings);
  pruneStmt.run();
  return added;
}

const selectUnseenStmt = db.prepare(
  "SELECT job_url, title, company, location, date_posted, site FROM job_postings WHERE shown_at IS NULL ORDER BY found_at DESC LIMIT ?"
);
const markShownStmt = db.prepare(
  `UPDATE job_postings SET shown_at = ? WHERE shown_at IS NULL`
);

export type StoredJob = {
  jobUrl: string;
  title: string;
  company: string;
  location: string | null;
  datePosted: string | null;
  site: string;
};

/** Postings never shown to the owner before, newest first. Doesn't mark them as shown. */
export function unseenJobPostings(limit = 40): StoredJob[] {
  const rows = selectUnseenStmt.all(limit) as {
    job_url: string;
    title: string;
    company: string;
    location: string | null;
    date_posted: string | null;
    site: string;
  }[];
  return rows.map((r) => ({
    jobUrl: r.job_url,
    title: r.title,
    company: r.company,
    location: r.location,
    datePosted: r.date_posted,
    site: r.site,
  }));
}

/** Marks every currently-unseen posting as shown, so the next check only returns what's new since. */
export function markAllShown(): void {
  markShownStmt.run(Date.now());
}
