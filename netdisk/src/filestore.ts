/**
 * 文件与目录的业务操作（回收站 / 目录树）。
 *
 * 与 vfs.ts 的分工：
 *   vfs.ts       —— 纯规则（路径规范化、角色权限判断），不碰 DB
 *   filestore.ts —— 真正读写 D1 / 存储的落库逻辑，权限判断一律委托 vfs.ts
 *
 * ── 目录与文件的表示 ──────────────────────────────────────
 *   directories 表：path = 目录的**完整路径**（如 /admin/摄影）
 *   files 表：path = 所在目录（如 /admin/摄影），name = 文件名
 *   ⇒ 文件的完整路径 = `${path}/${name}`（path 为 '/' 时即 `/${name}`）
 *
 * ── 回收站模型（本轮定稿）──────────────────────────────
 *   只对**文件**做软删除（files.deleted_at / deleted_by / original_path）。
 *   删除目录 = 递归软删除其下所有文件 + 移除目录结构行；
 *   还原时按文件的 original_path 自动把目录结构补回来。
 *   取舍：空的目录被删除后不会在回收站留条目（目录只是结构，重建成本为零）。
 */

import type { Env } from "./types";
import type { Principal } from "./vfs";
import {
  normalizePath, isSafeName, isSystemDirName, canReadPath, canWritePath,
  visibleRootDirs, homeDirOf, liveScopeOf, trashScopeOf,
  canMoveSource, canMoveTarget, canMoveDirInto, rootOf,
  PUBLIC_DIR, ADMIN_PRIVATE_DIR, RECYCLE_BIN_DIR, SYSTEM_DIRS,
} from "./vfs";

/** 回收站保留时长：超过即由定时任务彻底删除 */
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 带 HTTP 状态码的业务错误 —— 由路由层统一转成 JSON 响应 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* ═══════════ 工具 ═══════════ */

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** 拆成面包屑：[{name:'admin', path:'/admin'}, ...] */
function breadcrumbOf(dir: string): { name: string; path: string }[] {
  const segs = dir.split("/").filter(Boolean);
  const out: { name: string; path: string }[] = [];
  let acc = "";
  for (const s of segs) {
    acc += "/" + s;
    out.push({ name: s, path: acc });
  }
  return out;
}

/** 确保系统保留目录在 directories 表里有实体行 */
export async function ensureSystemDirs(env: Env, ownerName: string): Promise<void> {
  const now = Date.now();
  const stmts = [PUBLIC_DIR, ADMIN_PRIVATE_DIR].map((n) =>
    env.db
      .prepare(
        "INSERT INTO directories(path, created_at, owner, system) VALUES(?1, ?2, ?3, 1) ON CONFLICT(path) DO NOTHING"
      )
      .bind(`/${n}`, now, ownerName)
  );
  // 每个用户的个人文件夹也先建好，根目录才有东西可显示
  stmts.push(
    env.db
      .prepare(
        "INSERT INTO directories(path, created_at, owner, system) VALUES(?1, ?2, ?3, 0) ON CONFLICT(path) DO NOTHING"
      )
      .bind(homeDirOf({ name: ownerName, role: "admin" }), now, ownerName)
  );
  try {
    await env.db.batch(stmts);
  } catch {
    /* 并发下 ON CONFLICT 已足够，这里只兜底 */
  }
}

/* ═══════════ 列目录 ═══════════ */

export interface DirEntry {
  name: string;
  path: string;
  system: boolean;
  owner: string;
  /** true 表示这是"回收站"这类派生视图，不是真实目录 */
  virtual?: boolean;
}

export interface FileEntry {
  id: string;
  name: string;
  size: number;
  mime: string;
  path: string;
  owner: string;
  uploaded_at: number;
  /** 文件的真实修改时间（浏览器 File.lastModified），老数据可能为 NULL */
  mtime?: number | null;
  /** 媒体元数据：图片/视频的像素宽高 */
  width?: number | null;
  height?: number | null;
  /** 视频时长（毫秒） */
  duration_ms?: number | null;
  /** 视频帧率 */
  fps?: number | null;
  /** 视频轨码率 / 音频轨码率（bit/s） */
  v_bitrate?: number | null;
  a_bitrate?: number | null;
  share_count?: number;
  download_count?: number;
}

export interface DirListing {
  path: string;
  breadcrumb: { name: string; path: string }[];
  dirs: DirEntry[];
  files: FileEntry[];
  /** 该目录是否允许当前身份写入（前端据此禁用"新建文件夹/上传"） */
  writable: boolean;
}

