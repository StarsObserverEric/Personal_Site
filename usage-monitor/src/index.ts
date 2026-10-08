/**
 * ECNU AI Console 用量监控 Worker
 *
 * 背景：用量看板（React SPA）右上角"刷新数据"按钮，背后就是一次
 *   GET /ecnu/key/userkey/usage?page=1&page_size=200&start=...&end=...
 * 的 XHR 请求（cookie 鉴权）。本 Worker 用 Cron Trigger 每 2 分钟替你发一次
 * 这个请求，把结果解析成一行记录写进 D1 —— 相当于一个常驻的自动刷新器。
 *
 * 凭证：ECNU_COOKIE = "SESSION=...; __access_token=..."（实测最小集合，
 * 缺一不可：只带 JWT 会 401，只带 SESSION 会 302 跳 SSO 登录）。
 * __access_token 的 exp 到 2027-09-05；SESSION 才是易失效的那张票，
 * 但每 2 分钟的定时请求本身就在"保持在线"。
 *
 * 端点（除 /healthz 外都要求 Authorization: Bearer <MONITOR_TOKEN>）：
 *   GET /run         手动触发一次采集（部署后验证用）
 *   GET /export.csv  导出全部记录为 CSV
 *   GET /healthz     存活探针，无鉴权无数据
 *
 * 存储表 ecnu_usage_log（复用 netdisk 的 cloud-r2pan D1 库）：
 * 成功行 status=ok 带四个限流窗口的 credits 与今日按模型聚合；
 * 失败行 status=error 带 http_status/note —— 让"凭证过期/接口改版"
 * 在数据里可见，而不是悄悄产出空值。
 */

export interface Env {
  DB: D1Database;
  ECNU_COOKIE: string;
  MONITOR_TOKEN: string;
  /** 7 天配额上限，看板显示 20000；可用环境变量覆盖 */
  QUOTA_CAP?: string;
}

/** 最小化的 D1 类型声明（避免为此项目引入 workers-types 依赖） */
interface D1Result {
  results?: unknown[];
}
interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  run(): Promise<unknown>;
  all(): Promise<D1Result>;
}
interface D1Database {
  prepare(query: string): D1Stmt;
  exec(query: string): Promise<unknown>;
}

