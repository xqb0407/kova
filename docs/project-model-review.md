# 项目实体改造：三轮代码审查记录

范围：`projects` / `project_folders` / `sessions.project_id` 持久化项目模型、历史迁移、
共享目录、会话归属、桌面端新建工作区与项目设置、空项目展示。

审查方式：每轮独立读完整 diff（不只看上一轮结论），发现问题 → 修复 → 重跑对应测试。

---

## 第一轮：架构与数据完整性

### 已修复

| 级别 | 问题 | 修复 |
| --- | --- | --- |
| P0 | 旧 localStorage 名称/外观迁移后删除活动 key，侧栏仍读 localStorage → 名称/图标瞬间消失 | 活动 key 保留为显示缓存，只写 `project-meta.legacy-backup.v1` 备份 |
| P0 | `initProjects` 在项目列表为空且旧 kv 存在时回退旧路径 map，新项目查不到（`project directory not found`） | 只有 host 查询本身失败才回退；空列表是新安装的合法状态 |
| P1 | 共享目录命中多个项目时 `add/remove_project_dir` 用 `uniqueProjectForCwd` 返回 null 并报错 | shim 改为 `projectsContaining(cwd)[0]`，共享目录不报错 |
| P1 | `save_project` 后驻留会话的附加目录/提示词不刷新 | 保存后 `recomputeRunsForProject` + `broadcastProjectMembership` |
| P1 | 只改名称时 `folders` 被空数组覆盖清空 | sidecar `saveProject`：`folders` 未传/为空时保留已有 |
| P1 | 外观只写 localStorage，后端无持久化 | 项目设置卡外观改动 500ms 防抖双写 `save_project` |
| P1 | 新建会话/项目内新对话/移动会话/草稿 rebind 未携带 projectId | `createThread`、`newChatInProject`、WorkspaceThreadSync、move、`rebindRunCwd` 全链路补齐 |
| P2 | `appearanceSaveTimer` 在声明前被 effect 使用（TDZ） | 声明前移 |

### 门禁

- `apps/electron` 187 tests、sidecar 2372 tests、protocol 31 tests、desktop 1366 tests 全绿。
- `typecheck` / `build` 通过。

---

## 第二轮：行为与边界

### 已修复

| 级别 | 问题 | 修复 |
| --- | --- | --- |
| P1 | 项目设置卡加/移除目录走旧 `add_project_dir(cwd)`；共享目录命中多个项目时取“最近更新”的项目，会在 A 卡片里改到 B 项目 | 协议请求增加可选 `projectId`；桌面 API/弹层透传；sidecar 按 id 定位，应答也按 id 取 folders |
| P1 | 移除目录后 `projectDirsPayload(cwd)` 按 cwd 反查失败，移除已生效却报 `project directory not found` | 新增 `projectDirsPayloadFor(project)`；移除最后一个目录时返回空清单 |
| P1 | 目录被移出项目后，会话/驻留 run 仍保留 project_id，继续加载原项目附加目录 | `unbindSessionsOutsideProject` + `unbindRunsOutsideProject`；`save_project`/`remove_project_dir` 保存后解绑并广播 |
| P1 | localStorage 旧元数据迁移只挂在移动抽屉的 `WorkspacePicker`，桌面侧栏不触发 | 迁到 `useThreadListGroups` 启动 effect；`ensureLegacyProjectMetaMigrated` 侧车未就绪时退避重试，单条目录失败不阻断整体 |
| P1 | 空项目（`show_when_empty=1`）没有会话就不在侧栏出现，新建工作区后无落点 | 消费项目注册表，补空项目分组（搜索/时间筛选时不展示；已有会话归属或 cwd 已被占用时不重复） |
| P1 | local/CLI 模式 `bun:sqlite` 的 `db.transaction(fn)` 未调用 → `project_save` 事务体从未执行 | `const tx = db.transaction(...); tx()` |
| P1 | local 模式 `project_save` 每次把未传字段写成 null，只改名称会清空外观 | 与 Host 对齐：`undefined = 不改` |
| P1 | local 模式没有旧 `pi.projectDirs` → projects 迁移，升级后 CLI 旧项目丢失 | `migrateLocalProjects`：与 Host 同规则建项目/回填 project_id/写 marker |
| P2 | 恢复旧会话时按 cwd 推导出的 projectId 不落库，每次加载重复推导 | `resolveSession` 推导后 `sessionSetProject` 持久化 |
| P2 | 会话换 cwd 后项目归属不跟随：移出项目仍吃原项目目录 | `rebindRunCwd` / 非驻留 `setSessionCwd`：仍在 folders 内保持，否则按新 cwd 唯一归属重绑或解绑 |
| P2 | `sessionSummaryOf` 对“project_id 存在但 cwd 已不在 folders”的脏数据仍下发项目身份，新对话可能建到已离开的项目 | 归属校验后回退 cwd 分组 |
| P2 | Host 迁移中共享路径 last-write-wins，附加根可能抢走主目录会话 | 回填优先 `primaryToProject` |
| P2 | 归档项目仍可被 `projectIdForCwd` 自动绑定新会话 | `uniqueProjectForCwd` 排除 archived（旧会话展示分组仍保留） |
| P2 | “移动到项目”只列有会话的目录，空项目不可选；共享目录移动后归属可能落空 | 目标列表改用项目注册表；移动完成按目标 primary 显式 `setSessionProject` |
| P2 | 新建工作区选中已存在项目的文件夹时无共享提示，且 localStorage 缓存缺失会清空已有名称/图标 | 拉取项目实体回填 DB 名称/外观，并显示“共享同一文件夹”提示 |
| P3 | 冲突旧文案 `ownedByOther` / `removeFromProject` / `createdPartial` 已无引用 | 删除死 key，补 `sharedHint` 中英文 |

