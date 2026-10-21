/**
 * 宿主工具信封 → 密钥注入请求。
 *
 * 两种信封形状都要认：
 * - 旧 Rust 宿主：secretEnv 直挂在信封顶层
 * - Electron hostToolCall：工具参数嵌在 envelope.params 下，secretEnv 在 params 里
 *
 * 只输出名字与 scope；值由宿主解密。模型自己塞的 secretEnv 已在 sidecar 的
 * buildHostToolPayload 里被剥离，这里再做一层名字合法性与条数上限。
 */
export type SecretRequest = { name: string; scope: string };

const MAX_REQUESTS = 32;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readList(envelope: unknown): unknown[] {
  if (!isRecord(envelope)) return [];
  if (Array.isArray(envelope.secretEnv)) return envelope.secretEnv;
  if (isRecord(envelope.params) && Array.isArray(envelope.params.secretEnv)) {
    return envelope.params.secretEnv;
  }
  return [];
}

export function parseSecretRequests(envelope: unknown): SecretRequest[] {
  const list = readList(envelope);
  const out: SecretRequest[] = [];
  for (const item of list.slice(0, MAX_REQUESTS)) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name || !SECRET_NAME_RE.test(name)) continue;
    const scope = typeof item.scope === "string" && item.scope ? item.scope : "global";
    out.push({ name, scope });
  }
  return out;
}

export type McpSecretEnvRequest = {
  /** 子进程里的环境变量名 */
  envName: string;
  /** 密钥库里的名字 */
  name: string;
  scope: "global";
};

/**
 * MCP 子进程的注入请求：非法条目静默丢弃，只接受 global 作用域。
 *
 * 作用域收口在宿主而不是信任 sidecar：MCP 连接池按服务器名跨工作区共享，
 * 工作区作用域的密钥一旦塞进去，就无法回答“这是哪个工作区的值”。
 */
export function parseMcpSecretEnvRequests(raw: unknown): McpSecretEnvRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: McpSecretEnvRequest[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_REQUESTS)) {
    if (!isRecord(item)) continue;
    const envName = typeof item.envName === "string" ? item.envName.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const scope = item.scope === undefined ? "global" : item.scope;
    if (scope !== "global") continue;
    if (envName.length > 128 || name.length > 128) continue;
    if (!SECRET_NAME_RE.test(envName) || !SECRET_NAME_RE.test(name)) continue;
    if (seen.has(envName)) continue;
    seen.add(envName);
    out.push({ envName, name, scope: "global" });
  }
  return out;
}
