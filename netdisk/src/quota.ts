/**
 * 存储硬上限 —— 让网盘**永远不碰 Cloudflare 免费档的 10 GB 存储额度**。
 *
 * ── 背景（为什么必须有这个文件）───────────────────────────────
 * 1. 之前 `storage_quota_bytes` 只是**显示**用的分母，上传路径压根没有校验，
 *    所以"设了 9.95 GB"完全不拦人。
 * 2. 老配额还用 **GiB**（9.95 GiB = 10.68 GB 十进制），而 Cloudflare 的免费额度
 *    10 GB 是**十进制**（= 9.31 GiB）。口径差了 7%，9.95 GiB 本身就已经超了 ——
 *    这是"页面显示才 8 GB、后台却 14 GB"的根因之一。
 * 3. D1 里 files.size 之和 ≠ R2 实际占用：孤儿对象、缩略图缓存都在偷偷占空间。
 *    所以判定必须用**真实桶内字节数**（定时 list 全桶累加），而不是 D1 求和。
 *
 * ── 三道防线 ──────────────────────────────────────────
 *   ① cron 每天（及容量页发现过期时）全桶 list 一遍，把真实字节写进 settings；
 *   ② 上传前拿真实字节算余量，不够就**自动按 deleted_at 从旧到新彻底删除**
 *      回收站里的文件，直到腾够为止；
 *   ③ 回收站都清空了还不够 ⇒ 直接 413 拒绝上传（宁可传不了，也绝不超额度）。
 *
 * 口径全部与 Cloudflare 对齐：**十进制字节**（1 GB = 10^9 B）。
 */

import type { Env } from "./types";
import type { Principal } from "./vfs";
import type { StorageProvider } from "./storage";
import { createStorageProvider } from "./storage";
import { getSettings } from "./settings";
import { purgeFromTrash } from "./filestore";

/** Cloudflare 免费档 R2 存储额度：10 GB（十进制）。后台「存储桶尺寸」也是这个口径。 */
export const CF_FREE_STORAGE_BYTES = 10_000_000_000;

/**
 * 默认硬上限 9.5 GB —— 比 10 GB 留 0.5 GB 余量。
 * ⚠️ 不要调到 9.9+：孤儿对象、缩略图、并发写入的瞬时峰值都可能让它悄悄溢出。
 */
const DEFAULT_CAP_BYTES = 9_500_000_000;

/** measure 数据超过这个时长就算过期（后台自动重测） */
export const MEASURE_STALE_MS = 6 * 3600 * 1000;
/** 单次全桶 list 的最大页数（1000/页 ⇒ 默认上限 ~100 万对象/前缀）。超出会打告警而非静默截断 */
const MEASURE_MAX_PAGES = 1000;
/** 上传腾空间时，每轮最多优先考虑从回收站删多少个（按 deleted_at 最旧优先） */
const FREED_ROUND_SIZE = 60;
/** 删对象并发车道（与 admin.ts 的 dropObjects 保持同量级） */
const DELETE_CONCURRENCY = 16;

/* ═══════════ 读 / 写校准值 ═══════════ */

export interface BucketMeasure {
  /** 桶内真实字节数（含孤儿对象与缩略图缓存） */
  bytes: number;
  /** 桶内对象个数 */
  objects: number;
  /** 测量时刻（Date.now()）；0 = 从未测过 */
  at: number;
}

/** 从 settings 读最近一次的全桶校准值 */
export async function readMeasure(env: Env): Promise<BucketMeasure | null> {
  const { results } = await env.db
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('measure_bytes','measure_objects','measure_at')"
    )
    .all<{ key: string; value: string }>();
  const map = new Map((results ?? []).map((r) => [r.key, r.value]));
  const bytes = Number(map.get("measure_bytes") ?? 0);
  if (!map.has("measure_bytes")) return null;
  return {
    bytes: Number.isFinite(bytes) ? bytes : 0,
    objects: Number(map.get("measure_objects") ?? 0) || 0,
    at: Number(map.get("measure_at") ?? 0) || 0,
  };
}