### 门禁

- 新增单测：共享目录不猜归属、run 解绑、Host 共享路径主目录优先、local 迁移/保存往返。
- `apps/electron` 189 tests、sidecar 2379 tests（158 files）、protocol 31 tests、runtime 7 tests、desktop 1366 tests 全绿。

---

## 第三轮：最终全量

### 逐文件复核结论

- 数据模型：`project_folders` 无全局唯一 path（共享目录）；每项目至少一个 primary；归档为软删除；`sessions.project_id` 为唯一归属依据。
- 迁移：`pi.projects.migrated.v1` marker + 事务；迁移前 `VACUUM INTO` 整库备份；旧 kv/旧 localStorage 均保留；重复执行无副作用。
- 会话生产链路：new / fork / side_chat / handoff / rebind / move / set_session_cwd 全部经 projectId 或唯一 cwd 归属校验；远程会话拒绝本地 projectId；任务会话保持 NULL。
- 目录效果：提示词 Project Folders、技能发现、文件检索、检查点、trusted roots 都按项目 folders 解析；host 可信根优先 `project_folders`，旧库回退 `pi.projectDirs`。
- local 模式：建表/迁移/CRUD 与 Host 语义对齐，事务显式执行，字段“未传不改”。
- UI：共享目录目录操作按 projectId；空项目可见；归档项目同时归档会话与实体；移动目标包含空项目；名称/外观 localStorage 缓存 + DB 双写/回填。
- 兼容：旧客户端不带 projectId 仍按 cwd 分组；响应新增字段均为可选；旧命令 shim 保留。
- 无残留：新增文件无调试输出；删除的静态头像生成脚本与 SVG 产物已从仓库移除。

### 验证命令与结果

```text
bun run typecheck        → 0（pi-runtime / desktop / electron-main）
bun run check:type       → 0
bun run check:patches    → 0（1 个补丁全部生效）
bun run build            → 0（sidecar + renderer + electron main）
cd apps/electron && bun test        → 189 pass
apps/sidecar/pi-agent && bun test   → 2379 pass（158 files）
packages/pi-protocol && bun test    → 31 pass
packages/pi-runtime && bun test     → 7 pass
bun run test:desktop                → 1366 pass（131 files）
```

### 残余风险与已知限制

1. **共享同一 primary 的两个项目**在侧栏仍共用同一分组键（`projectCwd` = primary）。共享**附加目录**已正确分组；同一 primary 的极端配置建议后续按 `projectId` 重构分组键。
2. **自动化任务**尚未显式保存 `projectId`，共享目录下的自动化按 cwd 无法唯一归属时保持 NULL（Phase 4 项）。
3. **工作区胶囊**仍以“最近目录”为主入口，选择旧目录时依赖 sidecar 按唯一 cwd 自动归属；共享目录需要在侧栏/项目内新对话进入。
4. 项目设置卡中修改名称/外观依赖文件夹仍可访问；文件夹整体缺失时仅 localStorage 即时生效，DB 写入会失败并静默。
5. 本轮未在真实旧版用户数据上做人工升级冒烟（自动化迁移 fixture 已覆盖主目录/附加根/子目录/归档/远程/任务/side_chat/重名/共享）。