export async function listDir(env: Env, me: Principal, dirInput: string): Promise<DirListing> {
  const dir = normalizePath(dirInput);
  if (!dir) throw new HttpError(400, "路径非法");
  if (!canReadPath(me, dir)) throw new HttpError(403, "无权限访问该目录");

  const writable = canWritePath(me, dir);

  /* ── 根目录：只返回顶层文件夹，不列文件 ── */
  if (dir === "/") {
    await ensureSystemDirs(env, me.name);

    // 所有出现过的用户名（来自目录与文件的 owner）
    const rows = await env.db
      .prepare(
        `SELECT owner AS name FROM directories WHERE owner IS NOT NULL AND owner != ''
         UNION
         SELECT owner AS name FROM files WHERE owner IS NOT NULL AND owner != ''`
      )
      .all<{ name: string }>();
    const userNames = (rows.results ?? []).map((r) => r.name);

    const names = visibleRootDirs(me, userNames);
    const dirs: DirEntry[] = names.map((n) => ({
      name: n,
      path: "/" + n,
      system: isSystemDirName(n),
      owner: n,
      virtual: n === RECYCLE_BIN_DIR,
    }));
    return { path: "/", breadcrumb: [], dirs, files: [], writable: false };
  }

  /* ── 回收站是派生视图，交给专门的接口 ── */
  if (dir === "/" + RECYCLE_BIN_DIR) {
    throw new HttpError(400, "回收站请使用 /api/admin/trash 接口");
  }

  /* ── 普通目录 ── */
  const allDirs = await env.db
    .prepare("SELECT path, owner, system FROM directories")
    .all<{ path: string; owner: string; system: number }>();

  const prefix = dir + "/";
  const dirs: DirEntry[] = [];
  for (const d of allDirs.results ?? []) {
    if (!d.path.startsWith(prefix)) continue;             // 不在本目录下
    const rest = d.path.slice(prefix.length);
    if (!rest || rest.includes("/")) continue;            // 只要直接子目录
    if (isSystemDirName(rest)) continue;                  // 系统目录不在普通目录里露头
    if (!canReadPath(me, d.path)) continue;               // 别人的目录不显示
    dirs.push({ name: rest, path: d.path, system: !!d.system, owner: d.owner });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh"));

  const scope = liveScopeOf(me);
  const filesRes = await env.db
    .prepare(
      `SELECT f.id, f.name, f.size, f.mime, f.path, f.owner, f.uploaded_at,
              f.mtime, f.width, f.height, f.duration_ms, f.fps, f.v_bitrate, f.a_bitrate,
              (SELECT COUNT(*) FROM shares s WHERE s.file_id = f.id) AS share_count,
              (SELECT COALESCE(SUM(s.download_count), 0) FROM shares s WHERE s.file_id = f.id) AS download_count
       FROM files f
       WHERE f.path = ?1 AND ${scope.where}
       ORDER BY f.name COLLATE NOCASE ASC`
    )
    .bind(dir, ...scope.binds)
    .all<FileEntry>();

  return {
    path: dir,
    breadcrumb: breadcrumbOf(dir),
    dirs,
    files: filesRes.results ?? [],
    writable,
  };
}

/* ═══════════ 可写目录清单（"移动到…"选择器）═══════════ */

/**
 * 列出当前身份**可写**的全部目录路径，供「移动到…」的下拉菜单使用。
 * 为什么单独做这个接口：让用户手打目标路径容易打错、也容易打到无权的位置；
 * 直接给出"你能放进来的目录清单"，既好用又天然不会越权（筛选条件就是 canWritePath）。
 *
 * - 管理员：全部目录（可跨用户子空间），仅排除回收站
 * - 普通用户：只有自己个人文件夹内的目录
 * - 根目录 `/` 不在清单里（根目录只放用户文件夹，不允许直接放条目）
 */
export async function listWritableDirs(env: Env, me: Principal): Promise<string[]> {
  const res = await env.db.prepare("SELECT path FROM directories").all<{ path: string }>();
  const out: string[] = [];
  for (const r of res.results ?? []) {
    if (!r.path || r.path === "/") continue;
    if (rootOf(r.path) === RECYCLE_BIN_DIR) continue;
    if (!canWritePath(me, r.path)) continue;
    out.push(r.path);
  }
  out.sort((a, b) => a.localeCompare(b, "zh"));
  return out;
}

/* ═══════════ 新建目录 ═══════════ */

export async function makeDir(
  env: Env,
  me: Principal,
  parentInput: string,
  nameInput: string
): Promise<DirEntry> {
  const parent = normalizePath(parentInput);
  if (!parent) throw new HttpError(400, "父目录路径非法");
  if (parent === "/") throw new HttpError(400, "根目录下不允许直接新建文件夹，请进入自己的个人文件夹");

  const name = String(nameInput ?? "").trim();
  if (!isSafeName(name)) throw new HttpError(400, "文件夹名不合法");
  if (isSystemDirName(name)) throw new HttpError(400, "该名称为系统保留，不能使用");
  if (!canWritePath(me, parent)) throw new HttpError(403, "无权限在此处新建文件夹");

  const full = joinPath(parent, name);
  const exists = await env.db
    .prepare("SELECT 1 FROM directories WHERE path = ?1")
    .bind(full)
    .first();
  if (exists) throw new HttpError(409, "同名文件夹已存在");

  await env.db
    .prepare("INSERT INTO directories(path, created_at, owner, system) VALUES(?1, ?2, ?3, 0)")
    .bind(full, Date.now(), me.name)
    .run();

  return { name, path: full, system: false, owner: me.name };
}

/** 上传整目录时补齐 path 上的中间目录。
 *
 * 为什么需要：upload 只往 files 表插一行（path = 所在目录），**不会**自动建目录，
 * 而前端上传文件夹时会把文件直接送到 `<当前目录>/子目录/…`。少了中间目录行，
 * 这些文件在目录树里"悬空"——接口按 path 查得到，用户却点不到那些子文件夹。
 *
 * 为什么不复用 makeDir：makeDir 禁止在 '/' 下直接建子项、要求名字合法且不重名；
 * 这里只是把一条已确定的路径链补上，所以直接 INSERT OR IGNORE 一次扫完所有祖先。
 */
export async function ensureDirChain(env: Env, me: Principal, dirInput: string): Promise<void> {
  const dir = normalizePath(dirInput);
  if (!dir || dir === "/") return;   // 根本身是虚拟根，不落表
  if (!canWritePath(me, dir)) throw new HttpError(403, "无权限写入该目录");
  const parts = dir.split("/").filter(Boolean);
  const now = Date.now();
  const stmt = env.db.prepare(
    "INSERT OR IGNORE INTO directories(path, created_at, owner, system) VALUES(?1, ?2, ?3, 0)"
  );
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    await stmt.bind(acc, now, me.name).run();
  }
}

