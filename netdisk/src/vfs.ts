/**
 * 虚拟文件系统（VFS）规则 + 角色权限骨架。
 *
 * 这一层只做**纯规则判断**，不碰数据库、不碰 HTTP —— 便于单测和复用。
 * 目录在存储上仍然是"路径字符串"（files.path / directories.path），
 * 本模块负责回答三个问题：
 *   1. 这个路径合法吗（能否规范化、是否越界）
 *   2. 这个身份能看到 / 能写这个路径吗
 *   3. 这个身份在根目录下应该看到哪几个顶层文件夹
 *
 * ── 目录模型 ──────────────────────────────────────────────
 * 根目录 `/` 下**只允许**出现：
 *   /<用户名>        每个用户一个个人文件夹（当前只有 admin）
 *   /public          公共区（所有登录用户可读）
 *   /Admin_Private   系统保留：仅管理员可见可写，其他人一律 403
 *   /Recycle_Bin     系统保留：回收站视图（不是真实目录，由 deleted_at 派生的查询）
 *
 * 新建文件夹/上传时，路径必须落在自己有权写的位置内，否则拒绝。
 */

import type { Env } from "./types";
import { verifySession } from "./auth";

/* ═══════════ 角色与身份 ═══════════ */

export type Role = "admin" | "user";

export interface Principal {
  /** 账号名。管理员用 admin_username（未配置时回退 'admin'）；普通用户用 OAuth handle */
  name: string;
  role: Role;
}

/** 系统保留目录名（大小写敏感，避免和用户目录混淆） */
export const PUBLIC_DIR = "public";
export const ADMIN_PRIVATE_DIR = "Admin_Private";
export const RECYCLE_BIN_DIR = "Recycle_Bin";

/** 系统保留目录集合 —— 不允许普通用户新建同名目录，也不允许删除/重命名 */
export const SYSTEM_DIRS: readonly string[] = [PUBLIC_DIR, ADMIN_PRIVATE_DIR, RECYCLE_BIN_DIR];

/** 系统保留名（含 Recycle_Bin：它由删除状态派生，不允许真实创建） */
export function isSystemDirName(seg: string): boolean {
  return SYSTEM_DIRS.includes(seg);
}

/* ═══════════ 路径规范化与校验 ═══════════ */

/**
 * 规范化虚拟路径：
 *   - 统一以 / 开头
 *   - 去掉结尾斜杠（根目录除外）
 *   - 折叠连续的 /
 *   - 消解 . 与 ..
 * 若路径试图越出根目录（如 /../x），返回 null 表示非法。
 */
