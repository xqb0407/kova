# 插件系统设计（plugin）

> 目标：让 Kova 获得 Claude Code 式的插件能力——把既有 skills / subagents / commands /
> hooks / MCP 五类扩展机制**打包为可分发的声明式聚合包**，支持本地安装、启停、卸载，
> P1 接市场（marketplace）。插件不引入任何代码运行时：贡献物的 90% 是 markdown/JSON，
> 仅有的可执行物（hooks 外部命令、MCP 子进程）全部走既有进程边界机制。
> 两条铁律不破——**工具表字节级稳定**（提示词前缀缓存命中）与**审批回路复用**（`tool_confirm`）。

## 1. 背景

### 1.1 底座现状：五类机制已齐四类，且收敛出同一套家族模式

| 机制 | 状态 | 实现 | 来源分层 | 开关存储 |
|---|---|---|---|---|
| Skills | ✅ | `skills.ts`（渐进披露，`<available_skills>` 目录行） | 工作区 `.kova/skills` > 生态·工作区 `.agents/skills` > 系统 > 生态·用户 `~/.agents/skills` | kv `pi.skills` |
| Subagents | ✅ | `subagent-definitions.ts`（YAML + 工具白名单） | 工作区 `.kova/subagents` > 系统（内置最优先） | kv |
| MCP | ✅（P0 已交付，见 mcp-design.md） | `mcp-config.ts` / `mcp-manager.ts` / `mcp-tools.ts`（代理网关） | `~/.kova/mcp.json` < 标准 `<cwd>/.mcp.json` < `<cwd>/.kova/mcp.json` | kv |
| Hooks | ✅ | `hooks.ts`（事件名与 Claude Code 1:1，stdin JSON、exit 2=block） | 仅 kv `pi.hooks`（无文件来源） | kv |
| Slash commands | ❌ | 前端硬编码：`composer-commands.ts` 的 `SLASH_COMMANDS` 仅 7 个面板打开器 | 无 | 无 |

家族模式（插件系统直接继承，不另起炉灶）：

1. **配置事实源在文件，运行态开关在 kv**——工作区文件进 git 共享，个人开关不污染仓库；
2. **管理走 protocol 消息组**——`list_x` / `save_x` / `delete_x` / `set_x_enabled` 同构应答；
3. **热重载统一手法**——`sessions.ts` 的 `reloadSkills()` / `reloadSubagents()`、MCP 连接池 diff；
4. **缓存纪律**——工具表不动（MCP 代理模式），动态提示词块放尾部、无内容时空串兜底。

### 1.2 参照系（含本机实证）

- **Claude Code**：插件 = `.claude-plugin/plugin.json` 清单 + `skills/` `commands/` `agents/`
  `hooks/` `.mcp.json` 子目录；市场 = `marketplace.json` 清单仓库 + 版本化缓存；
  命令 = markdown 模板（`$ARGUMENTS` 占位），不是函数。
- **Codex**：无插件单元，走 `config.toml` + `~/.codex/prompts/*.md` + AGENTS.md 分层——
  启示是"配置即文档"与生态标准格式兼容（本项目已吃下 `.mcp.json` 与 `.agents/skills`）。
- **本机实证**（ZCode 插件缓存，与 Claude Code 同构）：`browser-use/0.4.2/` 内
  `.zcode-plugin/plugin.json`（`{ name, version, description, author, "skills": "skills" }`）、
  根级 `.mcp.json`（document-skills 同款）、缓存侧 `.zcode-plugin-seed.json`
  （`{ hash, marketplace, plugin, pluginVersion, source }` 溯源记录）。

## 2. 关键约束

1. **插件是聚合层，不是新机制**。五类贡献物必须并进既有机制消费，插件只解决
   "打包、分发、一键启停"。机制正交：不用插件也能把文件放进 `.kova/skills/`。
2. **工具表字节级稳定**。插件贡献的 MCP 服务器**强制代理模式**（网关工具 `mcp`
   常驻注册不变）；`directTools` 仅允许用户在工作区覆盖层显式打开（P1），插件层永不。