/* ═══════════ 批量写的分片工具 ═══════════
 *
 * 为什么必须有这一层（2026-10-02 踩坑）：
 *   「删除 2680 项」曾经点了没反应 —— 前端等的是一个**永远不会回来**的响应。
 *   病根有两个，都是"一次做太多"：
 *     ① db.batch() 一次提交上千条语句会直接炸（实测 150 条 OK、1600 条 500）；
 *     ② 每条语句一个 round-trip（原来"按 id 查文件"是 for 循环逐条 SELECT），
 *        2680 条就是 2680 次往返，光等 D1 就烧掉大半墙钟预算。
 * ⇒ 任何"几十个以上"的批量写都走：切片 + IN(?,?,…) 批次取 + 有并发上限的批量写。
 *   请求时间的硬预算是 Workers 墙钟（Cloudflare 按 30s 量级兜），所以这里宁可多跑几趟。
 */
const BATCH_CHUNK = 90;        // 单批语句数 / 单批 IN 占位符数
const BATCH_PARALLEL = 3;      // 同批并发趟数（无脑全并发会打爆 D1 连接预算）

function chunkArr<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** 有并发上限的 map（保序）。全并发会把 D1 的并发预算打满，串行又太慢。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 把 n 条语句切成多批并发提交 —— 大目录批量删除的唯一入口 */
async function batchChunks(
  env: Env,
  stmts: { q: string; b: unknown[] }[],
  chunk = BATCH_CHUNK
): Promise<void> {
  const groups = chunkArr(stmts, chunk);
  await mapLimit(groups, BATCH_PARALLEL, async (grp) => {
    await env.db.batch(grp.map((s) => env.db.prepare(s.q).bind(...s.b)));
  });
}

/** 按 id 批量取行（一条 IN 替代 N 次 round-trip） */
async function selectByIds<T>(
  env: Env,
  ids: string[],
  sql: string,
  extraWhere = ""
): Promise<T[]> {
  const groups = chunkArr(ids, BATCH_CHUNK);
  const res = await mapLimit(groups, BATCH_PARALLEL, async (grp) => {
    const ph = grp.map(() => "?").join(",");
    const r = await env.db
      .prepare(`SELECT ${sql} FROM files WHERE id IN (${ph})${extraWhere}`)
      .bind(...grp)
      .all<T>();
    return r.results ?? [];
  });
  return res.flat();
}

/* ═══════════ 软删除 → 回收站 ═══════════ */

/**
 * 按 id 收集"我有权处理"的存活文件，并做权限校验（软删除 / 彻底删除共用同一套口径）。
 * 重复 id 只算一次（勾选状态里可能出现同名键）。
 */
async function collectFileRows(
  env: Env,
  me: Principal,
  ids: string[]
): Promise<{ id: string; path: string; name: string }[]> {
  const uniq = [...new Set(ids.filter((x) => typeof x === "string" && x))];
  if (!uniq.length) return [];
  const rows = await selectByIds<{ id: string; path: string; name: string; owner: string; deleted_at: number | null }>(
    env, uniq, "id, path, name, owner, deleted_at"
  );
  const out: { id: string; path: string; name: string }[] = [];
  for (const r of rows) {
    if (!r || r.deleted_at) continue;                    // 已在回收站 ⇒ 幂等跳过
    if (me.role !== "admin" && r.owner !== me.name) throw new HttpError(403, "无权删除他人文件");
    if (!canWritePath(me, r.path)) throw new HttpError(403, "无权限删除该位置的文件");
    out.push({ id: r.id, path: r.path, name: r.name });
  }
  return out;
}

/**
 * 把若干"文件 id"和/或"目录路径"移入回收站。
 * 返回移入的文件数量。
 */
