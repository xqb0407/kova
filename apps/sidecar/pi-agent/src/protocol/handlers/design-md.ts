/**
 * 设计主题命令：清单/取正文/保存/删除（管理页）+ 会话级选中（composer 胶囊）。
 * 存储与快照在 design-md/store，「最近使用」在 design-md/state，会话偏好落
 * sessions.design_theme 列（恢复链见 sessions/resolve.ts）。
 * 变更后热替换与 reloadSkills 同款：refreshThemes 刷快照 → 活动会话提示词里
 * design 段主题句行随之增删（set 只重排目标会话，save/delete 重排全部）。
 */
import { send } from "../stream";
import { resolveSession } from "../../sessions/sessions";
import { running } from "../../sessions/registry";
import { composeModeSystemPrompt } from "../../agent/modes";
import { sessionPrefsSet } from "../../storage/hostdb";
import {
  deleteUserTheme,
  findTheme,
  normalizeThemeRef,
  parseThemeDoc,
  readThemeDocRaw,
  refreshThemes,
  saveUserTheme,
  type DesignThemeSnapshot,
  type ThemeRef,
  type UserThemeDraft,
} from "../../design-md/store";
import { encodeThemeColumn, setLastUsedDesignTheme } from "../../design-md/state";
import { remapThemeRefs } from "../../design-md/ref-integrity";
import type { Running } from "../../types";
import type { CommandHandler } from "../command";

/** 管理页改主题（save/delete/fork）后全量热替换：快照变了，所有 design 档
 *  会话的主题句（名称/描述/被删后的消失）都要跟上 */
function recomposeAllRuns(): void {
  for (const run of running.values()) {
    const prompt = composeModeSystemPrompt(run.mode, run.cwd, run.agent.state.model, run.designTheme);
    run.agent.state.systemPrompt = prompt;
    if (run.loopContext) run.loopContext.systemPrompt = prompt;
  }
}

/** 会话级选中落点：改 run 字段 + 只重排该会话提示词 + 偏好列/最近使用落库
 *  （fire-and-forget，与 persistModePrefs 同款容错） */
function applySessionTheme(run: Running, ref: ThemeRef | null): void {
  run.designTheme = ref;
  const prompt = composeModeSystemPrompt(run.mode, run.cwd, run.agent.state.model, run.designTheme);
  run.agent.state.systemPrompt = prompt;
  if (run.loopContext) run.loopContext.systemPrompt = prompt;
  void sessionPrefsSet(run.sessionId, { designTheme: encodeThemeColumn(ref) }).catch(() => {});
  void setLastUsedDesignTheme(ref).catch(() => {});
}

async function designThemesPayload(): Promise<DesignThemeSnapshot> {
  return await refreshThemes();
}

/**
 * 多窗口/远程推送：无 id 自发通知帧（本地各窗口走 Rust pi-chunk-batch 原样
 * 广播，远程连接走 remote.rs 白名单）。发起方窗口已收带 id 应答，再收到同
 * 数据推送帧属幂等覆写不冲突。set 推送带 threadId 供他窗胶囊直更；
 * 清单推送只在 save/delete（set 不改清单）。
 */
function pushDesignThemes(snap: DesignThemeSnapshot): void {
  send({ type: "design_themes", ...snap });
}

function pushDesignThemeSet(t: {
  threadId: string;
  sessionId: string;
  theme: ThemeRef | null;
}): void {
  send({ type: "design_theme_set", threadId: t.threadId, sessionId: t.sessionId, theme: t.theme });
}

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
    send({ id: reqId, type: "design_themes", ...(await designThemesPayload()), ...active });
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
    // 改名（frontmatter name 变化 → 新 id）：指向旧 id 的一切引用重映射到新
    // id，用户正在用的主题不断链（未驻留会话/驻留 run/最近使用 kv 一起跟齐）
    const changed = replaceId && replaceId !== ref.id
      ? await remapThemeRefs({ scope: "user", id: replaceId }, ref)
      : [];
    // 归一名撞车清扫（大小写不敏感文件系统上 "Kova"/"kova" 同一文件、或旧
    // stem 不同但同名）：被合并掉的其他 id 的引用同样跟到新 id，不留悬空
    for (const oldId of clobbered) {
      if (oldId === ref.id || oldId === replaceId) continue;
      changed.push(...(await remapThemeRefs({ scope: "user", id: oldId }, ref)));
    }
    const snap = await designThemesPayload();
    recomposeAllRuns();
    send({ id: reqId, type: "design_theme_saved", ref, ...snap });
    pushDesignThemes(snap);
    for (const t of changed) pushDesignThemeSet(t);
  },

  delete_design_theme: async (reqId, msg) => {
    if (msg.scope !== "user") throw new Error('delete_design_theme: scope must be "user"（内置主题不可删，可另存为自己的主题后修改）');
    const id = String(msg.themeId ?? "");
    if (!id) throw new Error("delete_design_theme: themeId is required");
    deleteUserTheme(id);
    // 引用了该主题的一切落点收口为「显式不使用」：未驻留会话的偏好列、驻留
    // run 字段、恰好指向它的最近使用 kv（不静默回落成别的主题）
    const changed = await remapThemeRefs({ scope: "user", id }, null);
    const snap = await designThemesPayload();
    recomposeAllRuns();
    send({ id: reqId, type: "design_themes", ...snap });
    pushDesignThemes(snap);
    for (const t of changed) pushDesignThemeSet(t);
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
      await designThemesPayload();
      if (!findTheme(ref)) throw new Error(`set_design_theme: theme not found: ${ref.scope}/${ref.id}`);
    }
    applySessionTheme(run, ref);
    send({ id: reqId, type: "design_theme_set", sessionId: run.sessionId, theme: ref });
    pushDesignThemeSet({ threadId: run.threadId, sessionId: run.sessionId, theme: ref });
  },
};
