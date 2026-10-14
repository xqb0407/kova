/**
 * 主代理的设计主题管理工具组：design_themes_list / design_theme_save / design_theme_delete。
 *
 * 与技能管理组（skill-mgmt-tools）同款设计：执行体直接复用存储层函数
 * （design-md/store），让设置页有的一切语义——frontmatter 解析与校验、256KB
 * 上限、同名覆盖、改名清旧、遮蔽裁决——都长在同一处；保存/删除后的生效链
 * （引用重映射 → 刷快照 → 重排活动会话提示词 → 多窗口广播）经 deps 注入，
 * 由 sessions/resolve.ts 装配——本模块不引 design-md/apply（它引 agent/modes，
 * 而 modes 要引本模块取审批名单，直引成环）。
 * 管理组挂在 Task 组旁边、不在 baseTools 里：delegate 按定义取工具时结构性
 * 拿不到它们。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { logErr } from "../log";
import { userThemesDir } from "./paths";
import {
  deleteUserTheme,
  parseThemeDoc,
  refreshThemes,
  resolveThemeByName,
  saveUserTheme,
  themesSnapshot,
  type DesignThemeSnapshot,
  type SaveUserThemeResult,
  type ThemeRef,
  type UserThemeDraft,
} from "./store";

export const DESIGN_THEME_MGMT_TOOL_NAMES = {
  list: "design_themes_list",
  save: "design_theme_save",
  delete: "design_theme_delete",
} as const;

/**
 * 生效链依赖（由 sessions/resolve.ts 装配）：保存/删除落盘之后走这里，
 * 与设置页管理操作共用同一条链（design-md/apply）。
 */