export async function moveToTrash(
  env: Env,
  me: Principal,
  opts: { fileIds?: string[]; dirPaths?: string[] }
): Promise<number> {
  const now = Date.now();
  const targets: { id: string; path: string; name: string }[] = [];
  const seen = new Set<string>();

  const push = (t: { id: string; path: string; name: string }) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    targets.push(t);
  };

  // ① 按 id 指定的文件
  for (const t of await collectFileRows(env, me, opts.fileIds ?? [])) push(t);

  // ② 按目录路径递归收集其下所有文件
  for (const dirInput of opts.dirPaths ?? []) {
    const dir = normalizePath(dirInput);
    if (!dir || dir === "/") throw new HttpError(400, "不允许删除根目录");
    const top = dir.split("/").filter(Boolean)[0] ?? "";
    if (isSystemDirName(top)) throw new HttpError(403, "系统保留目录不可删除");
    if (!canWritePath(me, dir)) throw new HttpError(403, "无权限删除该目录");

    const prefix = dir + "/";
    // ⚠️ files.path 存的是**父目录路径**（完整路径 = path + "/" + name），所以要覆盖
    //    "dir 里的文件"与"dir 的各级子目录里的文件"两类行。范围扫描而不是 LIKE：
    //    `path >= 'dir/' AND path < 'dir0'` 能走 path 索引（'/'=0x2F < '0'=0x30，
    //    所有以 dir/ 开头的串都落在这个区间里）；用 LIKE 还得处理目录名里的 _ % 转义。
    //    区间会顺带捞到 "/admin/_uitestX" 这种同前缀的兄弟目录，下面再按完整路径过滤一次。
    const rows = await env.db
      .prepare(
        "SELECT id, path, name FROM files WHERE deleted_at IS NULL AND (path = ?1 OR (path >= ?2 AND path < ?3))"
      )
      .bind(dir, prefix, dir + "0")
      .all<{ id: string; path: string; name: string }>();
    for (const r of rows.results ?? []) {
      const full = r.path === "/" ? `/${r.name}` : `${r.path}/${r.name}`;
      if (full === dir || full.startsWith(prefix)) push({ id: r.id, path: r.path, name: r.name });
    }

    // 目录结构行直接移除（还原时按 original_path 重建）
    const allDirs = await env.db.prepare("SELECT path FROM directories").all<{ path: string }>();
    const toDrop = (allDirs.results ?? [])
      .filter((d) => d.path === dir || d.path.startsWith(prefix))
      .map((d) => d.path);
    if (toDrop.length) {
      await batchChunks(env, toDrop.map((p) => ({ q: "DELETE FROM directories WHERE path = ?1", b: [p] })));
    }
  }

  if (targets.length === 0) return 0;

  // 软删除：记录删除者与原路径，供回收站展示与还原
  await batchChunks(
    env,
    targets.map((t) => ({
      q: "UPDATE files SET deleted_at = ?1, deleted_by = ?2, original_path = ?3 WHERE id = ?4",
      b: [now, me.name, t.path, t.id],
    }))
  );
  return targets.length;
}

/* ═══════════ 彻底删除（不可恢复） ═══════════ */

/** 抹掉 rows 指向的文件行（连 shares / direct_links 一起），返回还要删哪些存储对象 */
async function purgeRows(env: Env, ids: string[]): Promise<string[]> {
  const uniq = [...new Set(ids.filter((x) => typeof x === "string" && x))];
  if (!uniq.length) return [];
  const rows = await selectByIds<{ id: string; key: string }>(env, uniq, "id, key");
  const keys = rows.map((r) => r.key).filter(Boolean);
  const stmts: { q: string; b: unknown[] }[] = [];
  for (const id of rows.map((r) => r.id)) {
    stmts.push({ q: "DELETE FROM shares WHERE file_id = ?1", b: [id] });
    stmts.push({ q: "DELETE FROM direct_links WHERE file_id = ?1", b: [id] });
    stmts.push({ q: "DELETE FROM files WHERE id = ?1", b: [id] });
  }
  await batchChunks(env, stmts);
  return keys;
}

/** 彻底删除：连同存储对象一起抹掉（不可恢复），传入"存活"文件 id */
export async function purgeFiles(
  env: Env,
  me: Principal,
  ids: string[]
): Promise<{ purged: number; keys: string[] }> {
  const rows = await collectFileRows(env, me, ids);
  return { purged: rows.length, keys: await purgeRows(env, rows.map((r) => r.id)) };
}

