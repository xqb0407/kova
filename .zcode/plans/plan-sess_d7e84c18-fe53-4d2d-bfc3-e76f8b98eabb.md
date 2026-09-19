# xulux 插件系统设计与实施计划

## 设计总纲

在你现有架构上，插件 = **对已有四个子系统（skills / MCP / hooks / 子智能体）的打包分发层**。核心原则沿用项目现行模式：sidecar 是配置与文件 IO 的唯一事实源；桌面端只发协议消息；运行时开关存 SQLite kv；一切变更后热重载。插件在所有合并链中处于**最低优先级**（用户工作区 > 系统 > 插件，同名被遮蔽），插件级 enabled 开关统一门控其全部组件。

## 一、数据模型

### 1. 插件清单 `.xulux-plugin/plugin.json`
```
name（正则 ^[a-z0-9][a-z0-9._-]{0,127}$，且必须与插件目录名一致）
version?（缺省 0.0.0）、description?、author?{name,url}、icon?（相对路径）、
category?、keywords?、homepage?、license?
组件字段（均可选，相对路径字符串）：skills（目录）、mcpServers（json 文件，
  mcpServers map 标准格式）、hooks（hooks.json，现有 HookConfig 数组格式）、
  subagents（目录，现有 YAML 定义格式）
```
校验：组件路径必须相对且解析后不逃逸插件根；未知组件记 diagnostic 不阻断。

### 2. 生态兼容映射（安装时规范化为内部形状）
- 探测顺序：`.xulux-plugin/` > `.claude-plugin/` > `.codex-plugin/`
- skills：`skills/` 目录，直接复用 pi-agent-core `loadSkills`（SKILL.md 标准本就一致）；兼容模式额外识别根级散 .md
- MCP：`.claude-plugin/../.mcp.json` 或 plugin.json 声明路径，标准 mcpServers map 直接并入
- hooks：Claude 形状 `{hooks:[{matcher, hooks:[{type:"command",command}]}]}` 转换为 HookConfig（仅 type:command）；转换不了的记 diagnostic
- agents/（Claude 子智能体，MD+frontmatter，与本项目 YAML 格式不同）：v1 不映射，记 diagnostic 提示
- `userConfig`/`interface` 等未知字段：忽略

### 3. 市场清单 `marketplace.json`（市场根目录）
```
{ name, displayName?, plugins: [{ name, version?, description?, icon?,
  category?, keywords?, source }] }
source: { source: "directory", path: "./plugins/xxx" }     // 相对市场根
      | { source: "git", repo: "...", path?: "sub/dir" }   // v1 仅这两种
```

## 二、存储布局（sidecar 侧，Rust 已注入 app_data_dir 推导）

```
~/.xulux/plugins/
  marketplaces.json        // 已登记市场：[{id, name, type: "directory"|"git",
                           //   path|repo, addedAt, lastRefresh, catalog?}]
  repos/<mktId>/           // git 市场的工作 clone（--depth 1，refresh 时 pull）
  cache/<mktId>/<name>/<version>/   // 安装物化（copy，与来源解耦）
```
kv 键（hostdb）：
- `pi.plugins.enabled`：`{ "<name>@<mktId>": boolean }`（显式记录优先于默认启用，同 skills/MCP 模式）
- 已装插件身份 = `name@mktId`；组件级开关沿用各子系统现有 kv（用户仍可单独关某个技能/服务）

## 三、sidecar 核心模块：新增 `apps/sidecar/pi-agent/src/plugins.ts`

- `parsePluginManifest(dir)`：三处探测 + 兼容规范化 + 路径/命名校验 + diagnostics
- `listInstalledPlugins()`：扫 cache，返回 { pluginId, manifest, source, enabled, components 摘要, diagnostics }
- `installPlugin(mktId, name)`：从市场源物化到 cache（directory 直拷；git 先 clone/pull 到 repos/ 再拷 source.path），写版本/revision，默认启用
- `uninstallPlugin(pluginId)`：删 cache + 清 kv + 热重载
- `refreshMarketplace(mktId)` / `addMarketplace` / `removeMarketplace` / `listMarketplaceCatalogs()`
- 目录签名缓存沿用 mtime+size 模式

