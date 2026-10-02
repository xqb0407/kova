## 背景（已核实）

记忆 = 双作用域 markdown 文件库：全局 `~/.kova/memory`（`PI_MEMORY_DIR` 可覆盖）+ 工作区 `<cwd>/.kova/memory`；根级 `*.md` 参与注入（逐文件开关），`daily/*.md` 只参与检索。写入唯一收口是 sidecar `agent/memory.ts` 的 `writeMemoryFile()`（被 AI 的 `memory_write` 工具与设置页 `write_memory_file` 共用），写后热替换活动会话提示词。设置页现在只能看/编辑/开关/搜索，**没有删除、没有历史**。

关键约束：hostdb 有 Bun/SQLite 与 Rust 两套实现 → 新能力**只用文件系统**，不动数据库与 Rust。工作区作用域会落在用户仓库里，所以新增目录必须自带 `.gitignore`（内容 `*`，自忽略）。

## 一、记忆删除 → 回收站（先做，这是界面缺的那一步）

**sidecar `apps/sidecar/pi-agent/src/agent/memory.ts`**（沿用现有文件名校验 `FILE_NAME_RE` 与 `scopeDir()` 路径守卫）：
- 布局：`<memoryDir>/.trash/<时间戳>--<原名>`，同目录 `rename` 移动（原子、不跨设备）；`.trash/.gitignore` 写 `*`。
- 新增：`trashMemoryFile` / `listMemoryTrash`（→ `{id,name,ts,bytes}[]`，时间倒序）/ `restoreMemoryTrash`（同名占用即报错，不覆盖）/ `deleteMemoryTrash` / `emptyMemoryTrash`。删除前先留一版历史（来源 `delete`），恢复后清对应快照记录。
- `.trash` / `.history` 天然不进 `listRootMemoryFiles`（只扫根级 `*.md`）、不进注入与检索。

**协议 `protocol/handlers/preferences.ts` + `protocol.ts` 头注 + `apps/desktop/lib/pi/pi-bridge.ts`**：新增 `trash_memory_file` / `list_memory_trash` / `restore_memory_trash` / `delete_memory_trash` / `empty_memory_trash`；删除与恢复后同样热替换活动会话提示词（与现有 write 一致）。

**设置页 `memory-settings.tsx`**：
- 文件行右侧（现有注入开关旁）加两个 ghost 图标按钮：**历史** / **删除**（`stopPropagation`，沿用模型服务行的图标按钮样式）。
- 删除 → `AlertDialog`（报文件名 + "移入回收站，可随时恢复"）。
- 页面底部可折叠「回收站 (N)」区块：时间 / 名字 / 大小，行内 **恢复** / **彻底删除**，区头 **清空回收站**（再走一次 AlertDialog，不可恢复）。空时整块不显示；随作用域页签切换。

## 二、记忆版本史（自动，可预览/恢复/删单版）

**存储**：`<memoryDir>/.history/<文件名>/<时间戳>--<来源>.md`（内容逐字存，来源 ∈ `page` / `agent` / `external` / `restore` / `delete`），自带 `.gitignore`。**保留最近 50 版/文件**，写后按名裁剪；与上一版内容完全相同则跳过（去重、不刷屏）。

**记录时机**（只加在两个收口上，不散落）：
- `writeMemoryFile()` 加一个 `source` 参数，覆盖/追加前先把旧内容快照一版 —— AI 走 `agent`、设置页保存走 `page`，两处调用点各传一次。
- 设置页 `read_memory_file` 时若磁盘内容与最新版本不一致 → 补一版 `external`（覆盖"在外部编辑器里改过"的情况，标记来源为外部）。
- 删除前留一版 `delete`；恢复某版 = 把该版内容经 `writeMemoryFile(..., "restore")` 写回 → 历史只增不改，任何一步都能回退。

**协议**：`list_memory_versions` / `read_memory_version` / `restore_memory_version` / `delete_memory_version`（后者删单条版本）。
**UI**：文件行「历史」→ 历史弹窗：左侧版本列表（时间 · 来源标签 · 大小，行内 恢复 / 删除此版），点某版复用现成的 `MarkdownEditDialog`（`initialTab="preview"`，保存动作 = 恢复此版），不新造渲染引擎。无版本时提示"改动之后会出现在这里"。
**不做**：`daily/` 日志不纳入版本与回收站（保持只参与检索）；不做逐行 diff（要引 `@pierre/diffs` + worker 池，成本高，后续可单独加）。

## 三、归档页批量删除（`archive-settings.tsx`）

- 多选状态 `Set<string>`：行首 `Checkbox`，头部工具条「全选 / 取消全选」+「已选 N」+ 破坏性样式的 **删除选中 (N)**；行内 恢复/删除 保持原样。
- 删除选中 → `AlertDialog`（"删除 N 个已归档会话？此操作不可恢复"）→ 顺序执行 `aui.threads.item({id}).delete()`，期间显示「删除中 3/12」并禁用交互；结束后 toast「已删除 N 个会话」，失败则报「成功 M/N」并保留未成功的选中项以便重试（列表随 aui 状态自然收缩）。

## 验证

- **sidecar 单测**（`test/agent/memory.test.ts` 扩展，沿用 `PI_MEMORY_DIR` 临时目录 + `initLocalStorage` 约定）：删除→回收站→恢复→彻底删→清空；同名恢复被拒；版本快照覆盖各来源（page/agent/external/restore/delete）、连续相同内容去重、50 版裁剪、非法名与路径穿越拒绝、`.trash`/`.history` 不出现在文件清单/注入/检索里。
- **桌面**：`bun test apps/desktop/lib/`（现有 586 例回归）+ `tsc --noEmit` + `bun run build`，并复核产物里仍无 `antd`/`lobehub-ui`。
- **视觉**：临时 dev-preview 页复刻"记忆文件行 + 历史弹窗 + 回收站区块"与"归档多选态"，浅/深色截图核对后删除临时页（与上一轮同样做法）。

## 风险与对策

- 工作区作用域会在用户仓库里出现 `.trash`/`.history` 两个目录 → 自忽略 `.gitignore` 兜住，`git status` 无噪音。
- 用户若手动同步/备份 `.kova/memory`，历史文件会跟着走：它们只是普通 markdown，无副作用。
- 批量删除是 N 次 `delete_session` 请求：设置页一次性操作、量级小，顺序执行 + 进度提示即可，不做并发。