/** 彻底删除：整个目录连同其下所有文件（不可恢复） */
export async function purgeDir(
  env: Env,
  me: Principal,
  dirInput: string
): Promise<{ purged: number; keys: string[] }> {
  const dir = normalizePath(dirInput);
  if (!dir || dir === "/") throw new HttpError(400, "不允许删除根目录");
  const top = dir.split("/").filter(Boolean)[0] ?? "";
  if (isSystemDirName(top)) throw new HttpError(403, "系统保留目录不可删除");
  if (!canWritePath(me, dir)) throw new HttpError(403, "无权限删除该目录");

  const prefix = dir + "/";
  // 同 moveToTrash：path 存父目录，用前缀区间把各级子目录的行一起捞出来（能走索引）
  const rows = await env.db
    .prepare("SELECT id, path, name, owner FROM files WHERE path = ?1 OR (path >= ?2 AND path < ?3)")
    .bind(dir, prefix, dir + "0")
    .all<{ id: string; path: string; name: string; owner: string }>();
  const mine = (rows.results ?? []).filter((r) => {
    // 区间扫描会带进 "/xxx_uitestX" 这类同前缀兄弟目录，按完整路径再卡一道
    const full = r.path === "/" ? `/${r.name}` : `${r.path}/${r.name}`;
    if (full !== dir && !full.startsWith(prefix)) return false;
    if (me.role !== "admin" && r.owner !== me.name) return false;
    if (!canWritePath(me, r.path)) return false;
    return true;
  });
  const keys = await purgeRows(env, mine.map((r) => r.id));

  // 目录结构行一起抹掉（不需要留复原线索 —— 不可恢复就是这个意思）
  const allDirs = await env.db.prepare("SELECT path FROM directories").all<{ path: string }>();
  const toDrop = (allDirs.results ?? [])
    .filter((d) => d.path === dir || d.path.startsWith(prefix))
    .map((d) => d.path);
  if (toDrop.length) {
    await batchChunks(env, toDrop.map((p) => ({ q: "DELETE FROM directories WHERE path = ?1", b: [p] })));
  }
  return { purged: mine.length, keys };
}

/* ═══════════ 回收站 ═══════════ */

export interface TrashEntry {
  id: string;
  name: string;
  size: number;
  mime: string;
  owner: string;
  deleted_at: number;
  deleted_by: string;
  original_path: string;
  /** 距自动彻底删除还剩多少天（向上取整） */
  days_left: number;
}

export async function listTrash(env: Env, me: Principal): Promise<TrashEntry[]> {
  const scope = trashScopeOf(me);
  const res = await env.db
    .prepare(
      `SELECT id, name, size, mime, owner, deleted_at, deleted_by, COALESCE(original_path, path, '/') AS original_path
       FROM files
       WHERE ${scope.where}
       ORDER BY deleted_at DESC`
    )
    .bind(...scope.binds)
    .all<TrashEntry & { deleted_at: number }>();

  const now = Date.now();
  return (res.results ?? []).map((r) => ({
    ...r,
    days_left: Math.max(0, Math.ceil((r.deleted_at + TRASH_TTL_MS - now) / 86_400_000)),
  }));
}

/** 还原：把文件放回 original_path，并按需重建目录结构 */
export async function restoreFromTrash(env: Env, me: Principal, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const scope = trashScopeOf(me);
  let restored = 0;
  const dirsToEnsure = new Set<string>();

  for (const id of ids) {
    const row = await env.db
      .prepare(
        `SELECT id, owner, COALESCE(original_path, path, '/') AS original_path
         FROM files WHERE id = ?1 AND ${scope.where}`
      )
      .bind(id, ...scope.binds)
      .first<{ id: string; owner: string; original_path: string }>();
    if (!row) continue;                       // 不存在或不属于我能还原的范围

    let target = normalizePath(row.original_path) ?? "/";
    // 还原到根目录是不合法的（根目录只放用户文件夹与系统目录）⇒ 落回自己的个人文件夹
    if (target === "/") target = homeDirOf(me);
    if (isSystemDirName(target.split("/").filter(Boolean)[0] ?? "")) target = homeDirOf(me);

    for (const bc of breadcrumbOf(target)) dirsToEnsure.add(bc.path);
    await env.db
      .prepare("UPDATE files SET deleted_at = NULL, deleted_by = NULL, original_path = NULL, path = ?1 WHERE id = ?2")
      .bind(target, id)
      .run();
    restored += 1;
  }

  if (dirsToEnsure.size) {
    await env.db.batch(
      [...dirsToEnsure].map((p) =>
        env.db
          .prepare(
            "INSERT INTO directories(path, created_at, owner, system) VALUES(?1, ?2, ?3, 0) ON CONFLICT(path) DO NOTHING"
          )
          .bind(p, Date.now(), me.name)
      )
    );
  }
  return restored;
}

/** 彻底删除：连同存储对象一起抹掉（不可恢复） */
export async function purgeFromTrash(
  env: Env,
  me: Principal,
  ids: string[]
): Promise<{ purged: number; keys: string[] }> {
  if (!ids.length) return { purged: 0, keys: [] };
  const scope = trashScopeOf(me);

  // 一条 IN 取回"我范围内"的 id/key，替代原来的逐条 round-trip（大批量扫空站会超时）
  const uniq = [...new Set(ids.filter((x) => typeof x === "string" && x))];
  const groups = chunkArr(uniq, BATCH_CHUNK);
  const rows = (
    await mapLimit(groups, BATCH_PARALLEL, async (grp) => {
      const ph = grp.map(() => "?").join(",");
      const r = await env.db
        .prepare(`SELECT id, key FROM files WHERE id IN (${ph}) AND ${scope.where}`)
        .bind(...grp, ...scope.binds)
        .all<{ id: string; key: string }>();
      return r.results ?? [];
    })
  ).flat();
  if (!rows.length) return { purged: 0, keys: [] };

  const okIds = rows.map((r) => r.id);
  const keys = rows.map((r) => r.key).filter(Boolean);
  await batchChunks(
    env,
    okIds.flatMap((id) => [
      { q: "DELETE FROM shares WHERE file_id = ?1", b: [id] as unknown[] },
      { q: "DELETE FROM direct_links WHERE file_id = ?1", b: [id] },
      { q: "DELETE FROM files WHERE id = ?1", b: [id] },
    ])
  );
  return { purged: okIds.length, keys };
}