## 四、四条合并链接入（各改一处，插件层垫底）

1. **skills.ts**：`SkillScope` 增加 `"plugin"`；`mergeLayers()` 在 compat 层后按 pluginId 排序逐插件 append `loadSkillLayer(<cache>/skills)`；UI 条目带 pluginId 来源标记
2. **mcp-config.ts**：合并链最末追加插件层（只读，永不写入）；同名 server 由既有 `mergeEntry` 字段级语义自然被用户层覆盖
3. **hooks.ts**：生效列表 = kv(pi.hooks) + 启用插件 hooks.json（插件条目 id 加 `plugin:` 前缀，匹配/决策语义不变）
4. **subagent-definitions.ts**：`loadSubagentDefinitions` 增加插件层扫描（最低优先级）

## 五、协议新消息（protocol.ts，沿用现有 request/response + 自发帧模式）

- `list_plugins` / `set_plugin_enabled` / `uninstall_plugin`（同步完成，随后触发四链热重载：reloadSkills + MCP 重载 + hooks 即时生效 + subagents 重载）
- `list_marketplaces` / `add_marketplace` / `remove_marketplace`（同步）
- `refresh_marketplace` / `install_plugin`：**耗时操作**，返回受理 ack，完成后自发帧 `plugin_op_result`（参照 automation_run_done 模式），桌面端据此刷新
- 移除市场不卸载已装插件（保留 cache，目录标记"来源已移除"）

## 六、桌面端

1. 新增 `apps/desktop/lib/plugins.ts`：协议封装 + 状态管理（参照 lib/skills.ts / lib/mcp.ts / automation-live.ts 的自发帧订阅模式）
2. `marketplace-view.tsx` 改造：
   - **市场页**：市场切换器 + 「+」添加市场弹窗（本地目录走 Tauri dialog / Git URL 输入）；目录卡片网格（icon/名称/简介/版本/分类/安装按钮/已装/有更新），空态文案保留
   - **管理页** tab 调整为：`已装插件 N | 插件(MCP) N | 技能 N | 应用授权`；已装插件卡片：启用开关、组件摘要（点击跳对应 MCP/技能管理页）、来源市场、更新/卸载、diagnostics 红字展示

## 七、版本与更新

- directory 市场：内容签名（目录 mtime+size）检测变更；git 市场：commit short hash 作为 revision
- refresh 后与已装 revision 比对 → UI 显示"有更新"，更新 = 重新物化同 pluginId（组件开关保留）

## 八、安全约束

- 组件路径包含性校验（拒绝对路径/绝对路径/符号链接逃逸）
- hooks 子进程执行沿用现有无 shell 注入约束；插件 hooks 同样受 PreToolUse/PermissionRequest 决策语义管辖
- 不支持 npm/pip 来源；git clone 失败（含未装 git，spawn ENOENT）有明确错误态

## 九、实施顺序与验证

1. **M1 核心模型**：plugins.ts（解析/兼容/校验/安装物化）+ 存储布局 + 四条合并链接入 + list_plugins/set_plugin_enabled/uninstall 协议
2. **M2 市场链路**：marketplace 登记/刷新/安装（directory+git）+ 耗时操作自发帧
3. **M3 桌面 UI**：lib/plugins.ts + 市场页网格 + 添加市场弹窗 + 已装插件管理 tab
4. **M4 打磨**：更新检测、诊断展示、空态/错误态
- 测试：沿用同目录 `*.test.ts` vitest 模式，覆盖清单解析/三态兼容映射/路径逃逸拒绝/四链插件层合并/协议消息；内置测试市场 fixture；`bun run --filter pi-agent-sidecar test` 全绿为门禁
- 手工验收路径：本地目录市场添加 → 安装含四类组件的样例插件 → 会话内技能生效/MCP 工具出现/hook 触发/子智能体可调用 → 禁用插件全链路即时失效 → 卸载干净