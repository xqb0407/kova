/**
 * 设计主题命令：清单/取正文/保存/删除（管理页）+ 会话级选中（composer 胶囊）。
 * 存储与快照在 design-md/store，「最近使用」在 design-md/state，会话偏好落
 * sessions.design_theme 列（恢复链见 sessions/resolve.ts）。
 * 变更后的生效链（引用重映射 → 刷快照 → 重排活动会话提示词 → 多窗口广播）在
 * design-md/apply，与 AI 管理工具（design-md/mgmt-tools）共用同一条。
 */
import { send } from "../stream";
import { resolveSession } from "../../sessions/sessions";
import {
  applySessionTheme,
  applyThemeDelete,
  applyThemeSave,
  broadcastThemeSet,
  finishThemeMutation,
} from "../../design-md/apply";
import {
  deleteUserTheme,
  findTheme,
  normalizeThemeRef,
  parseThemeDoc,
  readThemeDocRaw,
  refreshThemes,
  saveUserTheme,
  type ThemeRef,
  type UserThemeDraft,
} from "../../design-md/store";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  list_design_themes: async (reqId, msg) => {
    // 带 threadId 时顺带回该会话的当前选中（前端刷新水合胶囊用，同 get_planning_state 口径；
    // null = 该会话显式不使用主题）
    let active: { active: ThemeRef | null } | Record<string, never> = {};
    if (typeof msg.threadId === "string" && msg.threadId.trim()) {
      const run = await resolveSession(
        msg.threadId,
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      );
      active = { active: run.designTheme ?? null };
    }
    send({ id: reqId, type: "design_themes", ...(await refreshThemes()), ...active });
  },

  get_design_theme: async (reqId, msg) => {
    // 取主题全文（编辑回填 / 预览 / fork 另存为）：user = 磁盘原文（含 frontmatter），
    // builtin = zip 内 DESIGN.md 原文（catalog 元数据另在清单里）
    const ref = normalizeThemeRef(msg.ref ?? msg);
    if (!ref) throw new Error("get_design_theme: ref {scope,id} is required");
    const entry = findTheme(ref);
    if (!entry) throw new Error(`get_design_theme: theme not found: ${ref.scope}/${ref.id}`);
    let doc: string | null;
    try {
      doc = await readThemeDocRaw(ref);
    } catch (err) {
      throw new Error(`get_design_theme: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (doc === null) throw new Error(`get_design_theme: content missing: ${ref.scope}/${ref.id}`);
    send({ id: reqId, type: "design_theme_doc", ref, entry, doc });
  },

  save_design_theme: async (reqId, msg) => {
    // 两种载荷（同 save_skill）：表单结构体（definition）或文档原文（raw，
    // 走 parseThemeDoc 同一校验；raw 缺 frontmatter name 时以 fallbackName 兜底）
    let draft: UserThemeDraft;
    if (typeof msg.raw === "string") {
      const fallbackName = typeof msg.fallbackName === "string" ? msg.fallbackName : undefined;
      const parsed = parseThemeDoc(msg.raw, { ...(fallbackName ? { fallbackName } : {}) });
      if (!parsed.ok) throw new Error(parsed.errors.join("；"));
      draft = parsed.draft;
    } else {
      const d = (msg.definition ?? {}) as Record<string, unknown>;
      const accents = Array.isArray(d.accents)
        ? (d.accents as unknown[]).filter((a): a is string => typeof a === "string").slice(0, 4)
        : undefined;
      draft = {
        name: String(d.name ?? ""),
        description: String(d.description ?? ""),
        content: String(d.content ?? ""),
        ...(accents && accents.length ? { accents } : {}),
      };
    }
    // themeId = 编辑对象的既有用户主题（改名保存时据此清旧文件并重映射引用；
    // 新建/另存为省略。业务 id 不能走裸 id 字段：协议 reqId 占用，WS 通道会覆写）
    const replaceId =
      msg.scope === "user" && typeof msg.themeId === "string" && msg.themeId.trim()
        ? msg.themeId.trim()
        : undefined;
    const { ref, clobbered } = await saveUserTheme(draft, { ...(replaceId ? { replaceId } : {}) });
    // 生效链：改名/合并清扫的引用重映射 → 刷快照 → 重排全部活动会话提示词
    const mutation = await applyThemeSave(ref, { ...(replaceId ? { replaceId } : {}), clobbered });
    send({ id: reqId, type: "design_theme_saved", ref, ...mutation.snap });
    finishThemeMutation(mutation);
  },

  delete_design_theme: async (reqId, msg) => {
    if (msg.scope !== "user") throw new Error('delete_design_theme: scope must be "user"（内置主题不可删，可另存为自己的主题后修改）');
    const id = String(msg.themeId ?? "");
    if (!id) throw new Error("delete_design_theme: themeId is required");
    deleteUserTheme(id);
    // 生效链：引用了该主题的一切落点收口为「显式不使用」（未驻留会话的偏好列、
    // 驻留 run 字段、恰好指向它的最近使用 kv），再刷快照、重排
    const mutation = await applyThemeDelete(id);
    send({ id: reqId, type: "design_themes", ...mutation.snap });
    finishThemeMutation(mutation);
  },

  set_design_theme: async (reqId, msg) => {
    // 会话级选中（composer 主题胶囊）：null = 显式不使用主题（落库为 ""，
    // 区别于从未设置；重开会话不再回落最近使用）
    const run = await resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      typeof msg.cwd === "string" ? msg.cwd : undefined,
    );
    let ref: ThemeRef | null;
    if (msg.theme === null || msg.theme === undefined) {
      ref = null;
    } else {
      ref = normalizeThemeRef(msg.theme);
      if (!ref) throw new Error("set_design_theme: theme must be {scope,id} or null");
      // 存在性校验按实时快照（管理页可能刚删过）：缺失即拒绝，胶囊不落空指向
      await refreshThemes();
      if (!findTheme(ref)) throw new Error(`set_design_theme: theme not found: ${ref.scope}/${ref.id}`);
    }
    // set 只重排目标会话（变更全量重排在 apply 的 save/delete 链里）
    applySessionTheme(run, ref);
    send({ id: reqId, type: "design_theme_set", sessionId: run.sessionId, theme: ref });
    broadcastThemeSet({ threadId: run.threadId, sessionId: run.sessionId, theme: ref });
  },
};
