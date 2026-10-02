/**
 * OAuth2 HTTP 处理函数 —— 多 Provider 模式
 *
 * 路由:
 *   GET  /oauth/start?provider=xxx          → 重定向到 Provider 授权页
 *   GET  /oauth/callback?code=...&state=...  → Provider 回调
 *   GET  /oauth/session                     → 返回当前 OAuth 会话状态
 *   POST /oauth/logout                      → 清除 OAuth Cookie
 *   GET  /oauth/providers                   → 返回所有启用的 Provider 列表（给分享页渲染按钮）
 *
 * 所有 Provider 配置均来自 D1 的 oauth_providers 表。
 */

import type { Env } from "./types";
import { getSettings } from "./settings";
import { decryptSecret } from "./crypto";
import { createSession } from "./auth";
import {
  getBuiltinProvider,
  BUILTIN_PROVIDERS,
  createOAuthState,
  verifyOAuthState,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  signOAuthSession,
  verifyOAuthSession,
  deriveRedirectUri,
  type OAuthProvider,
} from "./oauth";

/* ═══════════ 从 D1 构造 OAuthProvider ═══════════ */

interface OAuthProviderRow {
  id: string;
  label: string;
  provider_type: string;
  client_id: string;
  client_secret_cipher: string | null;
  scope: string;
  custom_authorize_url: string;
  custom_token_url: string;
  custom_userinfo_url: string;
  custom_token_field: string;
  enabled: number;
}

function rowToProvider(row: OAuthProviderRow): OAuthProvider | null {
  const base = getBuiltinProvider(row.provider_type);
  if (!base) return null;
  if (row.provider_type === "custom") {
    // 自定义 Provider —— 必填所有 URL
    if (!row.custom_authorize_url || !row.custom_token_url || !row.custom_userinfo_url) return null;
    return {
      id: row.provider_type,
      name: row.label || "Custom",
      authorize_url: row.custom_authorize_url,
      token_url: row.custom_token_url,
      userinfo_url: row.custom_userinfo_url,
      default_scope: row.scope || "openid email profile",
      token_field: row.custom_token_field || "access_token",
    };
  }
  return { ...base, default_scope: row.scope || base.default_scope };
}

async function fetchProviderRow(env: Env, dbId: string): Promise<OAuthProviderRow | null> {
  const row = await env.db
    .prepare("SELECT id, label, provider_type, client_id, client_secret_cipher, scope, custom_authorize_url, custom_token_url, custom_userinfo_url, custom_token_field, enabled FROM oauth_providers WHERE id = ?1")
    .bind(dbId)
    .first<OAuthProviderRow>();
  return row ?? null;
}

async function listEnabledProviders(env: Env): Promise<OAuthProviderRow[]> {
  const rows = await env.db
    .prepare("SELECT id, label, provider_type, client_id, client_secret_cipher, scope, custom_authorize_url, custom_token_url, custom_userinfo_url, custom_token_field, enabled FROM oauth_providers WHERE enabled = 1")
    .all<OAuthProviderRow>();
  return rows.results;
}

/* ═══════════ 登录页的 OAuth 按钮（服务端直出）═══════════
 * 为什么在服务端渲染：登录页原本靠前端 fetch /oauth/providers 才有 GitHub 按钮，
 * 一旦那次 fetch 失败（网络抖动 / 插件拦同源请求 / 极端时序）按钮就"凭空消失"，
 * 用户完全没法用 GitHub 登录。改成服务端直出后，登录页 HTML 里就一定带着按钮。
 * 前端脚本仍保留一份（老版本页面 / 缓存页面也能工作），但发现容器里已有按钮就跳过。
 */
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c: string) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]!
  );
}

function providerIcon(type: string): string {
  if (type !== "github") return "";
  return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
}

export interface LoginOAuthButtons {
  html: string;
  count: number;
}

export async function renderLoginOAuthButtons(env: Env): Promise<LoginOAuthButtons> {
  const empty: LoginOAuthButtons = { html: "", count: 0 };
  let settings;
  try {
    settings = await getSettings(env);
  } catch {
    return empty;
  }
  if (!settings.oauthEnabled) return empty;
  let rows: OAuthProviderRow[] = [];
  try {
    rows = await listEnabledProviders(env);
  } catch {
    return empty;
  }
  const buttons = rows
    .filter((r) => r.client_id)
    .map((r) => {
      const p = rowToProvider(r);
      const label = r.label || p?.name || r.provider_type;
      const href = `/oauth/start?provider=${encodeURIComponent(r.id)}&redirect=${encodeURIComponent("/login")}`;
      return `<a class="oauth-btn" href="${escapeHtml(href)}">${providerIcon(r.provider_type)}<span>${escapeHtml("使用 " + label + " 登录")}</span></a>`;
    });
  return { html: buttons.join(""), count: buttons.length };
}