async function saveMeasure(env: Env, bytes: number, objects: number, at: number): Promise<void> {
  await env.db.batch([
    env.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES('measure_bytes', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .bind(String(bytes)),
    env.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES('measure_objects', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .bind(String(objects)),
    env.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES('measure_at', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .bind(String(at)),
  ]);
}

/**
 * 遍历桶内**所有**对象（key / size / lastModified）。
 *
 * ⚠️ 坑：R2 的 list 走的是 S3 ListObjectsV2 + `delimiter: "/"`。
 *    直接 `list({ prefix: "" })` 只会拿到两个"公共前缀"（files/、thumbs/），
 *    一条真实对象都列不出来（每个 key 都带 /，全被折叠进 commonPrefixes），
 *    于是校准出来是 0 个对象 / 0 字节 —— 必须**先探顶层前缀、再逐前缀翻页**。
 */
async function listAllObjects(st: StorageProvider): Promise<Map<string, { size: number; lastModified: number }>> {
  const out = new Map<string, { size: number; lastModified: number }>();

  const probe = await st.list({ prefix: "", limit: 1000 });
  const prefixes = (probe.entries ?? [])
    .filter((e) => e.isDir && e.key.endsWith("/"))
    .map((e) => e.key);
  // 探不到前缀（比如桶里只有零散文件）就退回常用的两个
  for (const prefix of prefixes.length ? prefixes : ["files/", "thumbs/"]) {
    let marker: string | undefined;
    let hitLimit = false;
    for (let page = 0; page < MEASURE_MAX_PAGES; page++) {
      const res = await st.list({ prefix, marker, limit: 1000 });
      for (const e of res.entries ?? []) {
        if (e.isDir) continue;
        out.set(e.key, { size: Number(e.size) || 0, lastModified: e.lastModified || 0 });
      }
      if (!res.truncated) break;
      marker = res.nextMarker;
      if (!marker) break;
      if (page === MEASURE_MAX_PAGES - 1) hitLimit = true;
    }
    // 之前静默截断 ⇒ 校准值偏小、可能顶穿硬上限。现在改为：到上限也继续翻，并打告警
    if (hitLimit) {
      console.error(`[quota] 前缀 "${prefix}" 对象数超过 ${MEASURE_MAX_PAGES * 1000}，校准值可能偏小，请检查存储规模`);
    }
  }
  return out;
}

/** 全桶 list 一遍，把真实占用写回 settings */
export async function measureBucket(env: Env): Promise<BucketMeasure> {
  const st = await createStorageProvider(env, await getSettings(env));
  const all = await listAllObjects(st);
  let bytes = 0;
  for (const v of all.values()) bytes += v.size;
  const at = Date.now();
  await saveMeasure(env, bytes, all.size, at);
  return { bytes, objects: all.size, at };
}

/* ═══════════ 硬上限 ═══════════ */

/**
 * 当前硬上限（字节，十进制）。优先级：
 *   settings 表 `storage_cap_bytes`  >  Worker 变量 `storage_cap_bytes`  >  9.5 GB 默认。
 * 放 settings 是为了**不重新部署**就能调（/api/admin/settings 可直接改）。
 */
export async function storageCap(env: Env): Promise<number> {
  const row = await env.db
    .prepare("SELECT value FROM settings WHERE key = 'storage_cap_bytes'")
    .first<{ value: string }>();
  const fromDb = Number(row?.value ?? 0);
  if (Number.isFinite(fromDb) && fromDb > 0) return fromDb;
  const fromVar = Number((env as unknown as Record<string, string | undefined>)["storage_cap_bytes"] || 0);
  if (Number.isFinite(fromVar) && fromVar > 0) return fromVar;
  return DEFAULT_CAP_BYTES;
}

export interface HeadroomResult {
  /** 是否腾够了（true 就可以放行上传） */
  ok: boolean;
  /** 本轮自动彻底删除回收站文件腾出的字节 */
  freed: number;
  /** 本次上传需要的字节 */
  need: number;
  /** 硬上限 */
  cap: number;
  /** 计算余量用的桶内真实字节（腾空间前） */
  used: number;
  /** 腾空间后剩余可写字节（负数表示仍然不够） */
  free: number;
}

/**
 * 保证「桶内真实占用 + need」不会超过硬上限。
 *
 * 腾空间策略：反复取**删除时间最早**的一批回收站文件，彻底删除（连对象一起抹），
 * 直到腾够 need；回收站清空了还不够就返回 ok:false，由调用方拒绝上传。
 *
 * ⚠️ 这里的删除对象是**同步 await** 的（不是 ctx.waitUntil）：
 *    必须确认对象真的从 R2 消失了才算腾出空间，否则下一秒又会被判超额度。
 */
export async function ensureHeadroom(
  env: Env,
  me: Principal,
  need: number
): Promise<HeadroomResult> {
  const cap = await storageCap(env);
  const m = (await readMeasure(env)) ?? { bytes: 0, objects: 0, at: 0 };
  // 校准值过期时用 D1 求和兜底，取两者较大者 —— 宁可用"偏大"的占用来卡，
  // 也绝不能因为"校准值过期"而悄悄越过 Cloudflare 的免费额度。
  const d1 = await env.db
    .prepare("SELECT COALESCE(SUM(size), 0) AS b FROM files")
    .first<{ b: number }>();
  const d1Total = Number(d1?.b || 0);
  const used = Math.max(m.bytes, d1Total);
  const base: HeadroomResult = { ok: true, freed: 0, need, cap, used, free: cap - used - need };
  if (need <= 0 || used + need <= cap) return base;

  // ⚠️ 要腾的是**缺口**，不是"本次文件大小"：
  //    可用 = cap - used，本次要 need，所以必须腾出 required = used + need - cap。
  //    之前写成"腾到 >= need"，结果回收站只腾出一个文件大小就放行，
  //    桶内仍然超上限 —— 正是要避免的那种超额度。
  const required = used + need - cap;
  if (required <= 0) return base;

  const st = await createStorageProvider(env, await getSettings(env));
  let freed = 0;

  for (;;) {
    const rows = await env.db
      .prepare(
        "SELECT id, key, size FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at ASC, id ASC LIMIT ?1"
      )
      .bind(FREED_ROUND_SIZE)
      .all<{ id: string; key: string; size: number }>();
    const batch = rows.results ?? [];
    if (!batch.length) break;

    const sizeOf = new Map(batch.map((r) => [r.id, Number(r.size) || 0]));
    let deleted = 0;
    // 从**最旧**的一个开始逐个彻底删除，腾够就用不了了为止
    // （不能"删一整批"：那会为了腾 6 MB 把 12 MB 的回收站全清空）
    for (const row of batch) {
      const { purged, keys } = await purgeFromTrash(env, me, [row.id]);
      const failed = await dropObjects(st, keys);
      if (purged > 0) {
        deleted += purged;
        // 只有对象真的从 R2 删掉了才计入"已腾出空间"；否则 DB 已清但 R2 仍在，
        // 误判腾够会让上传顶穿硬上限（dropObjects 返回的就是失败条数，不能吞）
        if (failed === 0) {
          freed += sizeOf.get(row.id) ?? 0;
        } else {
          console.error(`[quota] 删除回收站对象失败 ${failed} 个，key=${keys.join(",")}（DB 已清但 R2 仍在，未计入腾出空间）`);
        }
      }
      if (freed >= required) break;
    }
    console.error(
      `[quota] 上传需 ${need} B、缺口 ${required} B，已自动彻底删除 ${deleted} 个最旧回收站文件（+${freed} B）`
    );
    if (freed >= required) break;
  }

  return {
    ok: freed >= required,
    freed,
    need,
    cap,
    used,
    free: Math.max(0, cap - Math.max(used - freed, 0) - need),
  };
}

/**
 * 删对象，并发封顶（与 admin.ts::dropObjects 同理，这里要 await 到落地）。
 * 返回**失败条数** —— 不能吞掉：Worker 被墙钟掐断时，一半 delete 只是发出去了、
 * 请求就死了，报告"成功"等于骗人（2026-10-03 就栽在这：删了 3037 个、实际只剩一半）。
 */
async function dropObjects(st: StorageProvider, keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  let i = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(DELETE_CONCURRENCY, keys.length) }, async () => {
      while (i < keys.length) {
        const k = keys[i++];
        try {
          await st.delete(k);
        } catch {
          failed += 1;
        }
      }
    })
  );
  return failed;
}

