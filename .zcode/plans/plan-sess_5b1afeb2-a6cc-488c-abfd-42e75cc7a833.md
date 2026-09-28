# 面板文件视图：跟随当前工作目录 + 面板内编辑保存

## 背景
上一轮已把无目录会话的产物隔离到 `<task-workspace>/<sessionId>/`，Rust `resolve_root` 也放行了 task-workspace 整个子树。本轮解决新诉求：「panel 里看到当前工作空间下的文件，以及编辑、删除等」。

现状盘点（探索结论）：
- 面板已有「文件树」标签（`explorer` → `file-tree-tab.tsx`），**管理操作全部齐备**：懒加载树、点击打开、右键新建文件/文件夹、重命名、删除、reveal、复制路径、HTML/SVG 浏览器预览——但锚定 `useWorkspace()`，无工作区的全局会话只显示空态；
- 「文件」标签（`file-view.tsx`）磁盘模式是只读查看（`cm-code.tsx:104` 写死 `editable={false} readOnly`）；
- 写盘命令 `fs_write_file` 已存在（`lib/workspace/fs.ts` 的 `fsWriteFile(cwd, path, text)`，信任根守卫 + 32MB 封顶），插件面板已在用。

已确认的设计决策：① 编辑做到**面板内直接改文件内容并保存**；② 无工作区时文件树根 = **当前会话子目录**（`usePanelCwd()` 第三级兜底，与 agent cwd 同源）。

## 改动清单

### 1. `components/agent-thread/agent-panel/file-tree-tab.tsx` — 换锚
- `useWorkspace()` → `usePanelCwd()`（本地变量改名 `rootCwd`，避免与 workspace 语义混淆）；
- 空态调整：`isTauri()` 门槛保留；`rootCwd` 为 null 只发生在异步解析的一瞬，文案改「正在准备任务目录…」，删掉「选择工作目录后可浏览文件树」分支（现在无工作区也能用）；
- 切根 reset effect、缓存 key、`fsDelete/fsRename/fsMkdir/fsTouch/fsReveal/refreshFileTree` 等调用原样跟随新变量——`lib/workspace/fs.ts` 与 `lib/workspace/file-tree.ts` 本来就按任意 cwd 泛化，无需改；
- 草稿会话（尚未物化 sessionId）短暂锚在 task-workspace 根，`pi:session-bound` 后自动重解析（usePanelCwd 已具备）。

### 2. `components/agent-thread/agent-panel/tab-registry.tsx` — 文案
- `TAB_META.explorer.description` 改为「浏览当前工作目录（无工作区时为会话任务目录），点击实时预览」；组件头注释同步。

### 3. `components/code/cm-code.tsx` — 可选可编辑
- `CodeMirrorCode` 增加可选 `editable?: boolean` + `onChange?: (v: string) => void`，默认关（设置页代码预览、「我的文件」预览等现有调用点行为不变）；
- `editable` 时：`CodeMirror` 传 `editable`、不带 `readOnly`、挂 `onChange`，`basicSetup` 开 `highlightActiveLine`，其余保持精简配置。

### 4. `components/agent-thread/agent-panel/file-view.tsx` — 磁盘模式编辑 + 保存
- `FileBody` 增加可选 `edit` 属性 `{ draft, onDraftChange, dirty, saving, onSave, disabledNote }`；快照模式不传 → 与今天完全一致；
- `DiskFileView`：ready 后 state 持 `baseline`（盘上内容）+ `draft`；`dirty = draft !== baseline`；
  - 保存走 `fsWriteFile(cwd, path, draft)`，成功则 `baseline = draft` + `toast.success("已保存")`，失败 `toast.error(fsErrorText(err))`；
  - 顶栏 `FileHeader extra`：dirty 时显示「● 未保存」+「保存」按钮（saving 中禁用）；md 文件保留「预览｜源码」切换——编辑只发生在源码态，预览态渲染 baseline（盘上内容），切回源码草稿不丢；
  - Cmd/Ctrl+S：组件内 window keydown 监听（面板只挂载活动标签，`agent-panel/index.tsx:267` 已确认，不会串标签误存）；
  - `data.truncated`（>2MB）或 `binary` 时**禁止编辑**：截断缓冲保存会毁文件；沿用 NoteBar 提示「文件过大，仅可查看」；
  - 已知限制（v1 接受）：切走标签/换文件丢弃未保存草稿（靠 dirty 圆点提示）；agent 端并发写不做冲突检测，用户保存即覆盖。

### 5. Rust / sidecar
无改动：`fs_list_dir / fs_read_file / fs_write_file / fs_delete / fs_rename / …` 全部经 `resolve_root`，上一轮的子树放行已覆盖会话目录；`fs_write_file` 自动建父目录、覆盖写语义正合适。

## 测试与验证
- desktop `bunx tsc --noEmit`；`bun run test`（desktop 现有 panel-tabs/artifacts 用例不受影响；本轮为组件行为，不新增纯函数测试）；
- 手工冒烟：
  1. 无工作区全局会话 → 面板「文件树」显示当前会话子目录内容，agent 新写文件在运行结束/窗口聚焦刷新后可见；
  2. 右键新建/重命名/删除/reveal 正常；
  3. 点 txt/md/html 文件 →「文件」标签打开，改内容出现「● 未保存」，点保存/Cmd+S 后盘上内容变化，预览态刷新为盘上内容；
  4. >2MB 文件与图片只读；
  5. 有工作区时一切行为与今天一致（树根仍是 workspace）；设置页/「我的文件」的代码预览不受 editable 改造影响。