export type DesignThemeMgmtDeps = {
  /** 保存生效：remap 引用 → 刷快照 → 重排活动会话提示词 → 广播；返回新快照 */
  afterSave: (
    ref: ThemeRef,
    options: { replaceId?: string; clobbered: string[] },
  ) => Promise<DesignThemeSnapshot>;
  /** 删除生效：引用收口为「不使用主题」→ 刷快照 → 重排 → 广播；返回新快照 */
  afterDelete: (id: string) => Promise<DesignThemeSnapshot>;
  /** 把主题设为当前会话选中（胶囊即时切换 + 提示词重排 + 广播） */
  applyToSession: (ref: ThemeRef) => void;
};

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text: `错误：${text}` }],
    details: { error: text },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const norm = (v: string): string => v.trim().toLowerCase();

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function buildDesignThemeMgmtTools(deps: DesignThemeMgmtDeps): AgentTool[] {
  const listTool: AgentTool = {
    name: DESIGN_THEME_MGMT_TOOL_NAMES.list,
    label: "列出设计主题",
    description: [
      "列出全部设计主题（「我的主题」+ 只读的内置主题包）：名称、风格概要、代表色、字节数与遮蔽状态。",
      "创建、覆盖或删除主题前先调用它：你会直接看到哪些名字已被占用、哪些内置主题可作参照，不必去猜。",
      "要看某套主题的规范全文，用 use_design_theme（按名或当前会话选中的主题加载）。",
    ].join("\n\n"),
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("user"), Type.Literal("builtin")], {
          description: '列出哪一层：缺省 "all"；只看自己的主题传 "user"',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { scope?: unknown };
      const scope = p.scope === "user" || p.scope === "builtin" ? p.scope : "all";
      try {
        const snap = await refreshThemes();
        const lines: string[] = [`我的主题目录（可编辑）：${userThemesDir()}`, ""];
        const user = snap.entries.filter((e) => e.scope === "user");
        const builtin = snap.entries.filter((e) => e.scope === "builtin");
        if (scope !== "builtin") {
          lines.push(`我的主题（${user.length}）：`);
          if (user.length === 0) lines.push("（空）");
          for (const e of user) {
            const extras = [
              e.desc || "",
              e.accents.length > 0 ? `代表色 ${e.accents.join(", ")}` : "",
              typeof e.sizeBytes === "number" ? formatBytes(e.sizeBytes) : "",
            ].filter(Boolean);
            lines.push(`- ${e.name}${extras.length > 0 ? ` — ${extras.join(" · ")}` : ""}`);
          }
          lines.push("");
        }
        if (scope !== "user") {
          lines.push(`内置主题包（${builtin.length}，只读；同名时被「我的主题」遮蔽）：`);
          if (builtin.length === 0) lines.push("（空——主题包装载失败时点设置页刷新重试）");
          for (const e of builtin) {
            const extras = [
              e.desc || "",
              e.accents.length > 0 ? `代表色 ${e.accents.join(", ")}` : "",
              e.shadowed ? "已被同名我的主题覆盖" : "",
            ].filter(Boolean);
            lines.push(`- ${e.name} (id: ${e.id})${extras.length > 0 ? ` — ${extras.join(" · ")}` : ""}`);
          }
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  };

  const saveTool: AgentTool = {
    name: DESIGN_THEME_MGMT_TOOL_NAMES.save,
    label: "保存设计主题",
    description: [
      "创建或同名覆盖一套设计主题（DESIGN.md 设计系统规范），保存到「我的主题」层：本机所有会话可用，与内置主题同名时遮蔽内置。",
      "用这个工具而不是 write/edit 手写文件——只有它会做 frontmatter 生成与校验、256KB 上限检查、同名覆盖与改名清理，并把新主题热刷进清单、胶囊与活动会话的提示词。",
      "content 是规范正文（Markdown），按可执行的设计系统写：色板（具体 hex 值与角色）、字体与字号阶梯、间距与栅格、圆角与阴影、组件形态、整体氛围；只写模型不知道的约束，不要空泛形容词。可先用 use_design_theme 参考一套内置主题的正文结构。",
      "正文不要自己写 frontmatter（name/description/accents 走参数）；若正文里带了 frontmatter，工具会剥掉并回填缺省字段。",
      'use=true 时保存后把该主题设为当前会话的设计主题（胶囊即时切换，design 模式随后强制按它创作）——仅当用户就是要本会话用它（例如“照这个风格来做”）时才传。',
      "编辑改名：传 replace_name=旧主题名，旧文件一并清掉、指向旧主题的会话引用自动跟到新主题。",
    ].join("\n\n"),
    parameters: Type.Object({
      name: Type.String({ description: "主题名称，≤64 字符（同名 = 覆盖更新）" }),
      description: Type.Optional(
        Type.String({ description: "一句话风格概要（胶囊与清单里显示，如“暖橙工坊感，大圆角重投影”）" }),
      ),
      accents: Type.Optional(
        Type.Array(Type.String(), {
          description: "代表色 hex（最多 4 个，用于胶囊色点与色板预览；可省略）",
        }),
      ),
      content: Type.String({
        description: "设计规范正文（Markdown，不含 frontmatter）：色板与角色、字体/字号阶梯、间距、组件与氛围规则",
      }),
      replace_name: Type.Optional(
        Type.String({ description: "改名时的旧主题名（须是「我的主题」中已存在的；新建或同名保存省略）" }),
      ),
      use: Type.Optional(
        Type.Boolean({ description: "true = 保存后设为当前会话的设计主题；默认 false" }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as {
        name?: unknown;
        description?: unknown;
        accents?: unknown;
        content?: unknown;
        replace_name?: unknown;
        use?: unknown;
      };
      const name = String(p.name ?? "").trim();
      if (!name) return errorResult("name 不能为空");
      const rawContent = String(p.content ?? "");
      if (!rawContent.trim()) return errorResult("content（主题规范正文）不能为空");
      // 正文可能带 frontmatter（模型常直接贴一份 DESIGN.md）：同一解析器剥头，
      // 显式参数优先，缺省的 description/accents 用 frontmatter 里的值回填
      const parsed = parseThemeDoc(rawContent, { fallbackName: name });
      if (!parsed.ok) return errorResult(`正文解析失败：${parsed.errors.join("；")}`);
      const explicitAccents = Array.isArray(p.accents)
        ? (p.accents as unknown[])
            .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
            .map((a) => a.trim())
            .slice(0, 4)
        : [];
      const draft: UserThemeDraft = {
        name,
        description:
          typeof p.description === "string" && p.description.trim()
            ? p.description.trim()
            : parsed.draft.description,
        content: parsed.draft.content,
        ...(explicitAccents.length > 0
          ? { accents: explicitAccents }
          : parsed.draft.accents && parsed.draft.accents.length > 0
            ? { accents: parsed.draft.accents }
            : {}),
      };

      // replace_name → 既有用户主题 id；内置主题不能改名（同名保存即另存为我的主题）
      const replaceName = typeof p.replace_name === "string" ? p.replace_name.trim() : "";
      let replaceId: string | undefined;
      if (replaceName) {
        await refreshThemes();
        const old = resolveThemeByName(replaceName);
        if (!old) return errorResult(`没有名为 "${replaceName}" 的主题（replace_name 须是既有主题名）`);
        if (old.scope !== "user") {
          return errorResult(
            `"${replaceName}" 是内置主题，不能改名覆盖；直接用同名保存即可另存为「我的主题」`,
          );
        }
        replaceId = old.id;
      }

      let saved: SaveUserThemeResult;
      try {
        saved = await saveUserTheme(draft, { ...(replaceId ? { replaceId } : {}) });
      } catch (err) {
        return errorResult(errorMessage(err));
      }

      let snap: DesignThemeSnapshot;
      let effectsFailed = "";
      try {
        snap = await deps.afterSave(saved.ref, {
          ...(replaceId ? { replaceId } : {}),
          clobbered: saved.clobbered,
        });
      } catch (err) {
        effectsFailed = errorMessage(err);
        logErr("design-theme-mgmt: afterSave failed:", effectsFailed);
        snap = themesSnapshot();
      }

      if (p.use === true) {
        try {
          deps.applyToSession(saved.ref);
        } catch (err) {
          logErr("design-theme-mgmt: applyToSession failed:", errorMessage(err));
        }
      }

      const shadowedBuiltin = snap.entries.find(
        (e) => e.scope === "builtin" && e.shadowed && norm(e.name) === norm(name),
      );
      const lines = [
        `已保存（我的主题）："${saved.ref.id}" · ${name} → ${userThemesDir()}/${saved.ref.id}.md`,
        `已热生效：清单与胶囊即时可见；design 模式下可直接 use_design_theme（不带 name 加载当前会话选中的主题）按它创作。`,
      ];
      if (replaceId && replaceId !== saved.ref.id) {
        lines.push(`改名：旧主题已替换，引用它的会话已自动跟到新主题。`);
      }
      if (shadowedBuiltin) {
        lines.push(`与内置主题 "${shadowedBuiltin.name}" 同名：内置条目已被遮蔽（设置页「设计主题」可见双方）。`);
      }
      if (p.use === true) {
        lines.push("已把本会话的设计主题切换为它（胶囊即时更新）。");
      }
      if (effectsFailed) {
        lines.push(`注意：主题已落盘，但生效链刷新失败（${effectsFailed}）——刷新设置页或重开会话后可见。`);
      }
      return textResult(lines.join("\n"), { ref: saved.ref, clobbered: saved.clobbered });
    },
  };

  const deleteTool: AgentTool = {
    name: DESIGN_THEME_MGMT_TOOL_NAMES.delete,
    label: "删除设计主题",
    description: [
      "删除一套「我的主题」（内置主题包只读不可删）。删除即热生效：清单、胶囊与活动会话的提示词主题句同步收口，指向它的会话引用收口为「不使用主题」。",
      "删除前先与用户确认——被删的可能是用户正在用的主题；只是想调整内容，用 design_theme_save 同名覆盖即可。",
      "先 design_themes_list 拿到确切主题名，别凭记忆删。",
    ].join("\n\n"),
    parameters: Type.Object({
      name: Type.String({ description: "要删除的主题名（须是「我的主题」中的）" }),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { name?: unknown };
      const name = String(p.name ?? "").trim();
      if (!name) return errorResult("name 不能为空");
      await refreshThemes();
      const ref = resolveThemeByName(name);
      if (!ref) {
        const names = themesSnapshot()
          .entries.filter((e) => e.scope === "user")
          .map((e) => e.name);
        return errorResult(`没有名为 "${name}" 的主题。我的主题：${names.join("、") || "（空）"}`);
      }
      if (ref.scope !== "user") {
        return errorResult(
          `"${name}" 是内置主题，不可删除；如需调整，用 design_theme_save 同名保存覆盖出自己的版本`,
        );
      }
      try {
        deleteUserTheme(ref.id);
      } catch (err) {
        return errorResult(errorMessage(err));
      }
      let effectsFailed = "";
      try {
        await deps.afterDelete(ref.id);
      } catch (err) {
        effectsFailed = errorMessage(err);
        logErr("design-theme-mgmt: afterDelete failed:", effectsFailed);
      }
      return textResult(
        `已删除（我的主题）："${name}"。已热生效：清单/胶囊/活动会话主题句同步更新，指向它的会话已收口为「不使用主题」。` +
          (effectsFailed ? `（生效链刷新失败：${effectsFailed}）` : ""),
      );
    },
  };

  return [listTool, saveTool, deleteTool];
}
