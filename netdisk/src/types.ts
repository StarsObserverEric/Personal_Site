export interface Env {
  r2?: R2Bucket; // ⚠️ 改为可选 —— 当使用 S3 兼容存储时可以不配 R2 binding
  db: D1Database;
  admin: string;
  /** 可选：2FA 恢复密钥（Cloudflare 后台配置）。优先级高于 D1 里的恢复码。 */
  totp_recovery?: string;
  /** 可选：Turnstile sitekey（前端渲染 widget 用）。优先级高于 settings 里的 sitekey_override。 */
  turnstile_sitekey?: string;
  /** 可选：Turnstile secret（后端验证 token 用）。没配则 Turnstile 整体禁用。 */
  turnstile_secret?: string;
  /**
   * 可选：Workers Analytics Engine 数据集绑定。
   * 绑定后每次下载都会写入一条数据点，用于全球分布分析。
   * 没绑定时全球分布 Tab 会降级使用 D1 的 download_logs（只存 country，无经纬度）。
   */
  analytics?: AnalyticsEngineDataset;

  /** 可选：管理员登录用户名。设置后登录需「用户名 + 密码」双字段；未设置则只校验密码（向后兼容）。 */
  admin_username?: string;
  /**
   * 可选：附加管理员账号，一行一组 `用户名:密码`。
   * 权限与主管理员完全等同，但**存储身份仍为主管理员**（见 vfs.ts resolvePrincipal）——
   * 因此用它的会话上传的文件仍落在主管理员个人文件夹，不会在根目录多出一个用户文件夹。
   */
  extra_admins?: string;
  /** 可选：OAuth 允许登录的账号白名单（逗号/空格分隔）。未设置 = 拒绝所有 OAuth 登录（fail closed）。 */
  oauth_allowed_users?: string;
  /** 可选：设为 "true" 时，把 /s/*、/d/*、/market 放行给未登录访客；默认全部需要登录。 */
  allow_public_share?: string;
}

export interface ShareRow {
  /** 分享链接 token（/s/:id） */
  id: string;
  file_id: string;
  created_at: number;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  revoked: number;
  /** 分享访问密码哈希（salt:sha256hex），未设置则为 null */
  password_hash: string | null;
  /** 是否公开到下载市场 */
  is_market?: number;
  /** 市场浏览量 */
  market_views?: number;
  /** 市场标题 */
  market_title?: string | null;
  /** 市场描述 */
  market_desc?: string | null;
}

/**
 * 直链 —— 与分享链接独立的独立表
 * 通过 POST /api/admin/direct-links 独立创建
 * 路由: /d/:id
 */
export interface DirectLinkRow {
  /** 直链 token（/d/:id） */
  id: string;
  file_id: string;
  created_at: number;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  revoked: number;
  /** 可选下载文件名覆盖 */
  download_name: string | null;
  /** 管理员备注 */
  notes: string | null;
}

export interface DirectLinkWithFile extends DirectLinkRow {
  key: string;
  name: string;
  size: number;
  mime: string;
}

export interface FileRow {
  id: string;
  key: string;
  name: string;
  size: number;
  mime: string;
  uploaded_at: number;
  /** 虚拟目录路径，根目录为 "/" */
  path?: string;
}

export interface ShareWithFile extends ShareRow {
  key: string;
  name: string;
  size: number;
  mime: string;
}

export interface BanRow {
  ip: string;
  reason: string;
  banned_at: number;
  expires_at: number | null;
}

export interface LogRow {
  id: number;
  share_id: string;
  file_id: string;
  file_name: string;
  ip: string;
  browser: string;
  os: string;
  country: string;
  bytes: number;
  created_at: number;
}

export interface LoginLogRow {
  id: number;
  /** login | logout | verify_fail | rate_limited */
  action: string;
  ip: string;
  ua: string | null;
  browser: string;
  os: string;
  country: string | null;
  /** success | fail */
  result: string;
  reason: string | null;
  created_at: number;
}
