/**
 * 设计主题加载工具（use_design_theme）：按名加载一份设计主题（DESIGN.md 风格
 * 规范）的完整正文。use_skill 的同款渐进披露半环——design 模式提示词段只列当前
 * 主题名一行，正文经本工具取，59 套 × 20KB 永不进常驻上下文。
 *
 * - 参数 name 可省：省 = 当前会话选中的主题（resolve 期注入的 run.designTheme
 *   闭包读值，未选则回落「最近一次使用」）；给了 name = 按名解析（用户层遮蔽内置层）。
 * - 正文每次现读（builtin = zip 内存副本；user = 磁盘现值，管理页改后即见）。
 * - 重复加载短路（run 内台账 getLoaded）：同 ref 同正文哈希已在上下文时只回
 *   简短确认，不再重贴 ~20KB 全文；正文变了（管理页编辑）哈希失配自动重贴；
 *   压缩清空台账后同样重贴（见 runCompaction / types.Running.designThemeLoads）。
 * - 挂 baseTools（只读动作，不进审批集），与 use_skill 同区注册。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  findTheme,
  readThemeContent,
  resolveThemeByName,
  themesSnapshot,
  type ThemeRef,
} from "./store";

export const USE_DESIGN_THEME_TOOL_NAME = "use_design_theme";

/** fnv-1a 正文指纹（附长度）：短路判定只关心「同一段全文是否还在上下文」 */
function contentFingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${h >>> 0}:${s.length}`;
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text: `错误：${text}` }],
    details: { error: text },
  };
}

export function buildUseDesignThemeTool(
  getDesignTheme: () => ThemeRef | null,
  getLoaded?: () => Map<string, string> | undefined,
): AgentTool {
  return {
    name: USE_DESIGN_THEME_TOOL_NAME,
    label: "加载设计主题",
    description: [
      "加载一份设计主题（品牌设计系统规范 DESIGN.md 全文：色板、字号阶梯、间距、组件与氛围规则）并返回正文。",
      "设计模式下动笔前必须调用本工具加载当前会话选中的设计主题（不带 name 参数即当前主题），并全程遵循其规范；",
      "用户点名换风格时可传 name（如 “Linear”、“Apple”），我的主题优先于同名内置主题。",
      "未选中任何主题且没传 name 会报错并列出可用主题名。",
      "全文只会在不在你的上下文时贴出：重复调用若返回「已加载」短确认，说明规范此刻就在上下文，直接照做即可；上下文压缩后下一次调用会自动重贴全文。",
    ].join("\n"),
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "主题名称（省略 = 当前会话选中的主题）" }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const nameArg = String((params as { name?: unknown })?.name ?? "").trim();
      let ref: ThemeRef | null = null;
      if (nameArg) {
        ref = resolveThemeByName(nameArg);
        if (!ref) {
          const names = themesSnapshot().entries.map((e) => e.name).join("、") || "（没有可用主题）";
          return errorResult(`没有名为 "${nameArg}" 的设计主题。当前可用：${names}`);
        }
      } else {
        // 缺省目标只认「本会话选中的主题」，不再兜底全局最近使用：
        // 「新会话/从未设过主题的旧会话继承最近一次使用」已经由 resolveSession
        // 在建 run 时做进 run.designTheme（偏好列 NULL ⇒ 取最近使用；列 = ""
        // ⇒ 显式不使用），这里再兜一次会把这三态压平成一态——用户明明选了
        // 「不使用主题」，工具却递上一份全局主题，模型据此宣称"按你选的设计
        // 风格来做"，而用户在界面上根本没选过任何风格。
        ref = getDesignTheme();
        if (!ref) {
          return errorResult(
            "当前会话没有选中设计主题，且未提供 name。请在会话输入框的主题胶囊中选择，或带 name 参数调用。",
          );
        }
      }
      const entry = findTheme(ref);
      if (!entry) return errorResult(`主题不存在: ${ref.id}`);
      const content = await readThemeContent(ref);
      if (content === null) {
        return errorResult(`读取主题正文失败: ${entry.name}（${entry.scope === "builtin" ? "内置包缺文件" : "文件缺失"}）`);
      }
      const scopeZh = entry.scope === "builtin" ? "内置主题包" : "我的主题";
      // 重复加载短路：台账记着这段全文已在上下文且未变化 → 只回确认不重贴
      const key = `${entry.scope}/${entry.id}`;
      const fp = contentFingerprint(content);
      const loads = getLoaded?.();
      if (loads && loads.get(key) === fp) {
        return textResult(
          `设计主题 "${entry.name}"（${scopeZh}）的规范全文此前已加载、内容未变化：重复加载已短路以节省上下文，请直接沿用先前 use_design_theme 返回的全文继续创作。若该全文已不在可见上下文（如经历过压缩），再次调用本工具会自动重新返回全文。`,
          { id: entry.id, name: entry.name, scope: entry.scope, deduped: true },
        );
      }
      const text = [
        `已加载设计主题 "${entry.name}"（${scopeZh}）`,
        entry.desc ? `风格概要：${entry.desc}` : "",
        "以下规范全文对当前任务生效：色板与角色、字体/字号阶梯、间距与栅格、圆角、阴影、组件形态与整体氛围。与本段冲突的通用默认（如配色习惯、字号偏好）一律让位于主题规范。",
        "",
        content,
      ]
        .filter((l) => l !== "")
        .join("\n");
      loads?.set(key, fp);
      return textResult(text, { id: entry.id, name: entry.name, scope: entry.scope });
    },
  };
}
