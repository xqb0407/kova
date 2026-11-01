# 远程项目（SSH 执行）实施计划

> 形态：**本地 runtime + 远程执行器**。agent 循环、模型调用、UI、会话都在本地；
> bash/read/write/edit 等工具调用通过 SSH 打到远端机器执行。不部署 daemon、
> 不动 Rust 宿主，远端只要有 sshd 和代码即可。参考 x（packages/server/src/remote）
> 的 SSH 细节与 MCode「新建远程项目」的交互形态。

## 方案总览

```
Renderer                     sidecar (Bun)                    远端主机
────────                     ────────────                     ────────
新建远程项目对话框 ──┐
workspace-store ─────┼─► new_session {cwd, remote} ──► run.remoteTarget
(带 remote 标记)     ┘                                        │
                              buildTools(cwd, remote)          │
                              hostTool.execute ──分支──► ssh CLI ──► bash/read/write/edit
                              (本地会话仍走 hostToolCall ──► Rust 宿主,零改动)
```

- 会话带 `remoteTarget` 时，工具执行改走系统 `ssh` 命令（免装依赖，白送
  ProxyJump/`~/.ssh/config` 别名/agent 认证）；连接复用用 `ControlMaster=auto`
  （ssh 自带多路复用，不需要 ssh2 库）。
- **密钥不进 sidecar**：v1 只支持密钥/agent 认证（CLI 直接读 `~/.ssh/`）；
  密码认证留给后续 ssh2 库阶段（见阶段 E）。
- 远端绑定持久化在**转录 header**（sidecar 所有），不动 Rust 宿主的 SessionRow。

## 阶段 A：SSH 主机管理（Electron main + 设置页）

| 文件 | 改动 |
| --- | --- |
| 新增 `apps/electron/main/ssh.ts` | 主机 CRUD + 连接测试：`ssh_host_list/save/delete/test`；kv + `encrypt()` 存储 |
| 修改 `apps/electron/main/registry.ts` | 注册 `setupSshCommands` |
| 修改 `apps/desktop/lib/desktop-bridge` | 命令 invoke 类型 |
| 新增 `apps/desktop/components/settings/components/ssh-hosts-settings.tsx` | 主机列表 + 添加/编辑/测试 |
| 设置页导航 | 挂「连接 > SSH 主机」入口 |

## 阶段 B：远程项目模型（renderer → sidecar 链路）

| 文件 | 改动 |
| --- | --- |
| 新增 `apps/desktop/lib/workspace/remote-projects.ts` | `{id,name,hostId,remotePath}` CRUD（kv `remote.projects`）+ `isRemoteWorkspace()` |
| 新增 `apps/desktop/components/agent-thread/remote-project-dialog.tsx` | 项目名称/远程主机/源文件夹 |
| 修改 `apps/desktop/components/agent-thread/composer.tsx` | WorkspacePill 加「新建远程项目…」入口与远程徽标 |
| 修改 `apps/desktop/lib/workspace/workspace-store.ts` | recents 兼容远程条目 |
| 修改 `apps/desktop/lib/pi/pi-runtime/pi-client-base.ts` | `new_session` payload 加 `remote` |
| 修改 `apps/sidecar/pi-agent/src/protocol/payloads.ts` | `new_session` 类型加 `remote` |

## 阶段 C：sidecar SSH 执行核心

| 文件 | 改动 |
| --- | --- |
| 新增 `apps/sidecar/pi-agent/src/tools/remote/ssh-exec.ts` | `runSsh()`：统一 `/bin/sh -c` 包装、ControlMaster 复用、keepalive、信号取消、超时 |
| 新增 `apps/sidecar/pi-agent/src/tools/remote/remote-tool-call.ts` | bash/read/write/edit/task_output/task_stop 远程实现，信封与 Rust 宿主同形 |
| 修改 `apps/sidecar/pi-agent/src/tools/tools.ts` | `buildTools` 加 `getRemoteTarget` 闭包；`hostTool.execute` 分流；远端跳过沙箱、write-roots 换远端根、secretEnv 置空 |
| 修改 `apps/sidecar/pi-agent/src/sessions/resolve.ts` | run 上下文存 remoteTarget；转录 header 写 `remote`，恢复时重建 |

## 阶段 D：搜索改道与降级面

| 文件 | 改动 |
| --- | --- |
| 修改 `apps/sidecar/pi-agent/src/search/project-search.ts` | 远程分支走 `ssh`（spawnSync 保持同步语义） |
| 修改 `apps/sidecar/pi-agent/src/agent/git-prompt.ts` | 远程 git 快照经 ssh；失败降级「无 git 信息」 |
| 修改 `apps/sidecar/pi-agent/src/tools/tools.ts`（checkpoint 调用点） | 远程会话跳过逐文件检查点（诚实降级） |
| Renderer 门控 | `isRemoteWorkspace()` 为真隐藏 Git 面板/文件树/检查点卡/本地目录选择器；thread-list 远程徽标 |

## 安全边界（不随阶段妥协）

- 权限审批门留在 sidecar：远程命令照样过 approvalLevel/AI 审查/PreToolUse。
- 写入根收敛：远端只允许写会话 remotePath（含 externalDirs 等价物），双侧校验。
- 无秘密跨界：sidecar 只拿 host/port/username/keyPath。
- 命令与输出照常进转录与日志。

## 阶段 E（后续，不阻塞 v1）

1. ~~密码认证~~ **已实现**：密码主机走 ssh2（连接池 + keyboard-interactive）；
   密码只存在于 main→sidecar 管道与进程内存，渲染层仅见 hasPassword 标志，
   main 在每次请求转发前解密注入（`enrichRemotePayload`），转录 header 落盘剥离。
2. 远端目录浏览（`ssh host ls`）。
3. 远端检查点（store IO 适配器）。
4. 连接池调优（观察 ControlMaster 休眠恢复表现）。

## 验证

- 单测：引号工具、edit 替换语义、write-roots 越界拒绝、任务表。
- E2E：连接测试 → 建远程项目 → 读/写/编辑/搜索/后台任务 → 中断恢复 → 本地回归。
