# 插件开发指南（从零到面板）

本文说明 Kova 插件是什么、怎么从零做一个（技能型 → 带 MCP 工具 → 带 UI 面板），
以及打包、调试与安全边界。所有结论以本仓（宿主侧）实现为准；面板/MCP 的完整
实况参考在独立插件仓库（目录市场直接指向它）。

- 技能：见第 2 节；插件仓库 `plugins/*/skills/*/SKILL.md` 是真实样例
- 技能 + MCP：插件仓库的 `rea`（8 个工具、零依赖、手写 stdio 协议）→ 第 3 节
- 面板：插件仓库的 `plugins/canvas`（React + Vite 单文件）、`plugins/ui-design`
  （面板 + MCP）→ 第 4 节

---

## 1. 插件模型

### 1.1 一个插件是什么

**一个目录 + 一份清单**（`.kova-plugin/plugin.json`）。目录里按需放五类组件：

| 组件 | 清单字段 | 形态 | 作用 |
| --- | --- | --- | --- |
| 技能 | `skills` | 目录（每个子目录一份 `SKILL.md`） | 给 agent 的可复用方法论，按 `description` 触发 |
| MCP 服务器 | `mcpServers` | JSON 文件（stdio/http 定义） | 给 agent 的工具面（读写外部系统、跑分析…） |
| 面板 | `panels` | `panels.json` + 自包含 HTML | 右侧面板里的交互式 UI，可绑定工作区文档 |
| 钩子 | `hooks` | JSON 文件 | 在 agent 生命周期事件上跑命令（可阻断） |
| 子智能体 | `subagents` | YAML 目录 | 预置的子代理定义（`@` 提及调用） |

清单解析见 `apps/sidecar/pi-agent/src/plugins/manifest.ts`，安装/市场见
`marketplaces.ts`，运行时读模型见 `store.ts`，面板桥协议见
`apps/desktop/lib/plugins/ui-plugin-bridge.ts`。

### 1.2 装载与合并

- 插件安装后被**物化**到应用数据目录 `plugins/cache/<marketplaceId>/<name>/`，
  旁边写 `installed.json`（版本、市场、revision）。链接安装时该目录是指向源码的符号链接。
- 所有组件在合并链里**垫底**：工作区 > 系统 > 插件，同名被遮蔽；整包 enabled 开关
  控制全部组件，组件级开关沿用各子系统已有的状态键。
- 安装/卸载/启停后：技能与子代理热重载、MCP 连接池重建、面板列表与已开面板随之更新。

### 1.3 目录约定

```
my-plugin/
├── .kova-plugin/plugin.json     # 清单（必需）
├── icon.svg                     # 市场与面板列表图标（建议）
├── skills/<skill>/SKILL.md      # 技能
├── .mcp.json                    # MCP 服务器（建议用这个文件名）
├── panels.json                  # 面板声明
├── demo-panel.html              # 面板入口（单文件产物，入库）
├── hooks.json                   # 钩子
├── subagents/*.yml              # 子智能体
└── ui/                          # 面板源码（可选；构建产物要拷到根级）
```

### 1.4 清单字段与校验规则

```json
{
  "name": "my-plugin",
  "displayName": "我的插件",
  "version": "0.1.0",
  "description": "市场卡片上的一句话",
  "author": { "name": "you", "url": "https://example.com" },
  "category": "效率",
  "icon": "icon.svg",
  "keywords": ["demo"],
  "skills": "skills",
  "mcpServers": ".mcp.json",
  "panels": "panels.json",
  "hooks": "hooks.json",
  "subagents": "subagents"
}
```

校验规则：