/* ═══════════ 孤儿对象（R2 有、D1 查不到）—— 白占额度 ═══════════ */

export interface OrphanReport {
  count: number;
  bytes: number;
  /** 抽查样例（最多 20 条），带最后修改时间 */
  sample: { key: string; size: number; lastModified: number }[];
  scanned: number;
}

/** 扫描结果 + 便于后续删除时算字节的 size 表 */
interface OrphanScan extends OrphanReport {
  keys: string[];
  sizeOf: Map<string, number>;
  /** 每个孤儿对象所在前缀（只可能是 files/），删除前二次确认用 */
  prefixOf: Map<string, string>;
  /** 桶内缩略图缓存（不是孤儿，白白占用但删了要重生成，只报告不删） */
  thumb_count: number;
  thumb_bytes: number;
}

/**
 * 扫出「桶里有、files 表里查不到」的对象。
 *
 * 来源：批量彻底删除时 `ctx.waitUntil(dropObjects(...))` 被 Worker 的 CPU/时长限制
 * 掐断过，D1 行没了、对象却留在桶里 —— 页面看不见，CF 照收钱。
 */
async function scanOrphans(env: Env, limit = 20): Promise<OrphanScan> {
  const st = await createStorageProvider(env, await getSettings(env));
  const all = await listAllObjects(st);
  const keys = [...all.keys()];
  const sizeOf = new Map([...all].map(([k, v]) => [k, v.size]));
  const times = new Map([...all].map(([k, v]) => [k, v.lastModified]));
  const prefixOf = new Map(keys.map((k) => [k, k.indexOf("/") > 0 ? k.slice(0, k.indexOf("/")) : ""]));

  // 分批反查 files.key，找出查不到的
  const known = new Set<string>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    if (!chunk.length) break;
    const ph = chunk.map(() => "?").join(",");
    const { results } = await env.db
      .prepare(`SELECT key FROM files WHERE key IN (${ph})`)
      .bind(...chunk)
      .all<{ key: string }>();
    for (const r of results ?? []) known.add(String(r.key));
  }

  // ⚠️ 孤儿只认 `files/` 前缀：缩略图 key 是 `thumbs/<fileid>-<w>.jpg`，
  //    与本来的 files.key（`files/<fileid>`）根本不是一回事，拿它反查必然查不到 ——
  //    把 5822 张缩略图误判成孤儿是"定义写错"，不算回收空间。
  let thumbBytes = 0;
  let thumbCount = 0;
  for (const k of keys) {
    if (k.startsWith("thumbs/")) { thumbBytes += sizeOf.get(k) ?? 0; thumbCount += 1; }
  }

  const orphans = keys.filter((k) => k.startsWith("files/") && !known.has(k));
  let bytes = 0;
  const sample: { key: string; size: number; lastModified: number }[] = [];
  for (const k of orphans) {
    bytes += sizeOf.get(k) ?? 0;
    if (sample.length < limit) sample.push({ key: k, size: sizeOf.get(k) ?? 0, lastModified: times.get(k) ?? 0 });
  }
  return {
    count: orphans.length, bytes, sample,
    scanned: keys.length, keys: orphans, sizeOf, prefixOf,
    thumb_count: thumbCount, thumb_bytes: thumbBytes,
  };
}