3. **提示词缓存**。插件不新增系统提示词块——commands 是用户触发、模型无需感知
   （不进提示词，与 skills 的目录块不同）；skills 贡献物并入现有 `skillsPromptBlock`
   动态尾部段，启停走 `reloadSkills()` 热替换，默认提示词字节级不变。
4. **审批回路复用**。插件 MCP 调用走现有 `tool_confirm` + `approveTools` glob；
   hooks 决策语义（exit 2 = block）原样复用；commands 展开即提交普通 prompt，
   不新增任何审批形态。
5. **运行时是 Bun 编译单文件**。插件装载只用 fs/路径 + 既有 `yaml` 依赖，零新依赖。
6. **配置体系既有双层惯例**：系统层 `~/.kova/*`，工作区层 `<cwd>/.kova/*`；
   启停状态落 SQLite kv（`set_subagent_enabled` 模式）。插件安装目录沿用此惯例。
7. **hooks 现状是 kv 全量数组**（`setHookConfigs` 全量覆盖）。插件贡献 hooks 需要
   把 hooks 改为"来源合并视图"——这是全计划唯一动既有语义的改造点，
   独立为 PR4（§10），不与读取层混交。

## 3. 方案选型

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 声明式聚合包：`plugin.json` 清单 + 五类贡献物子目录，并进既有机制 | 无代码运行时，安装=拷贝+校验 | **采用** |
| B. 代码扩展 API（宿主 extension points，插件加载 TS/Rust 动态库，pi.extensions 式） | 宿主需暴露稳定 API | 否决：`pi-agent-core` 无宿主 API；Bun `--compile` 单文件无动态加载；安全面爆炸 |
| C. 纯目录约定不做聚合（五机制各自多一层目录） | 零清单 | 否决：安装/启停/分发体验割裂，设置页五处开关，无法一键启停 |
| D. 一切皆 MCP（插件 = MCP server） | 只扩工具 | 否决：skills/commands/hooks 的价值恰在工具之外 |
| E. 直接兼容 Claude Code `.claude-plugin` 格式为事实源 | 零迁移成本 | 否决为 v1 事实源；**P2 做只读兼容层**（字段高度重合，见 §12） |

## 4. 插件包格式

### 4.1 目录结构与清单

```
<plugin>/
  .kova-plugin/
    plugin.json            ← 清单（必需）
    seed.json              ← 安装溯源（安装器写入；源码目录中不存在）
  skills/<name>/SKILL.md   ← → skills 机制（可选）
  agents/*.yaml            ← → subagents 机制（可选）
  commands/*.md            ← → commands 机制（可选）
  hooks/hooks.json         ← → hooks 机制（可选）
  .mcp.json                ← → MCP 配置合并（可选，仅标准字段）
```

```jsonc
{
  "name": "team-workflow",           // [a-z0-9][a-z0-9-]{0,63}，必须与安装目录名一致
  "version": "0.3.1",                // semver 宽松校验
  "description": "…",
  "author": { "name": "…" },
  // 目录指针全部可省略，缺省按约定目录发现；指向不存在目录 = 该类贡献物为空
  "skills": "skills",
  "agents": "agents",
  "commands": "commands",
  "hooks": "hooks/hooks.json",
  "mcp": ".mcp.json"
}
```

### 4.2 安装布局与 seed

| 层 | 路径 | P0 | 语义 |
|---|---|---|---|
| 系统层 | `~/.kova/plugins/<name>/` | ✅ 安装目标（install = 目录拷贝） | 机器级 |
| 工作区层 | `<cwd>/.kova/plugins/<name>/` | P1 只读发现 | 随仓库共享的团队插件，git 直接管理，不装不卸只认 |

- **seed.json**（照抄 ZCode 缓存实证）：`{ hash, source, installedAt }`，
  hash = 插件树内容 SHA256（排除 seed 自身），update/诊断/未来市场对账用。
- **上限**（沿用家族风格）：插件总数 ≤ 16；单插件 skills/commands/agents 各 ≤ 64、
  hooks ≤ 32、MCP 服务器 ≤ 16（MCP 服务器同时受现有全局 ≤32 约束）；
  单文件 ≤ 128KB（同 `MAX_SKILL_BYTES`）。