export function normalizePath(input: string): string | null {
  const raw = String(input ?? "").replace(/\\/g, "/").trim();
  if (!raw) return "/";
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // 越界
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/** 取路径的第一段（顶层目录名）。`/a/b` → `a`；`/` → "" */
export function rootOf(path: string): string {
  const seg = path.split("/").filter(Boolean);
  return seg[0] ?? "";
}

/** 路径是否严格位于 dir 之内（或就是 dir 本身）。 */
export function isInside(path: string, dir: string): boolean {
  const a = normalizePath(path);
  const b = normalizePath(dir);
  if (!a || !b) return false;
  if (b === "/") return true; // 根目录包含一切
  return a === b || a.startsWith(b + "/");
}

/** 单个路径段是否安全（目录名/文件名不允许出现的字符） */
export function isSafeSegment(seg: string): boolean {
  if (!seg) return false;
  if (seg === "." || seg === "..") return false;
  if (seg.length > 128) return false;
  // 排除控制字符与 Windows 非法字符，避免后续导出/挂载时出问题
  return !/[\\/:*?"<>|\u0000-\u001f]/.test(seg);
}

/** 校验一个"新建目录/重命名"的名字（只允许单段） */
export function isSafeName(name: string): boolean {
  const n = String(name ?? "").trim();
  return isSafeSegment(n) && n === name.trim();
}

/* ═══════════ 身份解析 ═══════════ */

/**
 * 从请求中解析当前身份。
 *
 * 现状：只有管理员一种身份（密码登录 / GitHub 白名单登录都会签发 cd_admin 会话）。
 * 将来开放多用户时，在这里增加"OAuth 会话 → 普通用户"的解析分支即可，
 * 上层（权限判断、API 过滤）不用改。
 */
export async function resolvePrincipal(req: Request, env: Env): Promise<Principal | null> {
  if (!(await verifySession(req, env))) return null;
  const name = (env.admin_username ?? "").trim() || "admin";
  return { name, role: "admin" };
}

/** 管理员个人文件夹路径 */
export function homeDirOf(principal: Principal): string {
  return "/" + principal.name;
}

/* ═══════════ 权限判断 ═══════════ */

/**
 * 能否读取该路径下的内容。
 *   - 管理员：全部（含 Admin_Private 与 Recycle_Bin）
 *   - 普通用户：自己的个人文件夹 + public
 */
export function canReadPath(p: Principal, path: string): boolean {
  const norm = normalizePath(path);
  if (!norm) return false;
  if (p.role === "admin") return true;

  const top = rootOf(norm);
  if (top === p.name) return true;          // 自己的文件夹
  if (top === PUBLIC_DIR) return true;      // 公共区
  return false;                             // 别人的文件夹 / Admin_Private / Recycle_Bin
}

/**
 * 能否在该路径下写入（上传 / 新建目录 / 改名 / 删除）。
 * 比读更严：普通用户不能写 public（避免互相覆盖），也不能写系统保留目录。
 */
export function canWritePath(p: Principal, path: string): boolean {
  const norm = normalizePath(path);
  if (!norm) return false;
  if (p.role === "admin") {
    // 管理员可写一切，除了回收站本身（回收站是派生视图，不能直接往里放文件）
    return rootOf(norm) !== RECYCLE_BIN_DIR;
  }

  const top = rootOf(norm);
  if (top === PUBLIC_DIR) return false;   // 只读
  if (isSystemDirName(top)) return false; // Admin_Private / Recycle_Bin
  return top === p.name;
}

/* ═══════════ 移动权限 ═══════════
 *
 * 规则（用户明确要求）：
 *   管理员   ：可以移动**任何用户**的**任何**条目到**任何**目录，包括跨用户子空间
 *              （/alice/a.png → /bob/ 是允许的）。
 *   普通用户 ：只能移动**自己个人文件夹内**的条目，且目标也必须在自己文件夹内。
 *
 * 三条与角色无关的结构性限制，写在下面两个判断里各一次：
 *   1. 根目录 `/` 不接受条目 —— 那里只放用户文件夹与系统目录；
 *   2. `Recycle_Bin` 是派生视图，既不能当来源也不能当目标（还原请走 trash/restore）；
 *   3. 目录不能移动进自己的子树（单独由 canMoveDirInto 判断）。
 */
export function canMoveSource(p: Principal, srcInput: string): boolean {
  const src = normalizePath(srcInput);
  if (!src || src === "/") return false;
  if (rootOf(src) === RECYCLE_BIN_DIR) return false;
  if (p.role === "admin") return true;                 // 不限 owner、不限子空间
  return isInside(src, homeDirOf(p));                  // 只能是自己的东西
}

/** 目标目录必须是可写位置（普通用户 = 自己的个人文件夹子树） */
export function canMoveTarget(p: Principal, targetInput: string): boolean {
  const target = normalizePath(targetInput);
  if (!target || target === "/") return false;
  if (rootOf(target) === RECYCLE_BIN_DIR) return false;
  if (p.role === "admin") return true;                 // 可跨用户子空间
  return isInside(target, homeDirOf(p));
}

/** 把 srcDir 挪进 targetDir 是否合法（不能是它自己或它的子孙） */
export function canMoveDirInto(srcDir: string, targetDir: string): boolean {
  const s = normalizePath(srcDir);
  const t = normalizePath(targetDir);
  if (!s || !t || s === "/") return false;
  return !isInside(t, s);
}

/**
 * 该身份在根目录下应该看到哪些顶层文件夹。
 * 管理员：全部用户文件夹 + public + Admin_Private + Recycle_Bin
 * 普通用户：直接进自己的文件夹（根目录不暴露其他人的文件夹）
 */
export function visibleRootDirs(p: Principal, allUserNames: string[]): string[] {
  if (p.role === "admin") {
    const users = Array.from(new Set([p.name, ...allUserNames])).filter(Boolean);
    return [...users, PUBLIC_DIR, ADMIN_PRIVATE_DIR, RECYCLE_BIN_DIR];
  }
  return [p.name, PUBLIC_DIR];
}

/**
 * 普通用户登录后应直接落地的目录（"一进去就是个人文件夹"）。
 * 管理员返回 null 表示停留在根目录。
 */
export function landingDirOf(p: Principal): string | null {
  return p.role === "admin" ? null : homeDirOf(p);
}

/**
 * 回收站可见性：
 *   - 管理员：所有人的删除记录
 *   - 普通用户：只看自己删的
 * 返回可直接拼进 SQL 的条件片段与绑定值。
 */
export function trashScopeOf(p: Principal): { where: string; binds: unknown[] } {
  if (p.role === "admin") return { where: "deleted_at IS NOT NULL", binds: [] };
  return { where: "deleted_at IS NOT NULL AND deleted_by = ?", binds: [p.name] };
}

/** 正常文件（不在回收站）的可见范围条件 */
export function liveScopeOf(p: Principal): { where: string; binds: unknown[] } {
  if (p.role === "admin") return { where: "deleted_at IS NULL", binds: [] };
  return { where: "deleted_at IS NULL AND owner = ?", binds: [p.name] };
}