- **硬错误（装不上）**：找不到清单、JSON 解析失败、顶层不是对象、缺少 `name`、
  `name` 不匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`、`name` 与目录名不一致。
- `displayName`（可选）是界面展示名，**允许中文/空格**；`name` 始终是 ASCII
  稳定标识（pluginId、cache 目录与状态键都靠它）。目录（`marketplace.json`）
  也可以声明 `displayName`，优先级高于插件清单；未声明时市场页会回退读清单。
- **诊断（不阻断安装，但组件会静默为空）**：组件路径为空 / 绝对路径 / 含 `..` /
  逃逸插件根、声明的路径不存在或类型不符、未知字段、生态组件暂不支持。
  所以发布前一定跑一次自检（外部仓库 `node scripts/check.mjs`，或看插件详情里的诊断）。

清单也兼容 `.claude-plugin` / `.codex-plugin` 生态的写法：生态清单里 `skills` 默认
`skills/`、MCP 认根级 `.mcp.json`、hooks 认 `hooks/hooks.json`，面板需显式声明。

---

## 2. 从零开始：技能插件（10 分钟）

技能是成本最低、收益最直接的一类：不写代码，只固化「遇到什么任务、按什么步骤做」。

### 2.1 建目录

```
my-plugin/
├── .kova-plugin/plugin.json
├── icon.svg
└── skills/my-skill/SKILL.md
```

### 2.2 写清单

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "把会议纪要整理成行动项清单",
  "icon": "icon.svg",
  "skills": "skills"
}
```

### 2.3 写 SKILL.md

```markdown
---
name: meeting-actions
description: 把会议纪要整理成「行动项 / 负责人 / 截止时间」表格。当用户说「整理会议纪要」「提炼 TODO」「会后跟进」时使用。
---

# 会议纪要 → 行动项

## 输出格式

| 行动项 | 负责人 | 截止时间 | 来源 |
| --- | --- | --- | --- |

## 规则

1. 只提取明确承诺的动作，推测的不要写。
2. 负责人没提到就写「待定」，不要编名字。
3. 截止时间原文没给就留空，并在表格后列出「需要确认的时间点」。
```

frontmatter 规则（`apps/sidecar/pi-agent/src/skills/docs.ts`）：

- `name` 与 `description` 必填；`description` 决定**什么时候触发**，写触发场景而不是功能清单；
- `name` ≤ 64 字符，`description` ≤ 1024 字符，正文不能为空，整份文件 ≤ 128 KiB；
- 可选 `disable-model-invocation: true`（只允许用户显式调用，不进模型技能目录）。

### 2.4 安装并验证

- 本地开发：插件页 →「添加市场」→ 类型「目录」→ 填仓库路径 → 安装时选
  「链接安装 · 开发」，改文件即时生效（重新开会话/刷新市场即可）。
- 验证：新开会话问一个触发场景的问题，看 agent 是否加载该技能；也可以让它
  `list_plugins` 确认组件已识别。

---

## 3. 加 MCP 工具

MCP 服务器把「agent 能做但普通读写做不到的事」暴露成工具。Kova 用标准 stdio
JSON-RPC（NDJSON，一行一条消息），不要求 MCP SDK。

### 3.1 声明 `.mcp.json`

```json
{
  "mcpServers": {
    "my-tools": {
      "type": "stdio",
      "command": "${BUN}",
      "args": ["run", "${PLUGIN_ROOT}/mcp/server.ts"],
      "env": { "KOVA_WORKSPACE": "${WORKSPACE}" },
      "description": "一句话说明这组工具干什么"
    }
  }
}
```

插件层支持三个占位符（`apps/sidecar/pi-agent/src/mcp/mcp-config.ts`）：

| 占位符 | 展开为 |
| --- | --- |
| `${PLUGIN_ROOT}`（别名 `${CLAUDE_PLUGIN_ROOT}`） | 插件根绝对路径 |
| `${WORKSPACE}` | 当前会话工作区 |
| `${BUN}` | 应用内置 JS/TS 运行时（`process.execPath`），命中时自动加 `BUN_BE_BUN=1` |

用 `${BUN}` 启动 `.ts` 意味着**用户机器不需要装 node/bun**——开发态是 bun，打包态是
sidecar 二进制以 bun 语义运行。占位符缺值时会保留原样并记诊断。

### 3.2 实现协议