- **校验规则**：name 与目录名一致；目录指针 resolve 后不得越出插件根（禁 `..`）；
  hooks.json 逐条过 hooks.ts 现行校验（event 白名单 / timeout 钳制 / matcher）；
  `.mcp.json` 仅认标准字段 `command/args/env/url/headers/type`（kova 专属字段
  `lifecycle/approveTools` 等在插件层**不生效**——生命周期策略属于宿主用户）。

### 4.3 启停状态（kv，不入插件文件）

```
pi.plugins = { "disabled": { "<name>": true } }        // 插件整包开关
```

- 插件禁用 = 其全部贡献物从各机制的合并视图中消失（skills 连目录行都不出现、
  commands 不进 `/` 菜单、hooks 不进合并视图、MCP 服务器断连、agents 不可寻址）；
- skills 的单技能覆盖沿用现有 `pi.skills`（新 stateKey 形态见 §5.1），
  卸载插件时清理其全部 kv 残留。

## 5. 贡献物落点（逐机制映射）

### 5.1 Skills —— 新增 scope `"plugin"`

- `SkillScope` 增加 `"plugin"`；`ensureSkillsLoaded()` 在全局两层之外追加
  逐插件 `loadSkillLayer(<plugin>/skills, "plugin")`（目录树签名缓存同款，
  每插件过 `MAX_PER_LAYER` 上限）。
- 合并遮蔽顺序（先见者胜）：**工作区 > 生态·工作区 > 插件 > 系统 > 生态·用户**。
  跨插件同名：按插件目录名字典序，先者胜，落 diagnostics（可诊断优于隐藏）。
- stateKey：`plugin:<pluginName>:<normName>`（`skillStateKey` 扩展）；
  设置页中插件技能 `editable: false`（只读，更新 = 重装），可单独开关。
- 启停插件后 `sessions.reloadSkills()` 热替换，现有手法零改动。

### 5.2 Subagents —— 新增 scope `"plugin"`

- `subagent-definitions.ts` 装载路径追加逐插件 `agents/*.yaml`（既有 YAML schema
  与工具白名单原样复用，白名单仍限于 bash/read/write/edit/glob/grep）。
- 遮蔽顺序按现行链插入：**内置 > 工作区 > 插件 > 系统**（以
  `subagent-definitions.ts` 实际顺序为准）。
- 插件 agent 只读、开关跟随插件整包；Task 寻址 v1 用裸名（同名冲突见 §11）。

### 5.3 Commands —— 新机制（PR1，先行交付，可独立上线）

**定位**：命令 = 用户显式触发的 prompt 模板（Claude Code `/command` 同款），
sidecar 确定性展开，**不进系统提示词、不动工具表、模型无需感知**。
与 skills 的分工：skills 是"模型自主决定何时用的知识"，commands 是"用户点名要跑的流程"。

- **来源分层**（同名先者胜）：工作区 `<cwd>/.kova/commands/*.md`（可编辑）>
  插件 `commands/*.md`（只读）> 系统 `<app_data>/commands/*.md`（可编辑，
  解析同 `systemSkillsDir()`：PI_DB_PATH 同级推导，兜底 `~/.kova/commands`，
  测试经 `PI_COMMANDS_DIR` 钉住）。
- **文件格式**：YAML frontmatter + 正文。
  ```markdown
  ---
  name: review                    # 缺省文件名兜底
  description: 对当前改动做一次对抗性审查   # 必填，/ 菜单据此展示
  argument-hint: "[关注点]"        # 可选，输入框占位提示
  ---
  请对未提交的改动做对抗性审查，重点关注：$ARGUMENTS
  第 1 个参数：$1；第 2 个参数：$2
  ```
- **占位符**：`$ARGUMENTS` = 芯片后的全部文本；`$1`..`$9` = 空白分词的定位参数
  （缺省空串）。v1 明确不做 shell 预处理（`` !`cmd` ``）与 `@file` 引用（见 §11）。