/* ═══════════ GET /oauth/providers —— 分享页用 ═══════════
 * 返回启用中的 Provider 列表（不含敏感信息，只够渲染按钮）。
 * 如果 settings.oauth_enabled=false 则返回空数组。
 */
export async function handleOAuthProviders(req: Request, env: Env): Promise<Response> {
  const settings = await getSettings(env);
  if (!settings.oauthEnabled) return Response.json({ providers: [], enabled: false });
  const rows = await listEnabledProviders(env);
  const origin = new URL(req.url).origin;
  const providers = rows
    .filter((r) => r.client_id) // 没有 client_id 的不能用
    .map((r) => {
      const p = rowToProvider(r);
      return {
        id: r.id,
        label: r.label,
        provider_type: r.provider_type,
        name: p?.name ?? r.provider_type,
        start_url: `/oauth/start?provider=${encodeURIComponent(r.id)}`,
        client_id: r.client_id,
      };
    });
  return Response.json({ providers, enabled: providers.length > 0 });
}

/* ═══════════ GET /oauth/start?provider=<provider_id>&redirect=<path> ═══════════ */
export async function handleOAuthStart(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const providerDbId = url.searchParams.get("provider") || "";
  const redirectTo = url.searchParams.get("redirect") || "/";

  const settings = await getSettings(env);
  if (!settings.oauthEnabled) {
    return Response.json({ error: "oauth_disabled" }, { status: 400 });
  }

  const row = await fetchProviderRow(env, providerDbId);
  if (!row || !row.enabled) {
    return Response.json({ error: "provider_not_found_or_disabled" }, { status: 400 });
  }
  if (!row.client_id) {
    return Response.json({ error: "client_id_missing" }, { status: 500 });
  }

  const provider = rowToProvider(row);
  if (!provider) {
    return Response.json({ error: "provider_broken" }, { status: 500 });
  }

  const redirectUri = deriveRedirectUri(req);
  // state 里存 D1 provider 的 db id，callback 时直接查回完整 provider
  const state = await createOAuthState(env, row.id, redirectUri);
  const authorizeUrl = buildAuthorizeUrl(
    provider,
    row.client_id,
    redirectUri,
    row.scope || provider.default_scope,
    state
  );

  // 把 redirectTo 写进 Cookie
  const cookie = `cd_oauth_redirect=${encodeURIComponent(redirectTo)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`;
  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl,
      "set-cookie": cookie,
    },
  });
}