必须实现三个方法：`initialize`、`tools/list`、`tools/call`；`ping` 可选。

- stdout **只写协议行**，任何日志/调试输出都走 stderr（否则会污染 JSON-RPC）；
- 通知（没有 `id` 的消息）静默处理；
- `tools/call` 成功返回 `{ content: [{ type: "text", text }] }`，业务失败返回
  `{ content: [...], isError: true }`；协议级错误用 JSON-RPC `error`。

最小可运行骨架（外部仓库 `rea` 插件的 `mcp/server.ts` 是完整实现）：

```ts
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

const workspace = process.env.KOVA_WORKSPACE?.trim() || process.cwd();
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);

const TOOLS = [
  {
    name: "hello",
    description: "返回工作区里某个文件的大小",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "工作区相对路径" } },
      required: ["path"],
    },
    run: async (args: { path: string }) => {
      const abs = isAbsolute(args.path) ? args.path : resolve(workspace, args.path);
      if (!existsSync(abs)) throw new Error(`文件不存在：${args.path}（解析为 ${abs}）`);
      return { path: abs, size: statSync(abs).size };
    },
  },
];

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // 通知
  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "my-tools", version: "0.1.0" },
        instructions: "给 agent 的简短使用说明",
      },
    });
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  } else if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `未知工具 ${params?.name}` } });
      return;
    }
    try {
      const out = await tool.run(params?.arguments ?? {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `错误：${text}` }], isError: true } });
    }
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  try {
    void handle(JSON.parse(text));
  } catch {
    process.stderr.write("忽略无法解析的输入行\n");
  }
});
rl.on("close", () => process.exit(0));
```

### 3.3 工具设计建议

- **只读优先**：能只读就不要写盘；要执行外部命令时用参数数组，不经 shell。
- **限制返回体积**：默认带上限（如 200 行/300 条），并提供 `limit`/过滤参数，
  否则一次调用会把上下文撑爆。
- **路径双轨**：绝对路径与相对工作区都支持，统一在工具层解析一次。
- **错误可操作**：错误信息里给出下一步（拼写候选、可用值、安装指引），不要只抛
  `ENOENT`。
- **幂等**：同一调用重复执行结果一致，便于 agent 重试。
- **依赖最小**：外部命令（如 `objdump`、`git`）缺失时明确报错并给安装方式。

### 3.4 宿主里的调用形态：`mcp` 网关

MCP 工具**不会**作为独立工具注册进模型工具表（保护提示词前缀缓存），而是统一经常驻的
`mcp` 网关调用：

```text
mcp({ action: "search", query: "rea" })                    # 返回全名 rea__rea_analyze
mcp({ action: "describe", tool: "rea__rea_analyze" })      # 看参数 schema
mcp({ action: "call", tool: "rea__rea_analyze",
      args: "{\"path\": \"/bin/ls\"}" })                 # args 是 JSON 字符串
mcp({ action: "status" })                                  # 各服务器连接状态
```

- 全名约定 `<server>__<tool>`：`.mcp.json` 里的 server 名会变成工具前缀，起名要简短，
  不要自带 `__`。
- **连接是懒的**：第一次 `call` 才建立连接。`search` 用「已连接工具 + 上次握手缓存」，
  所以新装插件在首次调用前可能搜不到——插件技能里应写清「可直接按全名 call」。
- 因此技能文档里**不要**写「调用 `my_tool`」这种裸工具名，要写
  `mcp({ action: "call", tool: "my-plugin__my_tool", args: "..." })`，或至少说明
  「经 `mcp` 网关、全名 `<server>__<tool>`」。

### 3.5 信任边界

安装一个带 MCP 的插件 = 在用户机器上以用户权限运行它的代码。宿主只接受标准
MCP 字段（`approveTools` 等 Kova 专属字段不允许插件携带），工具调用仍受宿主的
权限/审批策略约束。开发期先在隔离目录试，不要把未知第三方插件直接装上生产环境。

---

## 4. 加 UI 面板