- **新模块 `commands.ts`**（对齐 skills.ts 结构）：分层装载 + 目录签名缓存 +
  kv `pi.commands` 开关（控制菜单可见性）+ `parseCommandDoc` / `renderCommandDoc`
  / `saveCommandDoc` / `deleteCommandDoc`（写路径仅系统/工作区两层；PR1 无协议
  入口与 UI，仅供单测驱动，P1 设置编辑器复用）+
  `expandCommand(name, argsText, cwd)`：未知命令/被禁用/被遮蔽 → 抛错。
- **执行链路**（复用 prompt 全生命周期，不新造消息、不改 prompt 消息结构）：
  1. 前端 `/` 菜单选中命令 → 输入框插入芯片 `:command[名]{name=command:id}`
     （语法同 skill 芯片，芯片本就是进 prompt 的纯文本），用户在芯片后补参数；
  2. sidecar `dispatchPrompt`（`protocol.ts:666`，msg 本就是
     `Record<string, unknown>` 宽类型）**在队列判定之前**解析文本：
     trim 后以 `:command[...]` 芯片开头才触发——剥离芯片、芯片后文本为 args、
     `expandCommand()` 用展开结果替换 `msg.text`。替换发生在 `enqueueTurn` /
     steer 注入之前，排队重放与并发注入拿到的都是展开后文本，随后走既有
     队列/steer/审批流，一行不改；展开失败 → error chunk，不入队；
     芯片不在开头（防误伤普通文本）按原文提交。
  3. 曾考虑「前端剥离 + `prompt.command` 显式字段」：需动 `pi-transport`
     发送路径与远程 WS 链路，收益为零——否决。sidecar 侧解析对远程链路
     自动生效，前端改动只剩菜单与芯片插入（与 skill/tool 芯片同款）。
  4. 会话转录保存的是展开后文本（UI 气泡仍显示用户原文含芯片），与现有
     prompt 文本落盘行为一致。

### 5.4 Hooks —— kv 单源改为"来源合并视图"（整体落在 PR4）

> 本节是全计划**唯一直接改动既有语义**的部分（`runHooks` 的配置来源），
> 独立成 PR4（§10），不与读取层混在一起。PR2 的插件读取层只发现并展示
> 插件 hooks 条目（设置页计数），引擎不消费——PR4 落地前插件 hooks.json 静默
> 不生效（diagnostics 提示"待 hooks 并网后生效"）。

- 现状：`pi.hooks` kv 全量数组，`setHookConfigs()` 全量覆盖，引擎直接消费。
  引擎入口收敛在 `runHooks()` → `matchingHooks(event, toolName)` 单一 getter
  （`hooks.ts:210`），改造收敛于 hooks.ts 单文件内部。
- 改造：`listHooks()` = **用户段（kv）∪ 启用插件的 `hooks/hooks.json`**；
  `setHookConfigs()` 语义收窄为只写用户段；执行引擎（PreToolUse /
  PermissionRequest 等全部事件）改为迭代合并视图。
- 插件 hook 条目：id 由安装器固定为 `plugin:<name>:<idx>`（只读、不可单独编辑，
  开关跟随插件整包）；校验/超时钳制/决策语义与用户 hook 完全一致，
  无 shell 注入路径的约束（stdin JSON、`type: "process"` 推荐）原样适用。
- 设置页钩子清单加来源徽章（用户 / `<插件名>`），`set_hooks` 消息协议不变。

### 5.5 MCP —— 插件层并入配置合并

- `mcp-config.ts` 合并链（低 → 高）追加最低层：**插件层（各启用插件 `.mcp.json`
  按服务器 id 合并）< 系统层 `~/.kova/mcp.json` < 工作区标准层 < 工作区覆盖层**。
  插件是"打包默认值"，宿主用户任何一层配置都可覆盖。
- 插件服务器**不单独开关**（跟插件整包）；禁用插件 → manager 按现配置 diff
  连接池断连（现有热重载路径）。设置页 MCP 清单加插件来源徽章。