const API_BASE = "https://aiconsole.ecnu.edu.cn/ecnu/key/userkey/usage";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0";
const TABLE = "ecnu_usage_log";

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  five_hour_credits REAL,
  day_credits REAL,
  week168_credits REAL,
  month_credits REAL,
  week168_started_at TEXT,
  week168_expires_at TEXT,
  quota_cap REAL,
  today_credits REAL,
  today_requests INTEGER,
  today_tokens INTEGER,
  models_json TEXT,
  note TEXT
)`;

/** 上海时区墙钟时间：raw epoch + 8h 后按 UTC 取字段即为北京时间 */
function shanghai(ms: number) {
  const d = new Date(ms + 8 * 3600e3);
  return {
    date: d.toISOString().slice(0, 10),
    ts: d.toISOString().replace("T", " ").slice(0, 19),
  };
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface UsageRow {
  ts: string;
  status: string;
  http_status: number | null;
  five_hour_credits: number | null;
  day_credits: number | null;
  week168_credits: number | null;
  month_credits: number | null;
  week168_started_at: string | null;
  week168_expires_at: string | null;
  quota_cap: number | null;
  today_credits: number | null;
  today_requests: number | null;
  today_tokens: number | null;
  models_json: string | null;
  note: string | null;
}

async function insertRow(db: D1Database, r: UsageRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ${TABLE}
        (ts, status, http_status, five_hour_credits, day_credits,
         week168_credits, month_credits, week168_started_at, week168_expires_at,
         quota_cap, today_credits, today_requests, today_tokens, models_json, note)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
    )
    .bind(
      r.ts, r.status, r.http_status, r.five_hour_credits, r.day_credits,
      r.week168_credits, r.month_credits, r.week168_started_at, r.week168_expires_at,
      r.quota_cap, r.today_credits, r.today_requests, r.today_tokens, r.models_json, r.note
    )
    .run();
}

/** 每次执行都跑一遍：CREATE TABLE IF NOT EXISTS 幂等且廉价，免去迁移步骤 */
async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(CREATE_SQL).run();
}

async function errorRow(db: D1Database, ts: string, http: number | null, note: string): Promise<void> {
  await insertRow(db, {
    ts, status: "error", http_status: http,
    five_hour_credits: null, day_credits: null, week168_credits: null, month_credits: null,
    week168_started_at: null, week168_expires_at: null, quota_cap: null,
    today_credits: null, today_requests: null, today_tokens: null,
    models_json: null, note: note.slice(0, 200),
  });
}

/** 采集一次：拉接口 → 解析 → 落一行。永不抛异常（失败也落一行 error 记录） */
export async function runOnce(env: Env): Promise<Record<string, unknown>> {
  await ensureTable(env.DB);
  const now = Date.now();
  const { date: today, ts } = shanghai(now);
  const start = shanghai(now - 29 * 86400e3).date;
  const quotaCap = Number(env.QUOTA_CAP || 20000) || 20000;

  const url = `${API_BASE}?page=1&page_size=200&start=${start}&end=${today}`;
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://aiconsole.ecnu.edu.cn/",
        "User-Agent": UA,
        Cookie: env.ECNU_COOKIE,
      },
    });

    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 160);
      await errorRow(env.DB, ts, resp.status, `HTTP ${resp.status}: ${body}`);
      return { ok: false, http: resp.status, note: body };
    }

    const data = (await resp.json()) as {
      result?: {
        rate_limit_usage?: Record<string, { credits?: unknown; windowStartedAt?: string; expiresAt?: string }>;
        items?: Array<{
          date?: string;
          model?: string;
          total_credits?: unknown;
          total_requests?: unknown;
          total_tokens?: unknown;
        }>;
      };
    };
    const r = data?.result ?? {};
    const rl = r.rate_limit_usage ?? {};
    const items = Array.isArray(r.items) ? r.items : [];

    // 聚合"今天"（上海日期）的分模型用量
    let todayCredits = 0;
    let todayReqs = 0;
    let todayTokens = 0;
    const models: Record<string, { credits: number; requests: number; tokens: number }> = {};
    for (const it of items) {
      if (it?.date !== today) continue;
      const c = num(it.total_credits) ?? 0;
      const q = num(it.total_requests) ?? 0;
      const t = num(it.total_tokens) ?? 0;
      todayCredits += c;
      todayReqs += q;
      todayTokens += t;
      const key = it.model || "unknown";
      const m = models[key] || (models[key] = { credits: 0, requests: 0, tokens: 0 });
      m.credits += c;
      m.requests += q;
      m.tokens += t;
    }

    const row: UsageRow = {
      ts,
      status: "ok",
      http_status: resp.status,
      five_hour_credits: num(rl["5hour"]?.credits),
      day_credits: num(rl.day?.credits),
      week168_credits: num(rl["168hour"]?.credits),
      month_credits: num(rl.month?.credits),
      week168_started_at: rl["168hour"]?.windowStartedAt ?? null,
      week168_expires_at: rl["168hour"]?.expiresAt ?? null,
      quota_cap: quotaCap,
      today_credits: r2(todayCredits),
      today_requests: todayReqs,
      today_tokens: todayTokens,
      models_json: JSON.stringify(models),
      note: null,
    };
    await insertRow(env.DB, row);

    return {
      ok: true,
      ts,
      week168: row.week168_credits,
      quota_cap: quotaCap,
      today: { credits: row.today_credits, requests: todayReqs, tokens: todayTokens },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await errorRow(env.DB, ts, null, `fetch failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

function authed(req: Request, env: Env): boolean {
  const t = env.MONITOR_TOKEN || "";
  if (!t) return false;
  const h = req.headers.get("Authorization") || "";
  if (h === `Bearer ${t}`) return true;
  // 允许 ?token= 兜底（浏览器直接打开 /export.csv 时用）
  const q = new URL(req.url).searchParams.get("token") || "";
  return q === t;
}

function toCsv(rows: Record<string, unknown>[]): string {
  const cols = [
    "id", "ts", "status", "http_status",
    "five_hour_credits", "day_credits", "week168_credits", "month_credits",
    "week168_started_at", "week168_expires_at", "quota_cap",
    "today_credits", "today_requests", "today_tokens", "models_json", "note",
  ];
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const row of rows) lines.push(cols.map((c) => esc(row[c])).join(","));
  return lines.join("\n");
}

export default {
  async scheduled(
    _event: { cron: string; scheduledTime: number },
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ): Promise<void> {
    ctx.waitUntil(
      runOnce(env)
        .then((r) => console.log("[usage-monitor]", JSON.stringify(r)))
        .catch((e) => console.error("[usage-monitor] unexpected failure", e))
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (!authed(req, env)) return new Response("unauthorized\n", { status: 401 });

    if (url.pathname === "/run") {
      const summary = await runOnce(env);
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/export.csv") {
      const q = await env.DB.prepare(`SELECT * FROM ${TABLE} ORDER BY id ASC LIMIT 100000`).all();
      const csv = toCsv((q.results ?? []) as Record<string, unknown>[]);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="ecnu_usage.csv"',
        },
      });
    }

    return new Response("not found\n", { status: 404 });
  },
};