面板是插件贡献给右侧面板的交互式 HTML。宿主把它挂进 iframe，通过 postMessage
桥与插件通信；插件可以读写绑定到面板的工作区文档。

### 4.1 `panels.json`

```json
[
  {
    "id": "my-panel",
    "title": "我的面板",
    "icon": "icon.svg",
    "entry": "my-panel.html",
    "opens": ["*.mydoc.json"],
    "permissions": ["document", "notify"]
  }
]
```

| 字段 | 说明 |
| --- | --- |
| `id` | 面板 id，`^[a-z0-9][a-z0-9._-]{0,63}$`，同插件内唯一 |
| `title` | 面板标签标题 |
| `icon` | 相对插件根的图标，或 `https://` / `data:` URL |
| `entry` | **自包含单文件 HTML**，相对插件根，必须是 `.html` |
| `opens` | 认领的工作区文件 glob（`*` 不跨 `/`，大小写不敏感） |
| `permissions` | `document` / `export` / `agent` / `notify`，未声明的能力发消息会被丢弃 |

### 4.2 运行模型与约束

- 宿主读取 `entry` 文件 → base64 → `blob:` URL → `<iframe sandbox="allow-scripts">`。
- 这是个**不透明源**的沙箱：`localStorage` / `sessionStorage` 会抛异常，相对路径资源
  加载不到，`document.cookie` 不可用。所有 CSS/JS 必须内联，图标用内联 SVG 或 data URL。
- 入口文件上限 **32 MiB**（`PANEL_ASSET_MAX_BYTES`），超了直接报错。
- **不用自己轮询磁盘**：宿主约每 600ms 读一次绑定文件，内容变了就推
  `doc.open { external: true }`；agent 分段写盘时用户看到的就是「每落一次盘半秒内上屏」。
  面板有未保存改动时的冲突处理在插件侧（弹框让用户选，不静默覆盖）。

### 4.3 桥协议 `kova-ui-plugin/1`

线路是一条可克隆的纯对象：`{ v: "kova-ui-plugin/1", dir: "ui" | "host", kind, ...载荷 }`。
插件发 `dir: "ui"`，宿主回 `dir: "host"`；宿主对入站消息做严格校验，非法消息整条丢弃。

**时序**

```
插件  → 宿主   ui.ready
宿主  → 插件   handshake { theme, context: { workspaceName, fileRelPath } }
插件  → 宿主   doc.request                     （context.fileRelPath 非空时才请求）
宿主  → 插件   doc.open { rev, json, path, external? }
插件  → 宿主   doc.change { json }             （宿主防抖 800ms 写盘）
宿主  → 插件   doc.saved { rev }
```

**宿主 → 插件**

| kind | 载荷 | 说明 |
| --- | --- | --- |
| `handshake` | `theme`, `context` | 握手，`fileRelPath` 为当前绑定文档（可能为 null） |
| `doc.open` | `rev`, `json`, `path`, `external?` | 文档推送；`external=true` 表示盘上内容来自 agent/手改 |
| `doc.saved` | `rev` | 最近一次 `doc.change` 已落盘 |
| `doc.error` | `errorText` | 读盘/写盘失败，或尚未绑定文档 |
| `theme.update` | `theme` | 明暗主题切换 |
| `view.focus` / `view.hidden` | — | 面板可见性变化 |
| `asset.reply` | `reqId`, `base64` | `asset.request` 的回包；读不到为 null |
| `doc.list.reply` | `reqId`, `items` | `doc.list` 的回包（工作区里被 `opens` 认领的文档摘要） |

**插件 → 宿主**