- 缓存/审批/输出防护/代理网关全部零改动；插件层无 kova 专属字段。
- **插件自带 stdio server 的路径与运行时**（已交付）：插件层 `command`/`args`/`env` 的字符串值
  支持三个占位符**展开**（其余层不做任何展开，用户配置保持字面量）：
  `${PLUGIN_ROOT}`（插件根绝对路径）、`${WORKSPACE}`（当前会话工作区，供 server 解析工作区相对路径）、
  `${BUN}`（应用内置 JS/TS 运行时 = `process.execPath`，并自动补 `BUN_BE_BUN=1`——开发态是 bun、
  打包态是 pi-agent 二进制本身，编译态二进制由此充当完整 bun CLI）。插件因此可自带 stdio MCP
  server 脚本，**不要求用户机器预装 node/bun**；展开值参与配置哈希，应用升级/工作区切换后连接自动重建。
  参考实现：`plugins/ui-design/.mcp.json` + `mcp/server.ts`（画布控制面）。

## 6. 协议消息（对齐 subagents/MCP 消息组风格）

```
{ "type": "list_plugins", "id", "cwd"? }
  → { id, "plugins", plugins, workspaceCwd, diagnostics }
  // plugin = { name, version, description, author, source, hash, enabled,
  //           contributions: { skills: n, commands: n, agents: n, hooks: n, mcpServers: n },
  //           skills?, commands?, agents?, hooks?, mcpServers? }   // 详情数组按需（详情页展开再填）

{ "type": "set_plugin_enabled", "id", "name", "enabled", "cwd"? }
  → kv 落盘 + 五机制热重载（reloadSkills/reloadSubagents/MCP diff/hooks 视图）
  → 同款 plugins 应答

{ "type": "install_plugin", "id", "path", "cwd"? }
  → 校验清单（name/目录名一致、指针不越根、上限）→ 拷贝至 ~/.kova/plugins/<name>/
  → 写 seed.json（hash=树 SHA256）→ 热重载 → plugins 应答
  // 已存在同名 → error（覆盖须 uninstall 后重装，armed 确认在前端）

{ "type": "uninstall_plugin", "id", "name", "cwd"? }
  → 删目录 + 清 kv 残留（pi.plugins 条目、pi.skills 的 plugin:<name>:* 键）
  → 五机制热重载 → plugins 应答

{ "type": "list_commands", "id", "cwd"? }   → { id, "commands", commands, workspaceCwd, diagnostics }
// save_command / delete_command 推 P1（v1 命令编辑直接改文件，无设置编辑器）

// prompt 消息结构不变：命令芯片是 prompt 文本的一部分，sidecar 在
// dispatchPrompt 开头解析展开（见 §5.3），桌面与远程 WS 链路零改动。
```

## 7. 前端配合

- **`lib/plugins.ts`**：`usePlugins()`（list_plugins 拉取 + 启停/安装/卸载 mutation），
  克隆 `lib/skills.ts` 模式。
- **`lib/commands.ts`**：`useCommands(workspace)`，供 `/` 菜单（命令设置编辑器推
  P1，v1 编辑直接改文件）。
- **设置页 `settings/components/plugins-settings.tsx`**（PR2 列表/启停/详情，
  PR3 安装/卸载）：克隆 subagents-settings 骨架——
  插件行（名称、版本、来源徽章、启停开关、贡献物计数徽章 `N skills · M commands ·
  K mcp`）+ 行菜单（卸载，armed 二次确认）+ 详情展开（五类贡献物只读清单，技能条目
  显示单独开关）+ 「从文件夹安装」按钮（选择目录 → **安装披露卡**：列出将新增的
  MCP 服务器与 hooks 数量，确认才提交）。注册进 `settings-page.tsx`
  （section id `"plugins"`，icon `PackageIcon`）与 `lib/settings-search.ts` 索引。
- **`composer-commands.ts`**：`/` 菜单新增第四分类 commands（动态来自
  `useCommands`，仅 enabled 且未被遮蔽项）；现有静态面板命令保留为内置命令。
  芯片插入由 `cm-composer-input.tsx` 的 `selectItemOverride` 接管（skill/tool 同款）。
- **`pi-transport.ts` 零改动**：命令芯片是 prompt 文本的一部分，sidecar 侧解析
  （§5.3），桌面 `invoke("pi_prompt")` 与远程 WS 链路均无需感知命令的存在。
