/**
 * 技能命令：清单/保存/删除/单条开关/批量开关（改完 reloadSkills 热重载再回清单）。
 * 文档落盘与开关在 skills/（docs + state），重载热替换在 sessions。
 */
import { send } from "../stream";
import { reloadSkills } from "../../sessions/sessions";
import {
  deleteSkillDoc,
  MAX_SKILL_BATCH_TARGETS,
  parseSkillDoc,
  saveSkillDoc,
  setSkillEnabled,
  setSkillsEnabled,
  type SkillScope,
} from "../../skills/skills";
import { skillsPayload } from "../payloads";
import type { CommandHandler } from "../command";

/** 技能 scope 字段校验：五个来源层之外回 null */
function skillScopeFrom(value: unknown): SkillScope | null {
  return value === "workspace" ||
    value === "compat-workspace" ||
    value === "system" ||
    value === "compat" ||
    value === "plugin"
    ? (value as SkillScope)
    : null;
}

export const handlers: Record<string, CommandHandler> = {
  list_skills: async (reqId, msg) => {
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
  },

  save_skill: async (reqId, msg) => {
    const scope: "system" | "workspace" | null =
      msg.scope === "workspace" ? "workspace" : msg.scope === "system" ? "system" : null;
    if (!scope) throw new Error('save_skill: scope must be "system" or "workspace"');
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    if (scope === "workspace" && !cwd) {
      throw new Error("save_skill: workspace scope requires cwd");
    }
    // 两种载荷：表单结构体（definition）或文档原文（raw，走同一解析校验；
    // raw 缺 frontmatter name 时以 fallbackName（导入文件名 stem）兜底）
    let draft;
    if (typeof msg.raw === "string") {
      const fallbackName =
        typeof msg.fallbackName === "string" ? msg.fallbackName : undefined;
      const parsed = parseSkillDoc(msg.raw, {
        ...(fallbackName ? { fallbackName } : {}),
      });
      if (!parsed.ok) throw new Error(parsed.errors.join("；"));
      draft = parsed.draft;
    } else {
      const d = (msg.definition ?? {}) as Record<string, unknown>;
      draft = {
        name: String(d.name ?? ""),
        description: String(d.description ?? ""),
        content: String(d.content ?? ""),
        ...(d.disableModelInvocation === true ? { disableModelInvocation: true } : {}),
      };
    }
    // name = 编辑前的原名（改名时据此清掉旧文件；新建省略）
    const replaceName =
      typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : undefined;
    await saveSkillDoc(scope, draft, { cwd, ...(replaceName ? { replaceName } : {}) });
    await reloadSkills();
    send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
  },

  delete_skill: async (reqId, msg) => {
    const scope: "system" | "workspace" | null =
      msg.scope === "workspace" ? "workspace" : msg.scope === "system" ? "system" : null;
    if (!scope) throw new Error('delete_skill: scope must be "system" or "workspace"');
    const name = String(msg.name ?? "");
    if (!name) throw new Error("delete_skill: name is required");
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    if (scope === "workspace" && !cwd) {
      throw new Error("delete_skill: workspace scope requires cwd");
    }
    await deleteSkillDoc(scope, name, { cwd });
    await reloadSkills();
    send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
  },

  set_skill_enabled: async (reqId, msg) => {
    const scope = skillScopeFrom(msg.scope);
    if (!scope) throw new Error("set_skill_enabled: invalid scope");
    const name = String(msg.name ?? "");
    if (!name) throw new Error("set_skill_enabled: name is required");
    const pluginId =
      scope === "plugin" && typeof msg.pluginId === "string" ? msg.pluginId : undefined;
    if (scope === "plugin" && !pluginId) {
      throw new Error("set_skill_enabled: plugin scope requires pluginId");
    }
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    const enabled = msg.enabled === true;
    await setSkillEnabled(scope, name, enabled, cwd, pluginId);
    await reloadSkills();
    send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
  },

  set_skills_enabled: async (reqId, msg) => {
    // 批量开关（设置页「全部启用 / 全部关闭」快捷）：整表置为目标态，一次落盘
    const rawTargets = Array.isArray(msg.targets) ? msg.targets : [];
    if (rawTargets.length === 0) throw new Error("set_skills_enabled: targets is required");
    if (rawTargets.length > MAX_SKILL_BATCH_TARGETS) {
      throw new Error(
        `set_skills_enabled: too many targets (max ${MAX_SKILL_BATCH_TARGETS})`,
      );
    }
    const targets: Array<{ scope: SkillScope; name: string }> = [];
    for (const item of rawTargets) {
      const t = (item ?? {}) as Record<string, unknown>;
      const scope = skillScopeFrom(t.scope);
      if (!scope) throw new Error("set_skills_enabled: invalid scope");
      const name = String(t.name ?? "");
      if (!name) throw new Error("set_skills_enabled: name is required");
      targets.push({ scope, name });
    }
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    const enabled = msg.enabled === true;
    await setSkillsEnabled(targets, enabled, cwd);
    await reloadSkills();
    send({ id: reqId, type: "skills", ...(await skillsPayload(cwd)) });
  },
};