| kind | 权限 | 说明 |
| --- | --- | --- |
| `ui.ready` | — | 脚本就绪，等待 handshake |
| `doc.request` | `document` | 请求当前绑定文档 |
| `doc.change` | `document` | 内容变更（宿主防抖 800ms 写盘） |
| `doc.create` | `document` | 新建并绑定文档；**拒绝覆盖已有文件** |
| `doc.bind` | `document` | 换绑到另一个已有文档（会先落盘未保存内容） |
| `doc.attach` | `document` | 落盘图片等附属资产（`<文档名>-assets/<name>`） |
| `asset.request` | `document` | 读工作区任意文件字节（渲染图片等） |
| `doc.list` | `document` | 列工作区里被 `opens` 认领的文档 |
| `doc.export` | `export` | 导出产物（如 pptx），可带 `silent: true` 批量写 |
| `agent.prefill` | `agent` | 预填会话输入框 |
| `ui.notify` | `notify` | 轻提示 |

**文档语义**

- 文档是**不透明 JSON 字符串**：schema 由插件自己定，宿主只负责读写绑定文件。
- `rev` 是宿主单调计数；保存成功后推送 `doc.saved`，失败推 `doc.error`。
- 宿主 ~600ms 轮询绑定文件；外部（agent/手改）内容变化时推 `doc.open { external: true }`。
  面板若正处在未保存状态，应在插件侧提示冲突，不要静默覆盖用户的编辑。
- 超过大小上限、二进制、损坏的文件会被拒绝加载，避免"截断后保存"损坏原文件。
- 面板换绑/新建文档时，宿主先把未保存内容写回旧文档，再读新文档推送 `doc.open`。
- 新建文档用 `doc.create { path, json }`（拒绝覆盖已有文件）；只是打开已有文档用
  `doc.bind { path }`。

### 4.4 最小面板 HTML

```html
<!doctype html>
<html lang="zh-CN" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <title>我的面板</title>
    <style>
      :root { color-scheme: light; }
      html[data-theme="dark"] { color-scheme: dark; }
      body { margin: 0; padding: 12px; font: 13px -apple-system, "PingFang SC", sans-serif; }
      textarea { width: 100%; height: 200px; box-sizing: border-box; }
    </style>
  </head>
  <body>
    <p id="status">连接中…</p>
    <textarea id="body" placeholder="编辑会实时写回工作区文件"></textarea>
    <script>
      const PROTOCOL = "kova-ui-plugin/1";
      const inHost = window.parent !== window;
      const $ = (id) => document.getElementById(id);
      let docPath = null;
      let data = {};
      let applying = false;
      let timer = null;

      const post = (msg) => {
        if (!inHost) return; // 直开浏览器：不连接宿主
        window.parent.postMessage({ v: PROTOCOL, dir: "ui", ...msg }, "*");
      };

      function applyDoc(json, path) {
        let parsed;
        try { parsed = JSON.parse(json); } catch { return; }
        docPath = path || docPath;
        data = { ...parsed };
        applying = true;
        $("body").value = String(parsed.body ?? "");
        applying = false;
        $("status").textContent = `${path || ""} · 已就绪`;
      }

      function pushChange() {
        if (applying || !docPath) return;
        data = { ...data, body: $("body").value };
        $("status").textContent = "编辑中…";
        clearTimeout(timer);
        timer = setTimeout(() => post({ kind: "doc.change", json: JSON.stringify(data, null, 2) }), 300);
      }

      window.addEventListener("message", (ev) => {
        const d = ev.data;
        if (!d || typeof d !== "object" || d.v !== PROTOCOL || d.dir !== "host") return;
        switch (d.kind) {
          case "handshake":
            document.documentElement.dataset.theme = d.theme === "dark" ? "dark" : "light";
            if (d.context?.fileRelPath) post({ kind: "doc.request" });
            else $("status").textContent = "未绑定文档";
            break;
          case "doc.open":
            applyDoc(d.json, d.path);
            break;
          case "doc.saved":
            $("status").textContent = "已保存";
            break;
          case "doc.error":
            $("status").textContent = d.errorText;
            break;
          case "theme.update":
            document.documentElement.dataset.theme = d.theme === "dark" ? "dark" : "light";
            break;
        }
      });

      $("body").addEventListener("input", pushChange);
      if (inHost) post({ kind: "ui.ready" });
      else $("status").textContent = "独立模式（未连接宿主）";
    </script>
  </body>
</html>
```