- **i18n**：键集中在 `settings.plugins*` / `extensions.plugins*` 命名空间，中英同步。

## 8. 安全设计

| 项 | 决策 |
|---|---|
| 代码执行面 | 插件永不加载代码进宿主；可执行物仅 hooks（外部子进程，stdin JSON）与 MCP（stdio 子进程，SDK 白名单环境）——均复用既有进程边界与校验 |
| 安装披露 | 安装卡明示"将新增 N 个 MCP 服务器、M 个 hooks（可执行）"，把风险决策前置到安装时刻 |
| hooks 约束 | 事件白名单 / timeout 钳制 / matcher 校验与用户 hook 同款；插件 hook 不可编辑；决策语义（exit 2 = block）不变 |
| 路径安全 | name 与目录名一致；目录指针 resolve 后不得越出插件根；安装源路径由用户显式选择 |
| 第三方内容 | 插件 skills/commands 是不可信文档——与生态技能目录 `.agents/skills` 同一信任级别与口径，不额外加提示词警示（沿用现有惯例） |
| 审批 | 插件 MCP 逐次走 `tool_confirm`；commands 展开即普通 prompt，工具审批照常逐次发生，命令不提供任何免审批通道 |
| 卸载清理 | 删目录 + 清 kv 残留（含 pi.skills 的 plugin 键），避免幽灵开关 |

## 9. 测试要点（sidecar bun test）

1. **plugin-loader**（PR2/PR3）：清单校验（name/目录名一致、指针越根、缺目录=空贡献、
   上限）、seed hash 稳定性、禁用插件的贡献物从合并视图消失。
2. **commands**（PR1）：装载（frontmatter 校验/同名遮蔽/kv 开关）、`expandCommand`
   （`$ARGUMENTS`、`$1..$9` 缺省空串、未知命令、禁用命令、遮蔽顺序）。
3. **各机制并网**（PR2，hooks 项 PR4）：skills 五层遮蔽顺序（含跨插件字典序）、
   subagents 遮蔽插入、hooks 合并视图（用户+插件、插件禁用即消失、set_hooks 只写
   用户段）、mcp-config 四层合并（插件层最低、被任意高层覆盖）。
4. **协议**（PR1/PR2/PR3）：各新消息往返（仿 `subagent-mgmt.test.ts`）；prompt 芯片
   解析路径（芯片在开头才触发、成功替换文本、失败 error chunk 不入队、芯片不在
   开头按原文提交、展开后队列/steer 行为不变）。
5. **install/uninstall**（PR3）：目录拷贝、seed 写入、同名拒绝、卸载清 kv、热重载
   联动（skills 块重组 + MCP 连接池 diff）。
6. **前端**（PR1/PR2/PR3）：tsc 干净 + `next build` 通过；菜单数据聚合与芯片插入
   渲染。

## 10. 分阶段交付

### 10.1 改动规模评估

整包一次交付 ≈ sidecar 1.6k 行 + 前端 0.9k 行 + ~50 测试用例，超过 MCP P0 的
单 PR 量级，不建议一次混交。按下表切成四个 PR 后，每个都不超过 MCP P0 量级；
**PR1/PR2/PR3 是纯增量**（不改任何既有行为，可独立交付、独立回滚），唯一
直接触碰既有语义的 hooks 改造隔离在 PR4。

| PR | 内容 | sidecar | 前端 | 测试 | 性质 |
|---|---|---|---|---|---|
| PR1 | commands 机制 | ~700（`commands.ts` ~500 + 协议 ~60 + 芯片解析 ~20） | ~150（菜单第四分类 + 芯片 override + `lib/commands`） | ~15 | 纯增量，可独立上线 |
| PR2 | 插件读取层（四类并网） | ~500（`plugin-loader.ts` ~350 + skills/subagents/mcp 并网 ~150） | ~450（`lib/plugins` + plugins-settings 列表/启停/详情） | ~20 | 纯增量 |
| PR3 | 安装/卸载 | ~250（install/uninstall + seed/hash + kv 清残留） | ~200（安装披露卡 + armed 确认流） | ~10 | 纯增量 |
| PR4 | hooks 并网 | ~150（`matchingHooks` 合并视图 + 插件 hooks.json 消费） | ~50（来源徽章） | ~8 | 唯一动既有语义 |