/**
 * 定时清理：删除进回收站超过 30 天的文件。
 * 返回待删除的存储对象 key，由调用方（scheduled handler）去删存储 ——
 * 保持本模块不直接依赖 storage()，方便复用与测试。
 */
export async function collectExpired(
  env: Env
): Promise<{ ids: string[]; keys: string[] }> {
  const cutoff = Date.now() - TRASH_TTL_MS;
  const res = await env.db
    .prepare("SELECT id, key FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?1")
    .bind(cutoff)
    .all<{ id: string; key: string }>();
  const rows = res.results ?? [];
  if (!rows.length) return { ids: [], keys: [] };

  const ids = rows.map((r) => r.id);
  await batchChunks(
    env,
    ids.flatMap((id) => [
      { q: "DELETE FROM shares WHERE file_id = ?1", b: [id] as unknown[] },
      { q: "DELETE FROM direct_links WHERE file_id = ?1", b: [id] },
      { q: "DELETE FROM files WHERE id = ?1", b: [id] },
    ])
  );
  return { ids, keys: rows.map((r) => r.key) };
}

/* ═══════════ 容量统计（概览页的容量卡片 + 两张饼图）═══════════ */

/** 按扩展名归档到类别 —— 前端拿 key 去查 i18n，不在这里拼中文/英文 */
const TYPE_BY_EXT: Record<string, string> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image",
  avif: "image", svg: "image", heic: "image", tif: "image", tiff: "image", psd: "image",
  nef: "image", cr2: "image", arw: "image", dng: "image", ico: "image",
  mp4: "video", mov: "video", mkv: "video", avi: "video", webm: "video", m4v: "video",
  flv: "video", wmv: "video", mpg: "video",
  // ⚠️ `.ts` 有两种可能：MPEG-TS 视频流 或 TypeScript 源码。归到 video
  //（视频站/网盘里 .ts 更多是流媒体切片）；要改口径只需动这一行。
  ts: "video",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", aac: "audio", ogg: "audio", opus: "audio",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
  bz2: "archive", xz: "archive", iso: "archive", dmg: "archive",
  pdf: "doc", doc: "doc", docx: "doc", xls: "doc", xlsx: "doc", ppt: "doc", pptx: "doc",
  txt: "doc", md: "doc", csv: "doc", json: "doc", xml: "doc", epub: "doc", mobi: "doc", rtf: "doc",
  js: "code", html: "code", css: "code", py: "code", java: "code", c: "code",
  cpp: "code", h: "code", go: "code", rs: "code", sh: "code", sql: "code",
  yml: "code", yaml: "code", toml: "code", ini: "code", conf: "code",
};

/** 类别顺序固定，这样饼图的颜色/顺序在不同时间保持一致（否则颜色会乱跳） */
export const TYPE_ORDER = ["image", "video", "audio", "doc", "archive", "code", "other"];

export function classifyName(name: string): string {
  const i = name.lastIndexOf(".");
  if (i < 0 || i === name.length - 1) return "other";
  const ext = name.slice(i + 1).toLowerCase();
  return TYPE_BY_EXT[ext] || "other";
}

export interface UsageBreakdown {
  /** 配额（字节）。默认 9.95 GB —— 刻意留出余量，避免顶到 R2 免费额度 10 GB */
  quota_bytes: number;
  used_bytes: number;
  file_count: number;
  trash_bytes: number;
  trash_count: number;
  by_owner: { key: string; bytes: number; count: number }[];
  by_type: { key: string; bytes: number; count: number }[];
}

/**
 * 统计用量。刻意**只查一条 SELECT 然后在 JS 里聚合**：
 * 单条语句就能同时得到"按用户"和"按文件类型"两个维度，
 * 比跑两条 GROUP BY 更简单，也不依赖 SQLite 的字符串函数。
 * 个人网盘量级（万级文件）完全扛得住。
 */