/* ═══════════ GET /oauth/callback ═══════════ */
export async function handleOAuthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error");
  if (error) {
    return redirectBackWithMsg(req, "oauth_error: " + error);
  }
  if (!code || !state) {
    return redirectBackWithMsg(req, "oauth_missing_code");
  }

  // 1. 校验 state（一次性消费 + TTL）
  const verify = await verifyOAuthState(env, state);
  if (!verify.ok || !verify.provider_id) {
    return redirectBackWithMsg(req, "oauth_state_invalid");
  }

  // 从 state 拿的是 provider_type（github/google...），我们需要回查 Db 里对应的 enabled provider
  // 但 state 存的是 provider_type，可能有多个同类型 provider。我们改用：state 里存 db id
  // 让我们调整 state 里的 provider_id 语义 —— 现在的 createOAuthState 存 provider_type
  // 改为存 db id
  // 但改动 createOAuthState 会影响 state 结构...让我们看看 state 表
  // CREATE TABLE oauth_states(state TEXT, provider_id TEXT, redirect_uri TEXT, expires_at INTEGER)
  // provider_id 现在存的是 provider_type。我们改成存 db id。
  // 但 handleOAuthStart 里已经在 createOAuthState 时用了 provider_type。
  // 让我们改 handleOAuthStart 的调用：createOAuthState(env, providerDbId, redirectUri)
  // 然后这里直接 fetchProviderRow(env, verify.provider_id) 即可
  // （我们已经在 handleOAuthStart 里把 providerDbId 传进去了，看看：）

  // 好，现在 provider_id 字段存的是 D1 里的 provider db id，直接查
  const providerDbId = verify.provider_id;
  const row = await fetchProviderRow(env, providerDbId);
  if (!row) {
    return redirectBackWithMsg(req, "oauth_provider_missing");
  }
  const provider = rowToProvider(row);
  if (!provider) {
    return redirectBackWithMsg(req, "oauth_provider_broken");
  }
  if (!row.client_secret_cipher) {
    return redirectBackWithMsg(req, "oauth_credentials_missing");
  }

  // 2. 解密 Client Secret
  const clientSecret = await decryptSecret(row.client_secret_cipher, env.admin);
  if (!clientSecret) {
    return redirectBackWithMsg(req, "oauth_secret_decrypt_failed");
  }

  // 3. code → access_token
  const redirectUri = verify.redirect_uri!;
  const token = await exchangeCode(provider, code, redirectUri, row.client_id, clientSecret);
  if (!token) {
    return redirectBackWithMsg(req, "oauth_exchange_failed");
  }

  // 4. 拉用户信息
  const user = await fetchUserInfo(provider, token.accessToken);
  if (!user) {
    return redirectBackWithMsg(req, "oauth_userinfo_failed");
  }

  // 4.5 ⛔ 账号白名单 —— 只有名单内的账号可以登录，其他一律踢回登录页。
  //     未配置 oauth_allowed_users 时视为"谁都不许"（fail closed），
  //     避免"忘了配白名单 → 任何人都能登进来"这种最危险的默认值。
  if (!isUserAllowed(env, user)) {
    return redirectBackWithMsg(req, "oauth_account_not_allowed");
  }

  // 5. 发会话 Cookie
  //    除 OAuth 下载会话（cd_oauth，1 小时，供分享页下载）外，
  //    白名单账号**同时签发管理员会话**（cd_admin，7 天）
  //    ⇒ GitHub 登录 = 管理员本人，权限完全等同于密码登录。
  //    这里必须用 SameSite=Lax：回调来自 GitHub 的跨站重定向。
  const { cookie, secure } = await signOAuthSession(env, providerDbId, user.id);
  const adminCookie = await createSession(env, url.protocol === "https:", "Lax");
  const originalRedirect = parseCookie(req.headers.get("cookie"), "cd_oauth_redirect") || "/";

  const setCookieParts: string[] = [cookie, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=3600"];
  if (url.protocol === "https:" && secure) setCookieParts.push("Secure");
  const setCookie = setCookieParts.join("; ");
  const clearRedirect = "cd_oauth_redirect=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

  return new Response(null, {
    status: 302,
    headers: {
      location: originalRedirect,
      // 注意：join(", ") 拼多个 Cookie 在这里是安全的 —— 上面所有 Cookie 都用
      // Max-Age 而非 Expires，值里不会出现逗号。
      "set-cookie": [setCookie, adminCookie, clearRedirect].join(", "),
    },
  });
}

/**
 * OAuth 账号白名单判定。
 *   - `oauth_allowed_users` 按逗号/空格拆分；
 *   - 条目**不含 `@`** → 与账号名（GitHub login）大小写不敏感比对；
 *   - 条目**含 `@`**   → 与邮箱大小写不敏感比对；
 *   - 名单为空 → 一律拒绝（fail closed）。
 */
function isUserAllowed(
  env: Env,
  user: { handle?: string; email?: string }
): boolean {
  const entries = (env.oauth_allowed_users ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return false;
  const handle = (user.handle ?? "").trim().toLowerCase();
  const email = (user.email ?? "").trim().toLowerCase();
  return entries.some((entry) =>
    entry.includes("@") ? entry === email : entry === handle
  );
}

/* ═══════════ GET /oauth/session ═══════════ */
export async function handleOAuthSession(req: Request, env: Env): Promise<Response> {
  const result = await verifyOAuthSession(env, req.headers.get("cookie"));
  if (!result.ok) {
    return Response.json({ authenticated: false });
  }
  // 查 provider 类型用于前端显示
  const row = await fetchProviderRow(env, result.providerId);
  return Response.json({
    authenticated: true,
    provider_db_id: result.providerId,
    provider_type: row?.provider_type ?? "unknown",
    provider_label: row?.label ?? result.providerId,
    user_id: result.userId,
  });
}

/* ═══════════ POST /oauth/logout ═══════════ */
export async function handleOAuthLogout(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const secure = url.protocol === "https:";
  const cookie = `cd_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json",
      "set-cookie": cookie,
      "cache-control": "no-store",
    },
  });
}

/* ═══════════ 辅助函数 ═══════════ */

function parseCookie(header: string | null, name: string): string {
  if (!header) return "";
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`);
  const m = re.exec(header);
  return m ? decodeURIComponent(m[1]) : "";
}

function redirectBackWithMsg(req: Request, msg: string): Response {
  const redirectTo = parseCookie(req.headers.get("cookie"), "cd_oauth_redirect") || "/";
  const url = new URL(redirectTo, "https://localhost");
  url.searchParams.set("oauth_error", msg);
  const setCookie = "cd_oauth_redirect=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  return new Response(null, {
    status: 302,
    headers: {
      location: `${url.pathname}${url.search}`,
      "set-cookie": setCookie,
    },
  });
}