### 10.2 交付顺序

- **PR1（先行，独立价值）**：commands 机制全量（§5.3 + `list_commands` +
  前端菜单第四分类 + sidecar 芯片解析展开）。不等插件体系即可上线——
  五类扩展机制就此补齐，价值立现；后续 PR 的"插件贡献 commands"只是给
  PR1 的装载器多喂一个目录。
- **PR2**：插件读取层——`plugin-loader.ts` + skills/subagents/commands/MCP 四类
  并网（hooks 只发现不消费）+ kv `pi.plugins` + `list_plugins` /
  `set_plugin_enabled` + 设置页（列表/启停/详情）。安装 = 手动拷目录至
  `~/.kova/plugins/<name>/`（README 说明），此时插件已可完整体验。
- **PR3**：`install_plugin` / `uninstall_plugin` 协议 + 「从文件夹安装」披露卡 +
  卸载 armed 确认 + seed/hash 写入。
- **PR4**：hooks 合并视图（`matchingHooks` 改造）+ 插件 hooks.json 消费 +
  设置页来源徽章。
- **P1**：工作区插件层只读发现（`<cwd>/.kova/plugins`，git 共享团队插件）；
  marketplace（`marketplace.json` 清单仓库 + git URL 安装 + `update_plugin`）；
  MCP prompts → commands 映射；命令 frontmatter 扩展（allowed-tools / model）；
  `save_command` / `delete_command` 协议与命令设置编辑器。
- **P2（按需）**：Claude Code `.claude-plugin` 只读兼容层；贡献物级细粒度开关；
  企业策略/禁用清单；签名校验；插件 subagent 命名空间寻址（`<plugin>:<name>`）；
  命令 `@file` / shell 预处理。

## 11. 已知取舍与开放问题

- **跨插件同名**：v1 用"字典序先者胜 + diagnostics"（可诊断优于隐藏）；
  命名空间寻址（`<plugin>:<name>`）牵动 Task 工具与菜单展示，推 P2。
- **开关粒度**：v1 只有插件整包开关（skills 例外，复用其单技能 kv）；贡献物级
  开关（单命令/单 hook/单 MCP 服务器）等真实需求出现再做。
- **命令是否允许 shell 预处理**（`` !`cmd` ``，Claude Code 有）：v1 否——这是
  唯一会把"模板展开"升级为"执行"的特性，与声明式底线冲突；确有需求走 hooks。
- **插件技能的编辑**：v1 只读（更新=重装）；"复制为系统技能"小按钮 P1 可加。
- **插件 skills 进提示词目录块的缓存影响**：与现有生态技能目录完全同构
  （动态尾部段 + reloadSkills 热替换），无新增风险。
- **Bun 兼容性**：插件装载纯 fs 操作，零新依赖（`yaml` 已有），无 MCP P0 那样的
  冒烟风险；install 的目录拷贝用 `fs.cp`（Bun 支持）。

## 12. 从参照项目抄什么（索引）

| 借鉴点 | 来源 | 落点 |
|---|---|---|
| 清单形态与目录约定（plugin.json + 约定目录 + 指针字段） | Claude Code / ZCode 本机实证 | §4.1 |
| 版本化缓存 + seed hash 溯源记录 | ZCode `.zcode-plugin-seed.json` | §4.2 |
| 命令 = markdown 模板 + `$ARGUMENTS` 占位 | Claude Code commands | §5.3 |
| hooks 事件名与决策语义 | Claude Code（本项目 `hooks.ts` 已 1:1） | §5.4 |
| 安装披露与权限前置 | Claude Code 权限模型精神 | §8 |
| marketplace.json 清单仓库 | Claude Code（P1） | §10 |
| 生态标准格式兼容（标准 `.mcp.json` / `.agents/skills` 已做，`.claude-plugin` 列 P2） | Codex 的"配置即文档"启示 | §10 |