完整版见插件仓库 `plugins/canvas/ui/src/bridge.ts`（协议客户端）与
`apps/desktop/components/agent-thread/agent-panel/plugin-panel-host.tsx`（宿主侧）。

### 4.5 面板怎么被打开

四种入口，都是同一个标签页（按 `(pluginId, panelId)` 复用）：

1. 右侧面板「+」菜单里的面板列表；
2. 文件产物卡的「在面板中打开」（按 `opens` glob 匹配）；
3. agent 调 `open_plugin_panel` 工具（参数 `plugin`、`panel`、可选 `path`）；
4. **首次写入自动开板**：agent 第一次 `write`/`edit` 命中某面板的 `opens` glob 时，
   宿主自动打开该面板并绑定文件（每线程每个文件只自动开一次）。后续写盘由宿主
   轮询并推 `doc.open` 刷新，不需要模型记得调用工具。

### 4.6 用 React / Vite 构建（可选）

面板是单文件产物，复杂 UI 推荐用 Vite 的 `vite-plugin-singlefile` 打包，
产物（HTML）**入库**，`panels.json` 的 `entry` 指向它。参考插件仓库的 `plugins/canvas`：

```ts
// ui/vite.config.ts
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: { target: "esnext", cssCodeSplit: false, assetsInlineLimit: 100_000_000 },
});
```

```json
{
  "scripts": {
    "build": "vite build --config ui/vite.config.ts",
    "postbuild": "node -e \"require('node:fs').copyFileSync('ui/dist/index.html','my-panel.html')\"",
    "dev": "vite --config ui/vite.config.ts"
  }
}
```

注意：市场安装是复制整个插件目录，所以别把 `ui/node_modules` 之类提交进仓库。
**根级 HTML 产物必须提交**，否则装到用户机器上就是空白面板。

### 4.7 调试面板

- **直开浏览器**：面板脚本自己检测 `window.parent === window`，合成 mock 握手，
  不依赖桌面端就能调样式。参考插件仓库 `plugins/canvas/ui/src/bridge.ts` 的
  standalone 分支。
- **宿主内调试**：安装插件 → 打开面板 → 开发者工具看 iframe；桥消息在
  `plugin-panel-host.tsx` 的 `decodeUiMessage` 处会丢弃非法消息，先确认
  `v`/`dir`/`kind` 拼写与权限。
- **改动生效**：链接安装下改 HTML 后重开面板即可；改 `panels.json`/清单需要
  刷新市场或重装。

---

## 5. hooks 与子智能体（简）

**hooks.json**：顶层数组，或 Claude 风格的 `{ "hooks": { "事件名": [...] } }` 包装。

```json
[
  { "event": "PreToolUse", "matcher": "bash", "command": "${PLUGIN_ROOT}/hooks/check.sh", "timeoutMs": 5000 }
]
```

- 事件白名单：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、
  `Notification`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`SubagentStop`、`PreCompact`。
- 字段：`event`、`command`、`args`、`matcher`、`timeoutMs`、`shell`、`type`、`enabled`、`name`。
- 命令串支持与 MCP 相同的 `${PLUGIN_ROOT}` / `${WORKSPACE}` / `${BUN}` 占位符；
  运行时另注入 `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PROJECT_DIR` 环境变量。
- 决策语义与手配钩子一致：退出码 2 阻断，stdout 输出 JSON 决定动作
  （同时兼容本项目 `{"decision":"block"}` 与 Claude 的 `hookSpecificOutput`）。
- **钩子在本机直接执行，不经过 bash 工具沙箱**；只应启用可信插件。

**子智能体目录**：`subagents/*.yml`，字段 `name`、`description`、`prompt`、`tools`、
`model`、`maxTurns`，可选 `skills` / `mcpServers` / `knowledge` / `memory`。
插件子智能体在输入框以 `@` 提及调用。

---

## 6. 市场与分发

### 6.1 marketplace.json

