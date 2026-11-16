"use client";

/**
 * Connectors 目录（M1.4）：产品化的官方远程 MCP 服务器清单。
 *
 * 与「MCP 市场」（官方 Registry 的原始列表）的分工：这里只收录经过验证、
 * 有稳定远程端点的官方 Connector，安装动作与设置页/Registry 市场走同一条
 * saveMcpServer 管道；安装后 connectorId 写进系统层配置，作为反向识别。
 *
 * 目录是前端事实源：sidecar 只透传 connectorId 字符串，不做任何语义判定。
 * 名单刻意小——只上有稳定远程 MCP + OAuth 的官方端点；没有官方远程端点的
 * provider 不进目录（用户可去 MCP 市场手动添加第三方实现）。
 */
import type { McpServerDraft } from "@/lib/mcp/mcp";

export type ConnectorAuth = "oauth" | "header" | "none";

export type ConnectorHeaderField = {
  name: string;
  description?: string;
  /** UI 用密码框，不回显 */
  isSecret: boolean;
};

export type ConnectorCatalogEntry = {
  /** 稳定 id：安装时写进 MCP 配置的 connectorId */
  id: string;
  title: string;
  description: string;
  category: "code" | "docs" | "project" | "chat";
  /** 官方远程 MCP 端点（streamable-http） */
  url: string;
  auth: ConnectorAuth;
  /** header 型必填字段的声明（M1 首批全是 oauth，字段先留协议位） */
  headerSchema?: ConnectorHeaderField[];
  docsUrl?: string;
  /** 官方图标（https）；没有时 UI 回落首字母色块 */
  iconUrl?: string;
  /** 预览提示：连上后能干什么（不锁死工具集，以服务器实际广播为准） */
  toolsPreview?: string[];
  /** 安装时预置的 enabledTools 白名单（授权面收窄；用户可后编辑） */
  enabledTools?: string[];
  /** 服务器自定义名缺省值（冲突时自动加序号） */
  serverName: string;
  /** 安装为系统层（默认）或当前工作区 */
  defaultLayer: "system" | "workspace";
};

/** 首批官方远程 Connector（2026-11 核对 Registry 均为 active/isLatest） */
export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: "linear",
    title: "Linear",
    description:
      "Find and manage issues, projects, and documents in your Linear workspace.",
    category: "project",
    url: "https://mcp.linear.app/mcp",
    auth: "oauth",
    docsUrl: "https://linear.app/docs/mcp",
    iconUrl: "https://static.linear.app/integrations/mcp/icon-256.png",
    toolsPreview: ["issue search", "issue/project updates", "document search"],
    serverName: "linear",
    defaultLayer: "system",
  },
  {
    id: "notion",
    title: "Notion",
    description:
      "Official Notion MCP server: search, read and write pages and databases.",
    category: "docs",
    url: "https://mcp.notion.com/mcp",
    auth: "oauth",
    docsUrl: "https://developers.notion.com/docs/mcp",
    toolsPreview: ["page search", "page/database read", "page/database write"],
    serverName: "notion",
    defaultLayer: "system",
  },
  {
    id: "atlassian",
    title: "Atlassian",
    description:
      "Atlassian Rovo MCP server: Jira and Confluence across your Atlassian sites.",
    category: "project",
    url: "https://mcp.atlassian.com/v2/mcp",
    auth: "oauth",
    docsUrl: "https://support.atlassian.com/rovo/docs/use-atlassian-mcp/",
    toolsPreview: ["Jira issues", "Confluence pages", "Rovo search"],
    serverName: "atlassian",
    defaultLayer: "system",
  },
];

export const CONNECTOR_CATEGORIES: Record<
  ConnectorCatalogEntry["category"],
  string
> = {
  code: "代码",
  docs: "文档",
  project: "项目",
  chat: "沟通",
};

/** Connector 草稿：安装动作复用 saveMcpServer 管道；HTTP + connectorId */
export function connectorDraft(
  entry: ConnectorCatalogEntry,
  layer: "system" | "workspace",
): McpServerDraft {
  return {
    name: entry.serverName,
    transport: "http",
    url: entry.url,
    description: `${entry.title}（Connector）`,
    connectorId: entry.id,
    // 可选工具预置白名单：安装即收窄授权面（用户可在 MCP 管理页编辑）
    ...(entry.enabledTools?.length ? { enabledTools: entry.enabledTools } : {}),
  };
}
