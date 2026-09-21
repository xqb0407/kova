/**
 * 技能（SKILL.md 指令文档）的来源、解析与运行时状态（设置 → 技能）。
 *
 * 渐进式披露：系统提示词只注入"生效技能"的目录（pi-agent-core 的
 * formatSkillsForSystemPrompt：<available_skills> XML，每技能 name/description/
 * location 三行）；正文永不进提示词——模型判断任务匹配后经 use_skill 工具按
 * 名加载（skill-use-tool.ts；目录段指引已改指该工具）。禁用或被遮蔽的技能连
 * 目录行都不出现。
 *
 * 来源分层，同名时前层遮蔽后层（工作区 > 生态·工作区 > 系统 > 生态·用户）：
 * - 工作区（可编辑）：<cwd>/.xulux/skills/*.md
 * - 生态·工作区（只读）：<cwd>/.agents/skills/（agentskills.io 标准目录，
 *   根级 .md 与 <dir>/SKILL.md 都识别，直接复用社区技能包）
 * - 系统（可编辑）：应用数据目录 skills/（生产由 Rust 注入 PI_DB_PATH 同级
 *   推导，兜底 ~/.xulux/skills；测试经 PI_SKILLS_DIR 钉住）
 * - 生态·用户（只读）：~/.agents/skills
 *
 * 文件格式：YAML frontmatter（name/description，可选 disable-model-invocation）
 * + Markdown 正文。加载走 pi-agent-core 的 loadSkills（NodeExecutionEnv），
 * 与 agentskills.io 规范一致（SKILL.md 嵌套、ignore 文件、命名/描述校验诊断）。
 * 注意：根级 .md 不写 name 时库会以父目录名兜底（同层多个无名文件会互相撞名），
 * 设置页写出的文件恒带 name，无此问题；同名遮蔽在 merge 时统一裁决。
 *
 * 启用开关是"本机的运行时决定"，不写进技能文件（工作区文件在 git 里）：
 * 整包存 SQLite kv（key = SKILLS_STATE_KV_KEY），与子智能体/MCP 同款链路。
 *
 * 缓存：目录树签名（递归含嵌套 SKILL.md 的 mtime——frontmatter 改动必须失效
 * 目录；正文改动不影响提示词，模型每次 read 都拿磁盘现值）。签名没变用缓存。
 * 保存/删除/开关后 protocol 层调 sessions.reloadSkills()：刷缓存 + 对活动会话
 * 重组系统提示词热替换（与 reloadSubagents / applyMode 同款手法）。
 *
 * 物理布局（本文件为门面，签名与原单文件完全一致）：
 * - ./skills/state.ts      启用开关（kv）+ stateKey 规则
 * - ./skills/discovery.ts  四层目录发现/合并/快照 + 提示词目录段
 * - ./skills/docs.ts       文档解析/渲染/校验/落盘
 */
export {
  type SkillScope,
  type SkillsState,
  SKILLS_STATE_KV_KEY,
  normalizeSkillName,
  skillStateKey,
  initSkillsState,
  isSkillDisabled,
  setSkillEnabled,
  MAX_SKILL_BATCH_TARGETS,
  setSkillsEnabled,
} from "./state";

export {
  type LoadedSkill,
  type SkillEntry,
  type SkillsSnapshot,
  systemSkillsDir,
  workspaceSkillsDir,
  compatHomeSkillsDir,
  compatWorkspaceSkillsDir,
  MAX_PER_LAYER,
  ensureSkillsLoaded,
  skillsSnapshot,
  skillsPromptBlock,
  listPluginSkillEntries,
} from "./discovery";

export {
  type SkillDraft,
  type SkillWriteOptions,
  MAX_SKILL_BYTES,
  parseSkillDoc,
  renderSkillDoc,
  skillFileName,
  saveSkillDoc,
  deleteSkillDoc,
} from "./docs";

import { resetSkillsStateForTest } from "./state";
import { clearSkillCaches } from "./discovery";

/** 测试钩子：清掉 kv 装载与目录缓存，回到全默认状态 */
export function resetSkillsForTest(): void {
  resetSkillsStateForTest();
  clearSkillCaches();
}