export interface OrphanReportFull extends OrphanReport {
  /** 全部孤儿 key（前端分批删除要用；对象特别多时可不加这个字段） */
  keys?: string[];
  thumb_count: number;
  thumb_bytes: number;
}

export function listOrphans(env: Env, limit = 20): Promise<OrphanReportFull> {
  return scanOrphans(env, limit).then((s) => ({
    count: s.count,
    bytes: s.bytes,
    sample: s.sample,
    scanned: s.scanned,
    // 只给前 5000 个 key：够前端分批删了，也不至于把响应撑成几 MB
    keys: s.count <= 5000 ? s.keys : undefined,
    thumb_count: s.thumb_count,
    thumb_bytes: s.thumb_bytes,
  }));
}

/**
 * 真的删掉孤儿对象（不可恢复）。
 *
 * ⚠️ 只准删 `files/` 前缀：thumbs/ 是缩略图缓存，key 长得像孤儿但删了要重生成，
 *    而且它们同样占 Cloudflare 的额度 —— 属于"该留的"，不是"该清的"。
 *
 * @param scan 同一次扫描的结果（避免为了拿字节数再扫一遍）
 */
async function purgeKeys(
  env: Env,
  keys: string[],
  scan: OrphanScan
): Promise<{ deleted: number; bytes: number; skipped: number; failed: number }> {
  if (!keys.length) return { deleted: 0, bytes: 0, skipped: 0, failed: 0 };
  const set = new Set(scan.keys);
  const doomed = keys.filter((k) => set.has(k) && scan.prefixOf.get(k) === "files");
  const st = await createStorageProvider(env, await getSettings(env));
  let bytes = 0;
  for (const k of doomed) bytes += scan.sizeOf.get(k) ?? 0;
  const failed = await dropObjects(st, doomed);
  const ok = doomed.length - failed;
  console.error(`[quota] 已彻底删除 ${ok} 个孤儿对象，回收 ${bytes} 字节（失败 ${failed}）`);
  return { deleted: ok, bytes, skipped: keys.length - doomed.length, failed };
}

interface PurgeOrphansResult {
  /** 真删掉的条数（不算被掐断没落地的那些） */
  deleted: number;
  bytes: number;
  /** 传进来的 key 里不属于孤儿 / 不属于 files/ 而被跳过的 */
  skipped: number;
  failed: number;
}

/** 扫一遍并删光所有孤儿（只动 files/ 前缀，缩略图缓存一个不碰） */
export async function purgeAllOrphans(env: Env): Promise<PurgeOrphansResult> {
  const scan = await scanOrphans(env, 0);
  return purgeKeys(env, scan.keys, scan);
}

/** 只删指定的几条孤儿（小步确认用；会按 files/ 前缀再过滤一次） */
export async function purgeOrphans(env: Env, keys: string[]): Promise<PurgeOrphansResult> {
  if (!keys.length) return { deleted: 0, bytes: 0, skipped: 0, failed: 0 };
  const scan = await scanOrphans(env, 0);
  return purgeKeys(env, keys, scan);
}
