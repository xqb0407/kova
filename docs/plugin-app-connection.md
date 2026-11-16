# 插件捆绑 MCP 应用 + 连接状态（GitHub 插件起步）

状态：计划（已定稿，待实施）。
前置：插件系统（M1 前已具备，Claude Code 兼容清单）、Connector 治理（M2）、OAuth（`mcp-oauth.ts`）。

## 1. 目标与非目标

**目标**：对齐主流插件形态——插件捆绑 MCP 应用 + 配套技能，安装后在插件详情显示「待连接 / 已连接」，一键授权；首个实例为 GitHub（官方远程 MCP）。

**非目标**：
- 不做宿主侧 worktree / 推送编排 / PR 状态回流 Inbox（后续按需另立）。
- 不做 Connector 目录的 GitHub 条目（插件捆绑 `.mcp.json` 即 MiniMax 的"应用"；目录留给无插件的独立连接场景）。
- 不做安装时静默 OAuth（授权必须用户显式触发，对齐 claude-code#45288 的讨论方向）。
- GitLab/Jira 等其他 provider 不在本期（机制通用，后续照抄一行配置）。

## 2. 事实依据（设计依据，非推测）

| 事实 | 出处 |
|---|---|
| Claude Code 插件 = skills + agents + hooks + **MCP servers** + commands 的打包单元 | [Plugins overview](https://code.claude.com/docs/en/plugins/overview)、[bundle layer 解析](https://www.shiplight.ai/blog/claude-code-plugins) |
| 插件捆绑的远程 MCP server 走标准 MCP OAuth，由 MCP 客户端逐 server 授权 | [Claude Code MCP OAuth](https://www.scalekit.com/blog/claude-code-mcp-oauth)、[TrueFoundry 指南](https://www.truefoundry.com/blog/mcp-authentication-in-claude-code) |
| Claude Code **没有**每插件连接状态；社区 open feature request 要求安装后触发 OAuth | [anthropics/claude-code#45288](https://github.com/anthropics/claude-code/issues/45288) |
| MiniMax 插件 = `plugin.json` + 可选 `mcp.json` + `skills/`；市场拒绝携带凭据的包；截图的"应用 1: GitHub 待连接" = 捆绑 MCP server 的 OAuth 状态提升到插件详情 UI | [MiniMax-Code-Plugins](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/blob/main/README.zh-CN.md)、[提交指南](https://blog.csdn.net/gitblog_00369/article/details/161763273) |
| GitHub 官方远程 MCP：`https://api.githubcopilot.com/mcp/`，推荐 OAuth（无需 PAT），也支持 PAT header；工具覆盖 issues/PR/Actions | [GitHub 官方文档](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/set-up-the-github-mcp-server)、[GitHub Blog](https://github.blog/ai-and-ml/generative-ai/a-practical-guide-on-how-to-use-the-github-mcp-server) |
| Kova 插件层 `.mcp.json` 已支持 `transport: "http"`；`enabledTools`/`connectorId` 等 kova 字段在任意层均可解析 | 本仓 `apps/sidecar/pi-agent/src/mcp/mcp-config.ts`（`transportOf`、kova 字段解析段） |
| Kova MCP 设置页已有每 server `oauthAuthorized` 状态与授权按钮 | 本仓 `apps/desktop/components/settings/components/mcp-settings.tsx` |

结论：三家（Claude Code / MiniMax / Kova 现状）架构同构——**插件捆绑 MCP server，连接由 MCP 客户端逐 server 处理**；MiniMax 多做的只是把连接状态显示在插件详情里。Kova 缺的只有：一个捆绑官方 GitHub 远程 MCP 的插件 + 插件详情的连接状态 UI。

## 3. 设计

### 3.1 GitHub 插件（kova-plugins 仓库）

`plugins/github/` 升级（0.1.0 → 0.2.0）：

- **`.mcp.json`** 新增（与既有 skills 并存）：

```jsonc
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      // kova 扩展字段（插件层同样解析，见 mcp-config.ts）：
      "enabledTools": ["get_*", "list_*", "search_*"],
      "description": "GitHub 官方远程 MCP：issue / PR / Actions / 代码搜索。OAuth 连接，无需 PAT"
    }
  }
}
```

- `enabledTools` 预置**只读**（工具名以 server 实际广播为准，实现时核对）；写工具（建 PR / push files）默认不启用，用户可在 MCP 设置放开。保住「模型自主建 PR」与「用户确认出 PR」（后续阶段）的边界。
- **`skills/github/SKILL.md`** 保留 gh CLI 内容作为本地兜底，开头加"工具优先级"段：优先用 GitHub MCP 工具（已连接时）；未连接时先去 MCP 设置授权 GitHub。
- **新增 `skills/github-workflow/SKILL.md`**：三条工作流模板——① 分析失败的 Actions 日志；② 按 issue 提交最小修复并创建 PR；③ 按已合并 PR 起草发布说明。每条开头写前置（已连接 GitHub、给出 issue/PR 链接）。
- **README** 更新：两种用法（MCP OAuth / 本地 gh CLI）与安全约定。

> 保留 gh 技能的理由：本地无 OAuth 浏览器场景、私有化交付仍可用；两套凭据体系（gh 自管 / mcp-oauth）互不干扰，文档写清即可。

### 3.2 插件详情的连接状态 UI（kova-electron 仓库）

- **数据源**：现有 `pluginServers`（MCP 设置页已在展示）+ 每 server `oauthAuthorized` 状态；**无新协议命令**。
- **插件详情页**（设置 → 插件）新增「应用」区块：列出该插件捆绑的 MCP servers，逐个显示状态徽标与动作：
  - `待连接`：http server 已启用且 `!oauthAuthorized` → 「连接」按钮 = 复用 `authorizeMcpServer`（现有两段式授权流）。
  - `已连接`：`oauthAuthorized` → 「管理」跳 MCP 设置对应条目。
  - `已停用`：server 被用户停用 → 「启用」。
  - stdio 型 bundled server（如 gitlab）：v1 只显示「已启用」，凭据引导走各插件自己的 status 工具/技能（不在本期）。
- **市场卡片**：plugin 条目捆绑 http server 时标「需连接 GitHub」样式（取 server 描述）。
- **安装后引导**（P3，可选）：安装完成的 toast / 详情页顶部给「去连接」入口，对齐 claude-code#45288 的诉求；不做静默授权。
- i18n：zh/en `plugins.app.*`（appName、pending、connected、disabled、connect、manage、needsConnection 等）。

### 3.3 状态语义（统一表）

| 状态 | 判定 | 动作 |
|---|---|---|
| 待连接 | http 已启用 && `!oauthAuthorized` | 连接（OAuth） |
| 已连接 | `oauthAuthorized` | 管理 |
| 已停用 | server disabled | 启用 |
| 不可用 | 授权失败 / 连接错误（保留最近错误文本） | 重试 |

stdio bundled server 本期不参与状态机（显示为「已启用」）。

## 4. 验收清单

1. 市场/目录安装升级后的 `github` 插件 → MCP 设置出现 plugin 层 `github`（http）→ 插件详情显示「待连接」。
2. 点「连接」→ 浏览器 GitHub OAuth → 回到应用显示「已连接」；`oauthAuthorized` 持久化，重启不丢。
3. 会话中：`github-workflow` 三条工作流实跑（读 issue、读 PR checks、起草发布说明）；写工具未放开时 agent 无法建 PR。
4. 用户在 MCP 设置放开写工具后，可按 issue 建最小修复 PR（经 GitHub MCP 的 API 通道，非本地 git push）。
5. 停用/删除插件：server 随插件层卸载/停用；已授权 token 的清理跟随现有 MCP 删除语义。
6. gh 兜底段：未连接 MCP 时按 SKILL.md 走 gh CLI 仍可用。

## 5. 实测点与风险

| 点 | 处理 |
|---|---|
| GitHub 远程 MCP 的 OAuth 是否对普通 GitHub 账号开放（公开预览期策略可能变） | P1 第一步实测；不通则降级 PAT header 变体（`.mcp.json` 用 headers + 用户在设置里填 token，`isSecret` 输入） |
| fine-grained PAT 对远程 server 401 的已知问题 | 文档建议 classic PAT 或 OAuth；OAuth 为主路径 |
| 插件层 http server 的授权按钮路径 | 代码上按 transport 判定应已覆盖 plugin 层，P2 手测确认 |
| 工具名与 `enabledTools` 通配是否匹配 | 以 server 实际广播为准，P1 实测后定预置清单 |
| 同名 server 冲突（用户已手动加过 github） | 安装联动沿用现有 serverName 加序号规则 |
| 插件卸载后已授权 server 的 token 残留 | 跟随现有 MCP 删除语义，P2 验证 |

## 6. 交付物

| 仓库 | 内容 |
|---|---|
| kova-plugins | `plugins/github` 升级：`.mcp.json`（http remote + enabledTools）、`skills/github-workflow/SKILL.md`、`skills/github/SKILL.md` 工具优先级段、README、manifest 0.2.0、marketplace.json 同步 |
| kova-electron | 插件详情「应用」区块 + 状态徽标 + 连接按钮、市场卡「需连接」标记、i18n、（P3）安装后引导 |
| 本仓文档 | 本文件 + `docs/mcp-connectors-acp-plan.md` 后续里程碑条目更新（L2 Checkpoint 冻结说明） |

## 7. 分期

| 期 | 内容 | 退出标准 |
|---|---|---|
| A1 | kova-plugins：GitHub 插件捆绑远程 MCP + 技能 | MCP 设置可连、`oauthAuthorized` 持久化、三条工作流实跑 |
| A2 | kova-electron：插件详情连接状态 UI + 市场标记 | 三态徽标正确；授权动作复用现有流；i18n 完整 |
| A3（可选） | 安装后「去连接」引导 | 装完即见入口；无静默授权 |