### 发布建议

代码门禁全部通过，核心模型与会话归属闭环，可作为发布候选（RC）。上线前建议在真实旧 profile 上补一次人工升级冒烟：旧 kv + localStorage + 多根项目 + 归档/任务/远程会话 → 检查侧栏分组、名称/图标、项目设置卡目录、共享目录两项目互不影响。上述 1–3 项建议记录为发布说明中的已知限制。

---

## 第三轮补充：外部审查清单逐条核对

结论：清单中约一半是**修复前的旧结论**，另一半是真实残留。本轮已把真实项全部修掉。

| 清单项 | 结论 | 处理 |
| --- | --- | --- |
| 1. 移动会话后项目归属不更新 | 修复前真实；当前已修 | `rebindRunCwd` / 非驻留 `setSessionCwd` 同步重绑并落库；移动完成显式 `setSessionProject`；非项目目标清掉客户端旧镜像，避免“新 cwd + 旧 projectId” |
| 2. 新建工作区不校验已有项目 | **部分真实**：共享目录是刻意能力，但重复主项目缺少显式确认 | 已加“共享同一文件夹”提示 + DB 名称/外观回填；重复项目仍需产品层决定是否提供“更新已有项目”入口 |
| 3. 归档项目仍参与查询 | 真实 | `projectsContaining` 改为只含未归档项目；`uniqueProjectForCwd` 本就不含归档；移除最后目录后不会再命中归档 folders |
| 4. 旧目录删除导致迁移整体失败/永远重试 | 旧结论，已不成立 | 逐条 try/catch，单条失败不阻断；成功/失败都写 marker，活动 key 与备份保留 |
| 5. 目录删除后改名/换图标静默失败 | 修复前真实；当前已修 | 名称/外观-only 保存不再校验 folders 是否存在；新增回归测试 |
| 6. 名称/外观只写不读 | 旧结论，已不成立 | 侧栏/移动目标/新建弹窗读 DB 名称与 `appearance_json`；胶囊与标题栏按 projectId 读实体名称 |
| 7. 外观防抖关闭面板不 flush | 真实 | 关面板/卸载/换项目时 flush 最后一次草稿，并按草稿所属项目 id 写回 |
| 8. handoff 不继承 projectId | 真实 | `sessionInsert(newId, cwd, { projectId })` 继承源会话 |
| 9. 改名/换图标触发全项目提示词重排 | 真实 | `save_project` 只有 folders 实际变化时才 `recomputeRunsForProject` + 广播 |
| 10. workspace.projectId 是死代码 | 真实 | 删除该 kv 写入；最近目录选择改为按项目注册表解析并携带 projectId |
| 新库启动打备份错误日志 | 真实 | 先查 `sqlite_master` 再 count sessions |
| 空项目不可见 | 旧结论，已不成立 | 本轮已实现空项目分组 |
| 主目录判定用下标 0 | 真实 | `projectFolderDirs` 统一 primary 优先排序 |
| 胶囊标签与项目卡不一致 | 真实（展示层） | 胶囊/标题栏优先显示当前 projectId 的实体名称 |
| 共享目录归属受 `updated_at` 影响 | 真实（仅无 projectId 的回退分组） | 迁移会话都有 projectId；新入口显式绑定；回退分组仍受更新顺序影响，记为已知限制 |
| 测试门禁缺口 | 部分真实 | `verify:goal` 补 `kova-electron-main test`；新增共享目录/解绑/local 迁移/handoff 相关测试 |
| 头像在渲染路径同步生成 | 观察项 | 有 `DATA_URI_CACHE`，每 id 只生成一次；首屏包体可后续按需懒加载优化 |
| local 模式无旧目录迁移 | 旧结论，已不成立 | 本轮已补 `migrateLocalProjects` |

补充验证（本轮修复后）：

```text
desktop typecheck / sidecar typecheck / electron-main typecheck → 0
sidecar 定向测试（local-projects / projects-registry / handoff）→ 24 pass
desktop → 1366 pass
```

