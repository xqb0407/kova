/**
 * 飞书开放平台鉴权与「一键创建应用」设备码流程（纯 fetch，无 SDK 依赖）。
 *
 * - 租户 token：POST /open-apis/auth/v3/tenant_access_token/internal，
 *   按 appId+domain 缓存，过期前 60s 刷新。
 * - 一键创建：accounts 域的设备码流程（init → begin → poll）。成功后返回
 *   appId/appSecret/appName，可直接用于长连接与发消息。
 */

export type FeishuDomain = "feishu" | "lark";

const OPEN_BASE: Record<FeishuDomain, string> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
};
const ACCOUNTS_BASE: Record<FeishuDomain, string> = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com",
};

const REQUEST_TIMEOUT_MS = 15_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function readString(r: Record<string, unknown> | null | undefined, key: string): string {
  const v = r?.[key];
  return typeof v === "string" ? v : "";
}
function readNumber(r: Record<string, unknown> | null | undefined, key: string): number | null {
  const v = r?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function readJson(resp: Response): Promise<Record<string, unknown>> {
  if (!resp.ok) throw new Error(`飞书接口 HTTP ${resp.status}`);
  const payload: unknown = await resp.json();
  return isRecord(payload) ? payload : {};
}

/** 网络错误 → 可读文案（undici 的 "fetch failed" 对用户没有信息量） */
function describeFeishuError(e: unknown): Error {
  if (e instanceof Error) {
    if (e.name === "AbortError" || e.name === "TimeoutError") {
      return new Error("飞书接口请求超时");
    }
    if (/fetch failed/i.test(e.message)) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      return new Error(
        `飞书接口请求失败（${cause?.code ?? cause?.message ?? "网络不可达"}）`,
      );
    }
    return e;
  }
  return new Error(String(e));
}

/* ------------------------------ 租户 token ------------------------------ */

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, TokenCacheEntry>();

export async function getTenantAccessToken(input: {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
}): Promise<string> {
  if (!input.appId || !input.appSecret) throw new Error("飞书 App ID / App Secret 为空");
  const key = `${input.domain}:${input.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const requestedAt = Date.now();
  let resp: Response;
  try {
    resp = await fetch(
      `${OPEN_BASE[input.domain]}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch (e: unknown) {
    throw describeFeishuError(e);
  }
  const payload = await readJson(resp);
  const code = readNumber(payload, "code") ?? 0;
  const token = readString(payload, "tenant_access_token");
  if (code !== 0 || !token) {
    throw new Error(
      `飞书鉴权失败：${readString(payload, "msg") || `code=${code}`}`,
    );
  }
  const expireSec = readNumber(payload, "expire") ?? 0;
  if (expireSec > 0) {
    tokenCache.set(key, { token, expiresAt: requestedAt + expireSec * 1000 });
  }
  return token;
}

/** 校验凭据是否可用（手动绑定路径用） */
export async function verifyFeishuCredential(input: {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
}): Promise<void> {
  tokenCache.delete(`${input.domain}:${input.appId}`);
  await getTenantAccessToken(input);
}

export function openApiBase(domain: FeishuDomain): string {
  return OPEN_BASE[domain];
}

/* ------------------------------ 一键创建应用（设备码） ------------------------------ */

const REGISTRATION_PATH = "/oauth/v1/app/registration";

export interface FeishuAppRegistrationBegin {
  deviceCode: string;
  /** 二维码内容（含 user_code 的授权链接） */
  qrUrl: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  pollDomain: FeishuDomain;
}

export type FeishuAppRegistrationPoll =
  | { status: "pending"; interval: number; pollDomain: FeishuDomain }
  | { status: "success"; appId: string; appSecret: string; appName?: string; domain: FeishuDomain }
  | { status: "denied"; message?: string }
  | { status: "expired"; message?: string }
  | { status: "error"; message: string };

async function postRegistration(
  domain: FeishuDomain,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(`${ACCOUNTS_BASE[domain]}${REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    throw describeFeishuError(e);
  }
  return readJson(resp);
}

export async function beginFeishuAppRegistration(): Promise<FeishuAppRegistrationBegin> {
  // 一键创建固定从飞书 accounts 发起；Lark 租户在 poll 阶段按 tenant_brand 切换
  const pollDomain: FeishuDomain = "feishu";
  const init = await postRegistration(pollDomain, { action: "init" });
  const methods = init.supported_auth_methods;
  if (
    Array.isArray(methods) &&
    !methods.includes("client_secret")
  ) {
    throw new Error("当前飞书环境不支持一键创建应用，请手动填写 App ID / App Secret");
  }
  const begin = await postRegistration(pollDomain, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  const deviceCode = readString(begin, "device_code");
  const complete = readString(begin, "verification_uri_complete");
  if (!deviceCode || !complete) {
    throw new Error("飞书未返回设备码，请稍后重试或手动填写凭据");
  }
  let qrUrl = complete;
  try {
    const url = new URL(complete);
    url.searchParams.set("from", "sdk");
    url.searchParams.set("source", "kova-desktop");
    url.searchParams.set("tp", "sdk");
    qrUrl = url.toString();
  } catch {
    // 保留原样
  }
  const interval = readNumber(begin, "interval") ?? 5;
  const expireIn = readNumber(begin, "expire_in") ?? 600;
  return {
    deviceCode,
    qrUrl,
    userCode: readString(begin, "user_code"),
    interval,
    expiresAt: Date.now() + expireIn * 1000,
    pollDomain,
  };
}

export async function pollFeishuAppRegistration(input: {
  deviceCode: string;
  pollDomain: FeishuDomain;
}): Promise<FeishuAppRegistrationPoll> {
  const payload = await postRegistration(input.pollDomain, {
    action: "poll",
    device_code: input.deviceCode,
  });
  const userInfo = isRecord(payload.user_info) ? payload.user_info : null;
  const tenantBrand = readString(userInfo, "tenant_brand");
  if (tenantBrand === "lark" && input.pollDomain !== "lark") {
    // 国际版租户：下一轮改连 larksuite accounts
    return { status: "pending", interval: 0, pollDomain: "lark" };
  }
  const appId = readString(payload, "client_id");
  const appSecret = readString(payload, "client_secret");
  if (appId && appSecret) {
    const app = isRecord(payload.app) ? payload.app : null;
    const appName =
      readString(payload, "app_name") ||
      readString(payload, "client_name") ||
      readString(payload, "name") ||
      readString(app, "app_name") ||
      readString(app, "name");
    return {
      status: "success",
      appId,
      appSecret,
      ...(appName ? { appName } : {}),
      domain: tenantBrand === "lark" ? "lark" : "feishu",
    };
  }
  const error = readString(payload, "error");
  if (!error || error === "authorization_pending") {
    return { status: "pending", interval: 5, pollDomain: input.pollDomain };
  }
  if (error === "slow_down") {
    return { status: "pending", interval: 10, pollDomain: input.pollDomain };
  }
  if (error === "access_denied") {
    return { status: "denied", message: "授权被拒绝" };
  }
  if (error === "expired_token") {
    return { status: "expired", message: "二维码已过期" };
  }
  return {
    status: "error",
    message: `${error}: ${readString(payload, "error_description") || "unknown"}`,
  };
}
