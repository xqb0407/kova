# Git Worktree（受管工作树）

状态：计划（已定稿，待实施）。
参照语义：Codex managed worktrees（官方文档化）；Claude Code 官方工作流文档化（手动）；ZCode 社区 feature request（官方缺位）。调研结论：worktree-per-task 是并行 agent 会话的主流形态。

## 1. 问题

多个 agent 会话共用一个工作目录时：文件改动互相泄漏进对方上下文、git 索引争抢、分支切换互相干扰。需要按任务隔离工作区。

## 2. 目标与非目标

**目标**（对齐 Codex 语义的实用子集）：
- 从受信 git 仓库创建受管 worktree：可选基线（默认分支 / 指定分支 / 当前分支含未提交改动）。
- 受管根统一存放（默认 `<appData>/worktrees`，kv `worktrees.root` 可改），注册表记录元数据。
- 会话 ↔ worktree 绑定：可在 worktree 里开会话，agent 工具/沙箱天然可用。
- 未提交改动跟随：tracked diff apply + untracked 文件拷贝；`.worktreeinclude` 语义（ignored 文件拷贝、跳过 symlink、不覆盖已存在、自动含 `AGENTS.override.md`）。
- 收尾：「创建分支」（`kova/<slug>`）固定成果；「删除」进 trash（整目录保留，可恢复），trash 7 天自动清理。
- Settings 管理：「Worktree」设置区，按仓库分组管理（新建/新会话/创建分支/删除/恢复/清空 trash）。

**非目标**：
- Handoff（会话在本地 ↔ worktree 搬移）、后台任务专用 worktree（后续）。
- 自动 merge / PR 创建（用户在 worktree 里用 git 自行收尾；GitHub PR 工作流另立）。
- 自动删除到保留数（不做自动清理活跃 worktree，只清 trash）。
- 非 git 目录、worktree 嵌套 worktree。

## 3. 位置与信任边界

- 受管根：`worktreesRoot()` = env `KOVA_WORKTREES_DIR`（测试）→ kv `worktrees.root` → `<appDataDir>/worktrees`。不放在 task-workspace 下：task-workspace 支持整体迁移，搬移会破坏 worktree 的 `.git` 文件（绝对 gitdir 指针）。
- 注册表：`<worktreesRoot>/registry.json`（原子写 + mtime 缓存），记录 `{ id, repoRoot, path, base, branch?, createdAt, sessionIds[], status: "active"|"trashed", trashPath? }`。
- 信任扩展（全部以注册表为准，不做"父目录包含"式放行）：
  - git（`git.ts resolveWorkspace`）：cwd realpath 命中受管 worktree → 直接信任（不要求 kv workspace）；影子检查点按 worktree 独立建仓。
  - fs（`fs-cmds resolveRoot`）：cwd 位于受管 worktree 内 → root = 该 worktree。
  - 沙箱：会话 writeRoots 已包含会话 cwd（`sandbox-plan.ts` 生效根含 `realResolve(cwd)`），worktree 会话自动可写，无需改动。

## 4. 创建语义

1. 校验 repoRoot 是受信 git 仓库（workspace / 项目根 / 既有受管 worktree 的主仓库）。
2. `base` 解析为 commit（`rev-parse <base>`）；`git worktree add --detach <path> <commit>`。
3. `includeUncommitted`：
   - tracked：`git -C repo diff HEAD --binary` → worktree `git apply`；失败即整体失败并清理半成品。
   - untracked：`git ls-files --others --exclude-standard` 拷贝（跳过 symlink、上限 500 文件）。
4. `.worktreeinclude`（仓库根，gitignore 风格行）：`git ls-files --others --ignored --exclude-standard -- <patterns…> AGENTS.override.md` 命中者拷入（跳过 symlink、不覆盖已存在、单文件上限 64MB）。
5. 命名：目录 `wt-<id 前 8>`；分支收尾时才建（`kova/<slug>`），创建期 detached HEAD。

## 5. 收尾与清理

- 「创建分支」：`git -C worktree checkout -b kova/<slug>`，记录 branch。
- 「删除」：确认后整目录 rename 到 `<worktreesRoot>/.trash/<id>-<ts>`（**不 prune**——trash 里的 `.git` 指针要留着支持恢复），registry 置 `trashed`。
- 「恢复」：trash 目录 rename 回原位（被占用则失败提示）。
- 「彻底删除」：rm trash 目录 + 主仓库 `git worktree prune` 清元数据。
- trash 自动清理：启动与每次删除后，清掉 7 天前的 trash 条目（含各自 prune）。

## 6. UI（Settings → Worktree）

- 按仓库分组列出受管 worktree：分支/base、创建时间、绑定会话数。
- 新建表单：仓库选择（受信 git 仓库）、基线分支、是否跟随未提交改动、名称（可选）。
- 行动作：新建会话 / 创建分支 / 删除（两段确认）。trash 分组：恢复 / 彻底删除。
- 「新建会话」闭环：`new_session { cwd: worktree }` → 记录 sessionIds → `requestOpenSession` 跳转。

## 7. 验收

1. 主仓库工作区不受影响；worktree 内改动只存在于 worktree。
2. worktree 会话：agent 读写文件、跑测试、git 面板 diff/commit 全部可用（信任扩展生效）。
3. 未提交改动与 `.worktreeinclude` 文件按语义出现在新 worktree。
4. 删除 → trash 可恢复；7 天自动清理。
5. 设置页可完成 创建 → 会话 → 分支 → 删除 全闭环。

## 8. 风险

| 风险 | 处理 |
|---|---|
| 信任放行过宽 | 只认注册表精确路径（realpath），不做目录前缀推断；测试覆盖越界拒绝 |
| worktree `.git` 文件指向主仓库 `.git/worktrees`（绝对路径） | 受管根不参与 task-workspace 迁移；文档提示不要手动搬移 |
| 大仓库/依赖安装 | worktree 不含 `node_modules`（gitignored 不拷贝，`.worktreeinclude` 可按需加）；文档说明 |
| 分支占用冲突 | 创建期一律 detached；收尾才建分支，命名带 `kova/` 前缀 |
| 并发写 registry | 原子写 + mtime 缓存；写操作经模块内串行队列 |
