import { db } from "./db.js";

// Rough per-token rates in KRW, derived from the August 2026 Vertex invoice
// (₩1,717 for 788,369 input units, ₩1,140 for 104,733 output units) before
// discounts. Only good enough to spot a spike — never quote it as the bill.
const KRW_PER_INPUT_TOKEN = 1717 / 788369;
const KRW_PER_OUTPUT_TOKEN = 1140 / 104733;

const upsertStmt = db.prepare(`
  INSERT INTO usage_daily (day, source, input_tokens, output_tokens, cached_tokens, requests)
  VALUES (?, ?, ?, ?, ?, 1)
  ON CONFLICT(day, source) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cached_tokens = cached_tokens + excluded.cached_tokens,
    requests = requests + 1
`);

const sinceStmt = db.prepare(
  "SELECT day, source, input_tokens, output_tokens, cached_tokens, requests FROM usage_daily WHERE day >= ? ORDER BY day DESC, input_tokens DESC"
);

export type UsageRow = {
  day: string;
  source: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  requests: number;
};

export type UsageCounts = {
  input: number;
  output: number;
  cached: number;
};

/** Today's date in the owner's timezone, so days line up with their calendar. */
function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Hong_Kong",
  });
}

export function recordUsage(source: string, counts: UsageCounts): void {
  try {
    upsertStmt.run(today(), source, counts.input, counts.output, counts.cached);
  } catch (err) {
    console.error("[usage] failed to record:", err);
  }
}

export function estimateKrw(input: number, output: number): number {
  return Math.round(input * KRW_PER_INPUT_TOKEN + output * KRW_PER_OUTPUT_TOKEN);
}

export function usageSince(days: number): UsageRow[] {
  return sinceStmt.all(daysAgo(days)) as UsageRow[];
}

export function formatUsage(days: number): string {
  const rows = usageSince(days);
  if (rows.length === 0) return "아직 기록된 사용량이 없어.";

  const byDay = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }

  const lines: string[] = [];
  let totalIn = 0;
  let totalOut = 0;

  for (const [day, list] of byDay) {
    const dIn = list.reduce((s, r) => s + r.input_tokens, 0);
    const dOut = list.reduce((s, r) => s + r.output_tokens, 0);
    const dReq = list.reduce((s, r) => s + r.requests, 0);
    totalIn += dIn;
    totalOut += dOut;

    lines.push(
      `${day} — 입력 ${dIn.toLocaleString()} / 출력 ${dOut.toLocaleString()} 토큰, 요청 ${dReq}회 (약 ${estimateKrw(dIn, dOut).toLocaleString()}원)`
    );
    for (const r of list) {
      lines.push(
        `    · ${r.source}: 입력 ${r.input_tokens.toLocaleString()} / 출력 ${r.output_tokens.toLocaleString()}, ${r.requests}회`
      );
    }
  }

  lines.push("");
  lines.push(
    `합계: 입력 ${totalIn.toLocaleString()} / 출력 ${totalOut.toLocaleString()} 토큰, 약 ${estimateKrw(totalIn, totalOut).toLocaleString()}원 (할인 전 추정치)`
  );
  return lines.join("\n");
}
