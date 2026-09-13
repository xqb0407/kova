/**
 * MCP 观测审计日志（append-only JSONL）。
 *
 * 连接错误环形缓冲（manager.logs）只在进程内、只记失败；这里补"观测"的缺口：
 * 连接/断开/调用/截断/授权/健康探测事件**全部**记录且跨重启持久，
 * 排查问题不再只能翻 stderr。路径 ~/.xulux/mcp-audit.jsonl（PI_MCP_AUDIT_PATH
 * 可覆盖，测试用）；超上限重写保留最近 MCP_AUDIT_MAX_LINES 条——事件低频，
 * 重写成本可忽略。只记元数据（服务器名/工具名/耗时/错误摘要），不落参数与结果。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { logErr } from "./log";

export type McpAuditKind =
  /** 握手成功（detail 带工具数） */
  | "connect"
  /** 握手失败（needsAuth 也走这条，detail 前缀标记） */
  | "connect_fail"
  /** 断开：空闲回收/LRU 驱逐/配置变更/主动/健康探测失败 */
  | "disconnect"
  /** 工具调用（ok + 耗时；失败带错误摘要） */
  | "call"
  /** 工具数达上限被截断 */
  | "truncate"
  /** OAuth 授权完成 / 取消 */
  | "auth"
  /** keep-alive 健康探测失败（随后 disconnect） */
  | "probe_fail";

export type McpAuditEvent = {
  at: number;
  server: string;
  kind: McpAuditKind;
  ok?: boolean;
  ms?: number;
  detail?: string;
};

export function mcpAuditPath(): string {
  return process.env.PI_MCP_AUDIT_PATH ?? join(homedir(), ".xulux", "mcp-audit.jsonl");
}

/** 保留的事件条数上限 */
export const MCP_AUDIT_MAX_LINES = 2000;

export function recordMcpAudit(ev: McpAuditEvent): void {
  const path = mcpAuditPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 按文件大小粗判是否可能超条数上限（单行 ~300B 足够保守），超了才重写截尾
    if (existsSync(path) && statSync(path).size > MCP_AUDIT_MAX_LINES * 300) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      if (lines.length >= MCP_AUDIT_MAX_LINES) {
        // 给本次 append 留位：重写后正好 MAX 条
        writeFileSync(path, lines.slice(-(MCP_AUDIT_MAX_LINES - 1)).join("\n") + "\n");
      }
    }
    appendFileSync(path, JSON.stringify(ev) + "\n");
  } catch (err) {
    logErr("mcp-audit: 写入失败:", err);
  }
}

/** 读最近事件（时间升序）；server 指定则只回该服务器的 */
export function readMcpAudit(opts: { server?: string; limit?: number } = {}): McpAuditEvent[] {
  const limit = opts.limit ?? 200;
  let raw: string;
  try {
    raw = readFileSync(mcpAuditPath(), "utf8");
  } catch {
    return [];
  }
  const out: McpAuditEvent[] = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as McpAuditEvent;
      if (opts.server && ev.server !== opts.server) continue;
      out.push(ev);
    } catch {
      /* 半行/坏行跳过（append 撕裂容忍） */
    }
  }
  return out.reverse();
}
