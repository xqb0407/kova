## Skill 功能实现方案

### 设计要点(回应你的关注)

- **开关控制**:启用状态存 sidecar SQLite kv,键 `pi.skills`,结构 `{disabled: {"system:<name>": true, "workspace:<cwd>::<name>": true}}`——与 MCP(`pi.mcp`)、子智能体(`pi.subagents`)完全同构,未记录 = 启用。禁用的技能在组装提示词时被过滤,完全不出现。
- **渐进披露**:启用的技能也只向系统提示词注入 3 行目录(`<available_skills>` XML:name/description/location,用 pi-agent-core 现成的 `formatSkillsForSystemPrompt()`),正文永不进提示词,模型按需 read。
- **热更新**:仿 `reloadSubagents()` 模式——变更命令后刷新缓存,并对所有运行中会话重组提示词热替换 `agent.state.systemPrompt`(mechanism 已在 `modes.ts:435-449 applyMode` 验证过,`loopContext.systemPrompt` 同步改写,轮中生效)。
- **Rust 层零改动**:全部走现有 `pi_request` 通用通道。

### 目录与作用域

| 作用域 | 目录 | 可编辑 | 遮蔽优先级 |
|---|---|---|---|
| workspace | `<cwd>/.xulux/skills/` | ✅ | 1(最高) |
| system | `~/.xulux/skills/` | ✅ | 2 |
| compat | `<cwd>/.agents/skills/` 与 `~/.agents/skills/` | ❌(只读,可开关) | 3 |

文件格式:SKILL.md frontmatter(`name`、`description`、可选 `disable-model-invocation`)+ Markdown 正文。根级 `<slug>.md`(带 frontmatter)和 `<dir>/SKILL.md` 目录形式都识别(pi-agent-core `loadSkills` 原生支持)。同名技能按上表优先级遮蔽。

### Sidecar 改动(sidecar/pi-agent)

1. **新建 `src/skills.ts`**:
   - 目录函数 `systemSkillsDir()` / `workspaceSkillsDir(cwd)` / compat 目录,仿 `subagent-definitions.ts:81-92`
   - `ensureSkillsLoaded(cwd)`:按目录签名缓存(仿 `loadSubagentDefinitions` 的签名缓存),用 `loadSkills(NodeExecutionEnv, dirs, ...)`(from `@earendil-works/pi-agent-core/node`)加载,`loadSourcedSkills` 带 source 标签后按优先级遮蔽去重
   - `skillsPromptBlock(cwd)`:读缓存 → 过滤 disabled → `formatSkillsForSystemPrompt()`,空时返回 `""`
   - 开关:`initSkillsState()` / `setSkillEnabled()` / `skillStateKey()`,键 `pi.skills`,抄 `mcp-config.ts:383-427` 模式
   - CRUD:`saveSkillDoc`(渲染 frontmatter+body 写 `<slug>.md`,支持 replaceName 改名清旧文件)、`deleteSkillDoc`(compat scope 拒绝)、`skillsPayload(cwd)` 清单载荷
   - `reloadSkills()`:刷缓存 + 遍历 `running` 会话重组 systemPrompt 热替换(仿 `sessions.ts:152-159`)
2. **`src/modes.ts:92-108`**:`composeModeSystemPrompt` 数组在 `mcpPromptBlock` 之后插入 `skillsPromptBlock(cwd)`(技能目录属能力清单段,环境块之前),同步读缓存;更新文件头注释。
3. **`src/sessions.ts`**:`resolveSession` 组装提示词前 `await ensureSkillsLoaded(resolvedCwd)` 预热缓存。
4. **`src/protocol.ts`**:新增 4 个命令(仿 `:1209-1279` 的 subagents 处理,变更命令尾部 `await reloadSkills()` 再回清单):
   - `list_skills` → `{id, type: "skills", skills, workspaceCwd, diagnostics}`
   - `save_skill`(scope/cwd?/definition{name,description,content}/name?=改名前原名)
   - `delete_skill`(scope/name/cwd?)
   - `set_skill_enabled`(scope/name/enabled/cwd?)
   - 文件头协议注释与命令类型同步更新
5. **`src/index.ts`**:init 闸门加 `initSkills()`。

### 前端改动

6. **`lib/pi-bridge.ts`**:加 `PiSkillEntry`、`PiSkillsResponse` 类型,`PiResponse` 联合加 `"skills"`。
7. **新建 `lib/skills.ts`**(~150 行,严格仿 `lib/subagents.ts`):`useSkills(cwd)` useSyncExternalStore 镜像 store;`saveSkill`/`deleteSkill`/`setSkillEnabled` 变更命令(应答即新清单);`SkillDraft`;`skillTemplate(name)` 内置模板(When to use / Steps / Notes,参考 PI-Desktop 的开箱即用模板)。
8. **新建 `components/settings/components/skills-settings.tsx`**(仿 `subagents-settings.tsx` 结构):
   - 作用域 Segmented 过滤(全部/系统/工作区/生态兼容)
   - 列表行:名称、描述、路径、大小、启用开关(乐观更新)
   - 新建/编辑 dialog:name、description、content textarea + 字节数提示;导入文件(.md/SKILL.md)读入为草稿
   - compat 条目只读(无编辑/删除,保留开关);删除需确认;诊断信息(坏文件)展示
9. **`components/settings/settings-page.tsx:70-73`**:智能体组插入 `{ id: "skills", label: "技能" }` + 渲染分支,`SettingsSection` 联合加 `"skills"`。

### 测试

10. **新建 `sidecar/pi-agent/src/skills.test.ts`**(bun test,仿 `memory.test.ts` 风格):目录发现与格式解析、同名遮蔽优先级、开关过滤(禁用不出现在 prompt 块)、CRUD 与改名清旧文件、compat 只读拒绝写、提示词块空态字节不变。

不改任何 Rust 代码;`pi_request` 通道、NDJSON 协议、设置页框架全部复用。