---

## 第三轮补充 2：第二轮外部审查逐条核对

| 条目 | 结论 | 处理 |
| --- | --- | --- |
| 1. 侧栏卡片身份被组内最新会话“劫持” | **真实（高）**：分组键仍是 cwd，同 primary 的项目共用一张卡 | 分组键改为 `projectId` 优先（`cwd` 仅旧会话兜底）；空项目不再被旧卡占用；外观改为 DB 优先 + 注册表乐观更新；拖拽落点带 `projectId`，同 cwd 的不同项目可区分并正确换绑 |
| 2. `set_session_project` 不同步驻留 run | **真实（高）** | 新增 `applyProjectBindingToRun`：更新 `run.projectId`、重算 `externalDirs`、预热技能并重排提示词；handler 内调用 |
| 3. 移动到附加目录时误删客户端镜像 | **真实（中）** | 目标解析改为：显式落点项目 → 仍在当前项目 folder 内 → primary → 唯一 folder 命中；只有真正无归属才清镜像 |
| 4. 路径比较大小写敏感 | **部分真实（中）** | 桌面端 `sameProjectPath` 在 macOS/Windows 折叠大小写；Host/local 迁移用 `realpath` 作比较键。Linux 保持大小写敏感（正确语义） |
| 5. `pi_sessions` 旧表未回填 project_id | **真实（中）** | 旧表 drain 移到 `initProjectTables` 之前 |
| 6. 只改 primary 不广播 | **真实（中）** | `primaryChanged` 单独触发 `broadcastProjectMembership`（不触发提示词重算） |
| 7. 改名失败表现与注释不一致 | **真实（低）** | 有实体时先写 DB，成功再写本地缓存；失败 toast + 回滚草稿与本地缓存 |
| 8. `delete_project` 不解绑会话/run | **真实（低）** | 归档后解绑全部 sessions/run、重算目录并逐会话广播 |
| 9. 外观本地旧值覆盖 DB 新值 | **真实（低）** | 实体分组 DB 优先；外观编辑乐观更新注册表；本地缓存仅作回退 |
| 10. 改图标刷新 `updated_at` 导致排序跳动 | **真实（低）** | Host/local `projectSave`：只有 folders/归档/空项目可见性变化才推进 `updated_at`；补回归测试 |

补充验证（第三轮补充 2 后）：

```text
typecheck（runtime/desktop/electron-main）→ 0
sidecar 2379 pass / electron 190 pass / desktop 1366 pass
```

---

## 第三轮补充 3：UI 状态键 / 多窗口 / 自动化 / 重名

| 条目 | 结论 | 处理 |
| --- | --- | --- |
| 同 primary 双卡的 `openDirs`/`visibleCounts` 按 cwd 共享 | 真实（UI 状态） | `ThreadListProjectGroup` 增加稳定 `key`（`project:` / `cwd:`），折叠、分页、展开全部、新建对话后的自动展开全部改用 key；移动事件携带 `projectId` |
| 无 projectId 的旧会话拖到同 cwd 项目卡被判“自己” | 真实 | 自己的判定改为：cwd 相同且（双方都有 projectId 时 id 相等 / 双方都没有 projectId）；旧会话可拖入同 cwd 的项目卡 |
| 多窗口不同步项目实体 | 真实 | 新增 `projects_changed` 自发帧（sidecar save/delete/目录变更时广播）；桌面/WS 通道订阅后重拉注册表；`remote.ts` 白名单放行；注册表写入改为新数组，`useSyncExternalStore` 快照必变 |
| 自动化任务未持久化 projectId | 真实 | `ScheduledTask.projectId` 落库（save 时按 workspaceDir 唯一归属解析或显式传入并校验目录一致性）；runner 用显式 projectId 建会话，工作目录留空时回落项目主目录 |
| 项目重名 | 真实（缺校验） | sidecar `saveProject` 对自定义名称做大小写不敏感的唯一校验；创建弹窗在已有项目目录上不再自动回填旧名称；legacy 迁移遇历史重名自动加序号，避免迁移跳过丢数据 |

补充验证：

```text
sidecar 2382 pass / electron 190 pass / desktop 1366 pass / protocol 31 pass
typecheck / build → 0
```