export async function storageUsage(env: Env, me: Principal): Promise<UsageBreakdown> {
  const scope = liveScopeOf(me);
  const res = await env.db
    .prepare(`SELECT owner, name, size FROM files WHERE ${scope.where}`)
    .bind(...scope.binds)
    .all<{ owner: string; name: string; size: number }>();
  const rows = res.results ?? [];

  const byOwner = new Map<string, { bytes: number; count: number }>();
  const byType = new Map<string, { bytes: number; count: number }>();
  let used = 0;
  for (const r of rows) {
    const size = Number(r.size) || 0;
    used += size;
    const o = byOwner.get(r.owner) ?? { bytes: 0, count: 0 };
    o.bytes += size; o.count += 1;
    byOwner.set(r.owner, o);
    const t = classifyName(r.name);
    const tv = byType.get(t) ?? { bytes: 0, count: 0 };
    tv.bytes += size; tv.count += 1;
    byType.set(t, tv);
  }

  // 回收站单独统计：它既占配额，又不该混进"在架文件"的饼图里
  const trash = await env.db
    .prepare(`SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS cnt FROM files WHERE ${trashScopeOf(me).where}`)
    .bind(...trashScopeOf(me).binds)
    .first<{ bytes: number; cnt: number }>();

  /**
   * 配额（字节）。默认 9.95 GiB = 10,683,545,600 B ——
   * 用 1024 进制是为了与界面其余地方的文件大小显示口径一致（fmtSize 也是 1024 进制），
   * 这样卡片上正好显示成「9.95 GB」（十进制写法会被显示成 9.27 GB，与预期不符）。
   * 若你希望严格按十进制 GB（10^9）计，把 Worker 变量 storage_quota_bytes 设为 9950000000 即可。
   */
  const quota = Number(env.storage_quota_bytes || 0) || 10_683_545_600;

  return {
    quota_bytes: quota,
    used_bytes: used,
    file_count: rows.length,
    trash_bytes: Number(trash?.bytes || 0),
    trash_count: Number(trash?.cnt || 0),
    by_owner: [...byOwner.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
    by_type: [...byType.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => TYPE_ORDER.indexOf(a.key) - TYPE_ORDER.indexOf(b.key)),
  };
}

/* ═══════════ 重命名 / 移动 ═══════════ */

/** 取父目录：'/a/b' → '/a'；'/a' → '/' */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** 重命名文件（只改显示名，R2 的 key 不动 —— key 一旦变了就得搬对象，没必要） */
export async function renameFile(
  env: Env,
  me: Principal,
  id: string,
  newName: string
): Promise<string> {
  const name = newName.trim();
  if (!isSafeName(name)) throw new HttpError(400, "文件名不合法");
  const f = await env.db
    .prepare("SELECT id, name, path, owner, deleted_at FROM files WHERE id = ?1")
    .bind(id)
    .first<{ id: string; name: string; path: string; owner: string; deleted_at: number | null }>();
  if (!f || f.deleted_at !== null) throw new HttpError(404, "文件不存在");
  if (!canWritePath(me, f.path)) throw new HttpError(403, "无权限修改该文件");
  await env.db.prepare("UPDATE files SET name = ?1 WHERE id = ?2").bind(name, id).run();
  return name;
}

/** 重命名目录：连同其下所有子目录与文件的 path 一起改写 */
export async function renameDir(
  env: Env,
  me: Principal,
  dirInput: string,
  newName: string
): Promise<string> {
  const dir = normalizePath(dirInput);
  if (!dir || dir === "/") throw new HttpError(400, "不能重命名根目录");
  const base = dir.split("/").filter(Boolean).pop() || "";
  if (isSystemDirName(base)) throw new HttpError(403, "系统目录不可重命名");
  if (!canWritePath(me, dir)) throw new HttpError(403, "无权限修改该目录");

  const name = newName.trim();
  if (!isSafeName(name) || isSystemDirName(name)) throw new HttpError(400, "目录名不合法");
  const parent = parentOf(dir);
  const next = joinPath(parent, name);
  if (next === dir) return dir;

  const dup = await env.db.prepare("SELECT 1 FROM directories WHERE path = ?1").bind(next).first();
  if (dup) throw new HttpError(409, "同名目录已存在");

  const oldLen = dir.length;
  await env.db.batch([
    // 目录自身
    env.db.prepare("UPDATE directories SET path = ?1 WHERE path = ?2").bind(next, dir),
    // 后代目录：newPrefix + 原路径的剩余部分（用 substr 而不是 LIKE，避免名字里的 % _ 被当通配符）
    env.db
      .prepare(
        "UPDATE directories SET path = ?1 || substr(path, ?2) WHERE substr(path, 1, ?3) = ?4 AND length(path) > ?3"
      )
      .bind(next, oldLen + 1, oldLen, dir),
    // 直接挂在该目录下的文件
    env.db.prepare("UPDATE files SET path = ?1 WHERE path = ?2").bind(next, dir),
    env.db
      .prepare(
        "UPDATE files SET path = ?1 || substr(path, ?2) WHERE substr(path, 1, ?3) = ?4 AND length(path) > ?3"
      )
      .bind(next, oldLen + 1, oldLen, dir),
  ]);
  return next;
}

/* ═══════════ 移动（文件 / 目录 统一入口）═══════════
 *
 * ── 权限规则（按用户明确要求实现）──────────────────────────
 *   管理员    ：可移动**任意用户**的**任意**文件/目录到**任意**目录 ——
 *               包括跨用户子空间（例如 /alice/x.png → /bob/），不受 owner 限制。
 *   普通用户  ：只能移动**自己个人文件夹内**的条目，且目标也必须在自己的文件夹内。
 *
 * ── 与"移动权限"无关的结构性限制（所有角色一致）──────────
 *   1. 不允许把条目**直接放到根目录 `/`** —— 根目录只容纳用户文件夹与系统目录；
 *   2. `Recycle_Bin` 是派生视图（由 deleted_at 派生），既不能作为来源也不能作为目标，
 *      要还原请走 /api/admin/trash/restore；
 *   3. 目录不能移动进**自己的子树**里（那会把子树从树上摘掉，变成自己的孩子）。
 */

/** 校验"来源"是否可移动 —— 规则本体在 vfs.canMoveSource（纯函数，可单测） */
function assertMovableSource(me: Principal, srcInput: string): string {
  const src = normalizePath(srcInput);
  if (!src || src === "/") throw new HttpError(400, "源路径非法");
  if (!canMoveSource(me, src)) {
    if (rootOf(src) === RECYCLE_BIN_DIR) {
      throw new HttpError(403, "回收站里的内容请用「还原」，不能直接移动");
    }
    throw new HttpError(403, "只能移动自己文件夹里的内容");
  }
  return src;
}

/** 校验"目标目录"是否可写入 —— 规则本体在 vfs.canMoveTarget */
function assertMovableTarget(me: Principal, targetInput: string): string {
  const target = normalizePath(targetInput);
  if (!target) throw new HttpError(400, "目标路径非法");
  if (!canMoveTarget(me, target)) {
    if (target === "/") throw new HttpError(400, "根目录只放用户文件夹，请选择具体目录");
    if (rootOf(target) === RECYCLE_BIN_DIR) throw new HttpError(403, "不能移动到回收站");
    throw new HttpError(403, "只能移动到自己文件夹里");
  }
  return target;
}

/** 目标目录必须真实存在（根目录除外，那里不允许放条目） */
async function assertTargetExists(env: Env, target: string): Promise<void> {
  const ok = await env.db
    .prepare("SELECT 1 FROM directories WHERE path = ?1")
    .bind(target)
    .first();
  if (!ok) throw new HttpError(404, "目标目录不存在");
}

export interface MoveResult {
  files: number;
  dirs: number;
  moved: number;
}

/**
 * 批量移动文件 + 目录到目标目录。
 *
 * 目录移动 = 改写目录自身与**全部后代**的 path（与 renameDir 同一套 SQL 写法：
 * 用 substr 而不是 LIKE，避免名字里的 % _ 被当成通配符）。
 */
export async function moveEntries(
  env: Env,
  me: Principal,
  ids: string[],
  dirPaths: string[],
  targetInput: string
): Promise<MoveResult> {
  const target = assertMovableTarget(me, targetInput);
  await assertTargetExists(env, target);

  let files = 0;
  let dirs = 0;

  for (const id of ids) {
    const f = await env.db
      .prepare("SELECT path, name FROM files WHERE id = ?1 AND deleted_at IS NULL")
      .bind(id)
      .first<{ path: string; name: string }>();
    if (!f) continue;
    assertMovableSource(me, joinPath(f.path, f.name));
    if (f.path === target) continue; // 已在该目录，跳过
    await env.db.prepare("UPDATE files SET path = ?1 WHERE id = ?2").bind(target, id).run();
    files++;
  }

  for (const raw of dirPaths) {
    const src = assertMovableSource(me, raw);
    const base = src.split("/").filter(Boolean).pop() || "";
    if (isSystemDirName(base)) throw new HttpError(403, "系统目录不可移动");
    // 不能把目录移进自己的子树（含自己）
    if (!canMoveDirInto(src, target)) throw new HttpError(400, "不能把文件夹移动到它自己内部");
    if (parentOf(src) === target) continue; // 已在该目录，跳过

    const next = joinPath(target, base);
    const dup = await env.db.prepare("SELECT 1 FROM directories WHERE path = ?1").bind(next).first();
    if (dup) throw new HttpError(409, `目标目录下已存在同名文件夹「${base}」`);

    const oldLen = src.length;
    await env.db.batch([
      env.db.prepare("UPDATE directories SET path = ?1 WHERE path = ?2").bind(next, src),
      env.db
        .prepare(
          "UPDATE directories SET path = ?1 || substr(path, ?2) WHERE substr(path, 1, ?3) = ?4 AND length(path) > ?3"
        )
        .bind(next, oldLen + 1, oldLen, src),
      env.db.prepare("UPDATE files SET path = ?1 WHERE path = ?2").bind(next, src),
      env.db
        .prepare(
          "UPDATE files SET path = ?1 || substr(path, ?2) WHERE substr(path, 1, ?3) = ?4 AND length(path) > ?3"
        )
        .bind(next, oldLen + 1, oldLen, src),
    ]);
    dirs++;
  }

  return { files, dirs, moved: files + dirs };
}