一个市场就是「含 `marketplace.json` 的目录」：

```json
{
  "name": "my-plugins",
  "displayName": "我的插件",
  "plugins": [
    { "name": "my-plugin", "source": "./plugins/my-plugin", "version": "0.1.0",
      "description": "一句话说明", "category": "效率", "keywords": ["demo"] }
  ]
}
```

`source` 支持 `"./plugins/x"`、`{ "source": "directory", "path": "./plugins/x" }`、
`{ "source": "./plugins/x" }`，以及 `"./"`（插件根即市场根，单插件仓库）。

条目可选 `icon`（相对插件根/市场根的路径，或 `https:` / `data:` URL）；**省略时
市场卡片回退读插件清单里的 `icon`**。图标归插件所有，不需要在市场清单里重复
声明，安装前也能显示；插件清单也没写 `icon` 时才回落首字母色块。

### 6.2 两种市场

| 类型 | 行为 | 适用 |
| --- | --- | --- |
| 目录 | 直接读本地目录；安装可「链接安装」，缓存指向源码 | 本地开发，改完即生效 |
| Git | 浅克隆到 `plugins/repos/<id>/`；刷新=重新克隆 | 分发；更新需 push → 刷新市场 → 更新插件 |

注意：链接安装只支持目录市场；git 市场是工作副本，改本地不推送远端看不到。

### 6.3 版本与更新

- 插件版本以清单 `version` 为准，市场条目的 `version` 建议保持一致（展示与更新判断）。
- 更新 = 整体替换插件目录，组件级开关保留。
- 改了内容但版本没变也能更新（市场刷新后 revision 变化），但排查问题时先看版本。

### 6.4 分发形态：市场安装（无内置包）

随应用分发的「内置插件包」（仓库 plugins/ 打 zip 嵌进 sidecar 二进制）机制已移除：
插件一律经市场安装——目录市场适合本地开发与私有分发，git 市场适合公开分发。
市场安装直接复制插件目录（或链接安装指向源目录），根级 HTML 与 `mcp/*.ts`
都会被带上，无需任何打包链路。

---

## 7. 排障

| 症状 | 常见原因 | 处理 |
| --- | --- | --- |
| 插件装不上 | 目录名与 `name` 不一致 / 清单缺失或解析失败 / `name` 不合法 | 看插件页诊断；`node scripts/check.mjs`（外部仓库） |
| 装了但组件是空的 | 组件路径写错/不存在（只记诊断，不阻断安装） | 看插件详情诊断；确认路径大小写与目录/文件类型 |
| 技能不触发 | `description` 写成了功能清单，没有触发场景 | 改成「当用户说…时使用」，必要时加关键词 |
| MCP 显示未连接 | 懒连接尚未握手；`command` 不存在、占位符没展开、stdout 被日志污染 | 在 MCP 设置页「插件 MCP」分组或对话连接器面板点「连接」（强制握手）；仍失败再终端手跑 `command + args`，确认 stdout 只有 JSON 行 |
| 工具返回 `错误：…` | 工具内部异常（参数/文件/外部命令） | 错误文本就是原因；缺外部工具时按提示安装 |
| 面板白屏 | 引用了外部资源、HTML 太大、JS 语法错误 | 浏览器直开 HTML；确认入口 < 32 MiB、资源全内联 |
| 面板不自动打开 | 文件名不匹配 `opens`、插件未启用、该文件本轮已自动开过 | 检查 glob（`*` 不跨 `/`）；用「+」菜单或 `open_plugin_panel` |
| 面板改不动文件 | 没声明 `document` 权限 / 没有绑定文档 | 权限加 `document`；先 `doc.create` 或 `doc.bind` |
| 保存不生效 | 内容不是合法 JSON、文件被外部改坏、面板未处理 `doc.saved` | 看 `doc.error` 文本；面板侧加解析容错 |
| 换绑后丢内容 | 面板在 `doc.open` 前改了 `docPath` | 以 `doc.open` 的 `path` 为准，换绑前让宿主先落盘 |

