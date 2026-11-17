"use client";

/**
 * Connectors 目录（M1.4）：产品化的官方远程 MCP 服务器清单。
 *
 * 与「MCP 市场」（官方 Registry 的原始列表）的分工：这里只收录经过验证、
 * 有稳定远程端点的官方 Connector，安装动作与设置页/Registry 市场走同一条
 * saveMcpServer 管道；安装后 connectorId 写进系统层配置，作为反向识别。
 *
 * 目录是前端事实源：sidecar 只透传 connectorId 字符串，不做任何语义判定。
 * 名单只收「官方稳定远程端点」：以 OAuth 型为主，个别官方公开端点无需授权；
 * 没有官方远程端点的 provider 不进目录（用户可去 MCP 市场手动添加第三方实现）。
 * 每条 URL 都实际探测过（401/405/握手响应）后才收进名单。
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
  category: "code" | "docs" | "project" | "chat" | "data" | "business" | "automation" | "design";
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

/** 官方远程 Connector（2026-11 逐条实测端点在线；OAuth 型均为标准 MCP 授权） */
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
    iconUrl: "https://www.notion.so/front-static/logo-ios.png",
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
    iconUrl: "https://wac-cdn.atlassian.com/assets/img/favicons/atlassian/favicon.png",
    docsUrl: "https://support.atlassian.com/rovo/docs/use-atlassian-mcp/",
    toolsPreview: ["Jira issues", "Confluence pages", "Rovo search"],
    serverName: "atlassian",
    defaultLayer: "system",
  },
  {
    id: "github",
    title: "GitHub",
    description:
      "Official GitHub MCP server: manage repos, issues, pull requests, and Actions with your GitHub account.",
    category: "code",
    url: "https://api.githubcopilot.com/mcp",
    auth: "oauth",
    iconUrl: "https://github.githubassets.com/favicons/favicon.svg",
    docsUrl: "https://github.com/github/github-mcp-server",
    toolsPreview: ["repo & file read/write", "issues & PRs", "Actions runs"],
    serverName: "github",
    defaultLayer: "system",
  },
  {
    id: "slack",
    title: "Slack",
    description:
      "Official Slack MCP server: read channels, send messages, and catch up on threads in your workspace.",
    category: "chat",
    url: "https://mcp.slack.com/mcp",
    auth: "oauth",
    iconUrl: "https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png",
    toolsPreview: ["channel read", "message send", "thread catch-up"],
    serverName: "slack",
    defaultLayer: "system",
  },
  {
    id: "sentry",
    title: "Sentry",
    description:
      "Official Sentry MCP server: fetch errors and traces, and resolve issues across your Sentry org.",
    category: "code",
    url: "https://mcp.sentry.dev/mcp",
    auth: "oauth",
    iconUrl: "https://sentry-brand.storage.googleapis.com/sentry-logo-black.png",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
    toolsPreview: ["issue/error search", "trace analysis", "resolve issues"],
    serverName: "sentry",
    defaultLayer: "system",
  },
  {
    id: "vercel",
    title: "Vercel",
    description:
      "Official Vercel MCP server: manage projects, deployments, and domains on your Vercel team.",
    category: "code",
    url: "https://mcp.vercel.com",
    auth: "oauth",
    iconUrl: "https://assets.vercel.com/image/upload/q_auto/front/favicon/vercel/apple-touch-icon-180x180.png",
    docsUrl: "https://vercel.com/docs/mcp",
    toolsPreview: ["deployments", "project manage", "logs search"],
    serverName: "vercel",
    defaultLayer: "system",
  },
  {
    id: "supabase",
    title: "Supabase",
    description:
      "Official Supabase MCP server: query tables, manage schemas, and inspect logs for your projects.",
    category: "data",
    url: "https://mcp.supabase.com/mcp",
    auth: "oauth",
    iconUrl: "https://supabase.com/favicon/favicon.ico",
    docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
    toolsPreview: ["SQL query", "schema manage", "logs & advisors"],
    serverName: "supabase",
    defaultLayer: "system",
  },
  {
    id: "stripe",
    title: "Stripe",
    description:
      "Official Stripe MCP server: inspect payments, customers, and balances in your Stripe account.",
    category: "business",
    url: "https://mcp.stripe.com",
    auth: "oauth",
    iconUrl: "https://stripe.com/favicon.ico",
    docsUrl: "https://docs.stripe.com/mcp",
    toolsPreview: ["payment lookup", "customer queries", "balance check"],
    serverName: "stripe",
    defaultLayer: "system",
  },
  {
    id: "asana",
    title: "Asana",
    description:
      "Official Asana MCP server: search tasks, update projects, and post comments in your workspace.",
    category: "project",
    url: "https://mcp.asana.com/mcp",
    auth: "oauth",
    iconUrl: "https://asana.com/favicon.ico",
    docsUrl: "https://developers.asana.com/docs/mcp-server",
    toolsPreview: ["task search", "project updates", "comments"],
    serverName: "asana",
    defaultLayer: "system",
  },
  {
    id: "clickup",
    title: "ClickUp",
    description:
      "Official ClickUp MCP server: search tasks and docs, create items, and update statuses.",
    category: "project",
    url: "https://mcp.clickup.com/mcp",
    auth: "oauth",
    iconUrl: "https://clickup.com/favicon.ico",
    toolsPreview: ["task search", "doc create", "status updates"],
    serverName: "clickup",
    defaultLayer: "system",
  },
  {
    id: "monday",
    title: "monday.com",
    description:
      "Official monday.com MCP server: search boards, update items, and summarize your work.",
    category: "project",
    url: "https://mcp.monday.com/mcp",
    auth: "oauth",
    iconUrl: "https://monday.com/favicon.ico",
    docsUrl: "https://developer.monday.com/mcp",
    toolsPreview: ["board search", "item updates", "work summary"],
    serverName: "monday",
    defaultLayer: "system",
  },
  {
    id: "airtable",
    title: "Airtable",
    description:
      "Official Airtable MCP server: search bases, read and write records, and manage tables.",
    category: "data",
    url: "https://mcp.airtable.com/mcp",
    auth: "oauth",
    iconUrl: "https://airtable.com/favicon.ico",
    toolsPreview: ["base search", "record read/write", "table manage"],
    serverName: "airtable",
    defaultLayer: "system",
  },
  {
    id: "box",
    title: "Box",
    description:
      "Official Box MCP server: search files, read content, and ask questions over your Box content.",
    category: "docs",
    url: "https://mcp.box.com/mcp",
    auth: "oauth",
    iconUrl: "https://www.box.com/apple-touch-icon.png",
    docsUrl: "https://developer.box.com/guides/box-mcp",
    toolsPreview: ["file search", "file read", "AI over content"],
    serverName: "box",
    defaultLayer: "system",
  },
  {
    id: "intercom",
    title: "Intercom",
    description:
      "Official Intercom MCP server: search conversations, reply to customers, and manage tickets.",
    category: "chat",
    url: "https://mcp.intercom.com/mcp",
    auth: "oauth",
    iconUrl: "https://intercom.com/intercom-marketing-site/favicons/favicon-32x32.png",
    toolsPreview: ["conversation search", "ticket manage", "reply"],
    serverName: "intercom",
    defaultLayer: "system",
  },
  {
    id: "paypal",
    title: "PayPal",
    description:
      "Official PayPal MCP server: inspect transactions, disputes, and shipments in your PayPal account.",
    category: "business",
    url: "https://mcp.paypal.com/mcp",
    auth: "oauth",
    iconUrl: "https://www.paypalobjects.com/webstatic/icon/pp258.png",
    docsUrl: "https://developer.paypal.com/tools/mcp-server/",
    toolsPreview: ["transaction search", "dispute manage", "shipment tracking"],
    serverName: "paypal",
    defaultLayer: "system",
  },
  {
    id: "xero",
    title: "Xero",
    description:
      "Official Xero MCP server: check invoices, bills, and account balances in your Xero org.",
    category: "business",
    url: "https://mcp.xero.com/mcp",
    auth: "oauth",
    iconUrl: "https://www.xero.com/favicon.ico",
    docsUrl: "https://developer.xero.com/documentation/mcp",
    toolsPreview: ["invoice lookup", "bill manage", "balance check"],
    serverName: "xero",
    defaultLayer: "system",
  },
  {
    id: "canva",
    title: "Canva",
    description:
      "Official Canva MCP server: search designs, autofill templates, and export assets from Canva.",
    category: "design",
    url: "https://mcp.canva.com/mcp",
    auth: "oauth",
    iconUrl: "https://www.canva.dev/favicon.ico",
    toolsPreview: ["design search", "autofill", "asset export"],
    serverName: "canva",
    defaultLayer: "system",
  },
  {
    id: "zapier",
    title: "Zapier",
    description:
      "Official Zapier MCP: run 8,000+ app actions (Gmail, Sheets, HubSpot…) through one authenticated endpoint.",
    category: "automation",
    url: "https://mcp.zapier.com/api/mcp/mcp",
    auth: "oauth",
    iconUrl: "https://zapier.com/favicon.ico",
    docsUrl: "https://zapier.com/mcp",
    toolsPreview: ["8,000+ app actions", "workflow triggers"],
    serverName: "zapier",
    defaultLayer: "system",
  },
  {
    id: "postman",
    title: "Postman",
    description:
      "Official Postman MCP server: search collections and APIs, and run requests from your Postman workspace.",
    category: "code",
    url: "https://mcp.postman.com/mcp",
    auth: "oauth",
    iconUrl: "https://voyager.postman.com/logo/postman-logo-icon-orange.svg",
    docsUrl: "https://www.postman.com/postman/postman-mcp/",
    toolsPreview: ["collection search", "run request", "API lookup"],
    serverName: "postman",
    defaultLayer: "system",
  },
  {
    id: "gitbook",
    title: "GitBook",
    description:
      "Official GitBook MCP server: search and read docs spaces and pages in your GitBook org.",
    category: "docs",
    url: "https://mcp.gitbook.com/mcp",
    auth: "oauth",
    iconUrl: "https://framerusercontent.com/images/RixubGcwFjRRIx4k36fKy7kV8Y.png",
    docsUrl: "https://gitbook.com/docs/integrations",
    toolsPreview: ["space search", "page read"],
    serverName: "gitbook",
    defaultLayer: "system",
  },
  {
    id: "mslearn",
    title: "Microsoft Learn",
    description:
      "Official Microsoft Learn MCP server: search Microsoft docs, training, and code samples.",
    category: "docs",
    url: "https://learn.microsoft.com/api/mcp",
    auth: "none",
    iconUrl: "https://learn.microsoft.com/apple-touch-icon.png",
    toolsPreview: ["docs search", "training lookup", "code samples"],
    serverName: "microsoft-learn",
    defaultLayer: "system",
  },
  {
    id: "cloudflare-docs",
    title: "Cloudflare Docs",
    description:
      "Official Cloudflare docs MCP server: search Cloudflare developer documentation and examples.",
    category: "docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
    auth: "none",
    iconUrl: "https://www.cloudflare.com/favicon.ico",
    docsUrl: "https://github.com/cloudflare/mcp-server-cloudflare",
    toolsPreview: ["docs search", "code examples"],
    serverName: "cloudflare-docs",
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
  data: "数据",
  business: "业务",
  automation: "自动化",
  design: "设计",
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
