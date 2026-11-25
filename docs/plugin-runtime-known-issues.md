# Codex / Agent 插件运行时已知边界

状态：记录待办（2026-11-26，PR #63 审查后整理）
范围：插件安装、MCP 启动、hooks、市场目录
关联：PR #63 `fix/plugins: 插件运行时诊断、重名隔离与原子安装`

本文件只记录 **PR #63 之后仍然存在、但本次未修** 的边界。已修复项见 PR #63
（启动文件预检、stderr 失败尾注、重名隔离、安装原子化、Windows 清单选择、
hooks 无 node 回退、Agent interface 归一）。

优先级：P1 = 会导致功能不可用或安全问题；P2 = 特定场景才触发；P3 = 体验/维护性。

---

## P1

### 1. Windows 无 Node 时 PowerShell 启动器仍失败

- 触发：Windows、机器没有 Node.js、插件使用 `.mcp.windows.json`（如 Codex Design）。
- 现状：`.mcp.windows.json` 已能正确选中，但 `scripts/start.ps1` 内部仍调用
  `node`；`runtime-shims.ts` 目前只做 POSIX 的 `node` 软链，Windows 不注入。
- 影响：Windows 上不装 Node 仍无法启动这类 MCP。
- 方向：为 Windows 生成 `node.cmd` 包装器（设置 `BUN_BE_BUN=1` 后 exec
  `process.execPath`），前置到子进程 PATH；需在真实 Windows 上验证
  PowerShell 的 `.cmd` 解析与参数转义。
- 验证：Windows 干净环境（无 Node）安装 Codex Design，确认 MCP 可握手。

---

## P2

### 2. shim 临时目录不回收

- 触发：sidecar 每次进程启动并首次需要 node 回退时。
- 现状：`runtime-shims.ts` 用 `mkdtempSync($TMPDIR/kova-node-bin-)` 建 0700 目录，
  进程退出后目录留在临时目录。
- 影响：每进程一个小目录（一个软链），频繁重启会累积；无功能影响。
- 方向：改用稳定的 per-user 目录（如 `~/.kova/bin`）并在版本/运行时变化时刷新，
  或 sidecar 退出时清理。

### 3. 启动文件预检只覆盖单 token 路径

- 触发：`.mcp.json` 用 `sh -c "node ./missing.js"`、`python -m pkg` 这类整段命令。
- 现状：`missingLauncherFiles()` 只检查单个不含空白的参数；整段 shell 命令和
  `-m` 模块名不预检。
- 影响：这类插件包不完整时，仍只能等到运行时看 stderr 才知道。
- 方向：对 `sh/bash -c` 做一次轻量 token 扫描，或把预检下移到实际启动后的
  stderr 诊断（后者已在本次实现）。

### 4. 重名接管是破坏性行为变化

- 触发：插件 MCP 服务器与用户系统/工作区中的服务器同名。
- 现状：插件的完整定义被用户的完整定义整条替换，不再继承插件的
  `args/env/description`；补丁条目（只写 kova 字段）仍可继承。
- 影响：依赖「插件覆盖系统同名服务器」的现有配置会变成用户配置生效；诊断里
  有冲突提示，但属于行为变化。
- 方向：release notes 明确说明；如需兼容，可加显式 `pluginOverride: true`
  之类的 opt-in（需产品决策）。

### 5. 并发安装没有 sidecar 级串行化

- 触发：同一插件被并发触发两次安装/更新（协议层或脚本调用，绕过 UI 禁用）。
- 现状：原子物化能保证单次失败保留旧版本，但两个并发流程仍可能互相 rename
  对方的 staging/backup，留下 orphan backup 或后写覆盖先写。
- 影响：极端场景下版本不确定、遗留隐藏 backup 目录。
- 方向：`pluginOp` 按 `pluginId` 加进程内 mutex，或安装队列化。

### 6. 非 OAuth 握手失败抛新 Error，原始 code/name 丢失

- 触发：stdio/HTTP MCP 握手失败且 stderr 非空。
- 现状：为了把 stderr 带进用户可见错误，`throw new Error(entry.message)` 替换了
  原始错误对象；401 走 `needsAuth` 分支仍保留原错误。
- 影响：目前只有 401 依赖 `code`，暂无实际影响；后续若按 `code`/`name`
  分类握手失败（如 404、ENOENT）需要注意。
- 方向：`new Error(message, { cause: err })` 或附加 `code` 字段保留原分类。

---

## P3

### 7. hooks 无 node 时注入范围偏宽

- 触发：PATH 中没有 node，任何 hook 执行前。
- 现状：所有 hook 都拿到 `BUN_BE_BUN=1` 和前置了 node 软链的 PATH，即使该
  hook 不使用 node。
- 影响：行为安全（软链只影响 `node` 解析），但环境面比实际需要宽。
- 方向：只对命令串包含 `node` 的 hook 注入，或按 hook 类型分别处理。

### 8. Windows 清单切换只有单测

- 触发：真实 Windows 环境。
- 现状：`resolvePluginComponents(manifest, kind, platform)` 的 Windows 分支用
  显式 `platform="win32"` 单测覆盖；没有 Windows 端到端安装/启动验证。
- 影响：路径分隔符、`.cmd` 解析、PowerShell 启动器行为仍可能有问题。
- 方向：Windows CI 或人工冒烟：安装含 `.mcp.windows.json` 的插件并调用工具。

### 9. 被用户配置遮蔽的插件仍可能提示配置

- 触发：插件 MCP 服务器被系统/工作区同名服务器整条接管，且插件声明了
  `interface.userConfig` / kova config。
- 现状：`configState` 仍按插件声明计算，可能提示配置一个实际未生效的服务器。
- 影响：边缘场景的无效提示。
- 方向：计算 configState 时排除所有 MCP 定义都被遮蔽的插件，或标记为
  「已被用户配置接管」。

---

## 既有、未纳入本次改动的审计项

这些在 PR #63 的审查里也确认存在，但与本次修复无直接依赖：

- 市场目录 `MAX_CATALOG_PLUGINS = 128` 静默截断，无分页/虚拟滚动；超出部分搜不到。
- `mcp_tool` 类型 hook 不支持（Actera 的 PreToolUse 策略检查不会执行）。
- 依赖安装固定 `--ignore-scripts`，需要 install/postinstall 的原生模块
  （esbuild/sharp/better-sqlite3 等）装完仍可能运行失败。
- 插件更新会删掉 `node_modules`，但不会自动重装依赖，需要用户重新点「安装依赖」。
- MCP 握手默认 10s；首次 `npx` 下载依赖的插件容易超时。
- hooks.json 里引用的脚本不存在时没有预检（与 MCP 启动文件预检同类）。
- 插件详情页不展示实际 MCP command/args 与 hook command，安装前无法核对将执行的命令。
- 诊断文案目前是中文硬编码，英文界面也会显示中文。