---

## 8. 安全检查清单

- [ ] 清单里所有组件路径在插件根内，没有 `..` 逃逸。
- [ ] 面板 HTML 不引用远程脚本/样式（沙箱下多半加载失败，也会扩大攻击面）。
- [ ] 面板只申请真正需要的权限（四个权限位都最小化）。
- [ ] MCP 工具对输入做边界检查（路径、大小、命令参数数组），不拼接 shell。
- [ ] 插件不执行不可信样本、不自动联网上传工作区内容。
- [ ] hooks 命令的退出码语义与超时都有兜底，不会卡死 agent。
- [ ] 文档/产物写盘前先校验，避免半截 JSON 覆盖用户文件。

---

## 9. 案例拆解：REA 插件

把前面几节落到一个真实插件上（独立插件仓库）：

| 概念 | REA 怎么做 |
| --- | --- |
| 清单 | `name: "rea"`、`skills: "skills"`、`mcpServers: ".mcp.json"`，没有 panels/hooks |
| MCP 进程 | `.mcp.json` 用 `${BUN}` 跑 `${PLUGIN_ROOT}/mcp/server.ts`，把 `${WORKSPACE}` 传成 `KOVA_WORKSPACE` |
| 协议层 | `mcp/server.ts` 只做 NDJSON JSON-RPC 分发（initialize / ping / tools-list / tools-call） |
| 工具层 | `mcp/tools.ts`：8 个工具的参数校验、结果整形、错误文案 |
| 算法层 | `mcp/lib/`：自研 Mach-O/PE/ELF 解析、字符串与 IOC 分类、熵图、字节搜索、objdump 封装 |
| 技能 | `skills/rea/SKILL.md`：固定工作流 + `.rea.json` 报告 schema + 证据规则；工具经 `mcp` 网关以 `rea__*` 调用 |
| 构建 | 无构建：`.ts` 由内置运行时直接执行，源码即产物 |
| 分发 | 市场条目 `source: "./plugins/rea"`；目录市场链接安装开发，git 市场分发 |
| 验证 | 直调工具、JSON-RPC 端到端、真实样本（`/bin/ls`、Chrome dylib）+ 手工 PE/ELF 夹具 |

几个值得抄走的做法：

- **解析失败降级**：`rea_analyze` 把结构解析错误放进 `error` 字段；`strings` /
  `search` / `entropy` 不依赖结构解析，畸形文件仍可分析。
- **外部命令自己兜底**：macOS 的 llvm-objdump 对 Mach-O 会静默忽略地址/符号过滤参数，
  插件改为流式读输出、按 VA 过滤，并在符号不存在时明确失败，而不是交出整节反汇编。
- **符号先查表**：反汇编前用 `--syms` 校验符号名，避免「反汇编整个 `__text` 却假装是
  那个函数」。
- **结果有上限**：列表类工具都带 `limit` 与截断提示；反汇编凑够条数就杀掉子进程。
- **技能写清网关形态**：MCP 工具不直接出现在工具表里，技能里必须写全名
  （`<server>__<tool>`）与 `args` 的 JSON 字符串形式，否则模型会去找不存在的裸工具。

完整的工具参数、返回字段与平台限制见该插件自带的 `README.md`。

---

## 10. 参考实现

实现都在独立插件仓库（目录市场指向它）：

| 插件 | 展示的能力 |
| --- | --- |
| `plugins/rea` | 技能 + 手写 stdio MCP（8 个零依赖工具）、外部命令调用与降级 |
| `plugins/canvas` | React + Vite 单文件面板、完整桥客户端、文档 schema 与增量写盘 |
| `plugins/office` | 一个面板认领多种文档（`opens` 多 glob）、导出产物（`doc.export`） |
| `plugins/ui-design` | 面板 + 插件自带 MCP（与面板共用文档模型）、`${PLUGIN_ROOT}` 启动 |
| `plugins/demo-skill` / `plugins/demo-panel` | 两个最小示例（技能型 / 面板型） |
