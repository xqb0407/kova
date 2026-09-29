/**
 * 应用工作模式（work / code / design）：设置 → 通用里的全局开关，控制系统提示词的
 * 人群附加段。git UI 显隐与消息工具行形态在前端（lib/app-mode.ts 镜像 store），
 * 本模块只管 sidecar 侧的事实源。
 * - 事实源：SQLite kv（pi.app_mode）；启动 initAppMode() 恢复，非法值回落 "code"
 * - 注入点：modes.ts composeModeSystemPrompt 在个性化段之后插入 appModePromptBlock()；
 *   code 模式（默认）为空串，默认提示词与旧版字节级一致
 * - design 档附加段带插件可用条件句：compose 时现查 activePlugins() 是否含启用的
 *   ui-design 插件（前端门禁之外的兜底——绕过 UI 直发协议切档也有正确表现）
 * - 变更：protocol set_app_mode → applyAppMode 落 kv + 逐 running 会话重排系统
 *   提示词（set_personalization 同款广播），下一轮请求即生效
 * - 与会话级 agent/plan 模式（modes.ts 状态机）正交：那个切权限，这个切人群定位
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { activePlugins } from "../plugins/plugins";
import { findTheme, type ThemeRef } from "../design-md/store";
import { logErr } from "../log";

export type AppMode = "work" | "code" | "design";

export const APP_MODE_KV_KEY = "pi.app_mode";
export const DEFAULT_APP_MODE: AppMode = "code";

const APP_MODES: readonly AppMode[] = ["work", "code", "design"];

let current: AppMode = DEFAULT_APP_MODE;

/** 任意来源（kv JSON / 协议消息）的宽松规整：仅接受三档字面量，其余回落 code */
export function normalizeAppMode(raw: unknown): AppMode {
  return typeof raw === "string" && (APP_MODES as readonly string[]).includes(raw)
    ? (raw as AppMode)
    : "code";
}

/** 启动恢复：kv 读回；失败保持默认（不阻断启动） */
export async function initAppMode(): Promise<void> {
  try {
    const row = await kvGet(APP_MODE_KV_KEY);
    if (row?.value) {
      const parsed: unknown = JSON.parse(row.value);
      current = normalizeAppMode(parsed);
    }
  } catch (err) {
    logErr("app-mode: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv（模拟进程重启后内存为默认的起点） */
export function resetAppModeForTest(): void {
  current = DEFAULT_APP_MODE;
}

export function getAppMode(): AppMode {
  return current;
}

/** 应用新模式：内存即时生效；持久化失败仅记日志（下次启动回落） */
export async function applyAppMode(raw: unknown): Promise<AppMode> {
  const next = normalizeAppMode(raw);
  current = next;
  try {
    await kvSet(APP_MODE_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("app-mode: persist failed:", err);
  }
  return next;
}

/** work 模式的系统提示词附加段：面向非工程用户的交付物导向协作；显式声明冲突时
 *  以本段优先（压过核心段的编码纪律） */
function workModeBlock(): string {
  return [
    "You are operating in Work mode. The user is generally a non-engineer (product, operations, data, research). Optimize for finished deliverables - documents, spreadsheets, presentations, research summaries, and web artifacts - rather than code.",
    "Where these instructions conflict with coding-specific defaults above, this mode's instructions take precedence.",
    "Reply in plain language: avoid code jargon unless asked, and explain technical trade-offs simply.",
    "Prefer producing complete artifacts (files, HTML reports) over chat-only answers. If a task touches code files, keep changes minimal and explain them in non-technical terms.",
  ].join("\n");
}

/** ui-design 插件可用性探针（默认现查 activePlugins；compose 每次调用，插件开关
 *  变更随下一次重组即见）。scanInstalledSync 自带签名缓存，代价可忽略 */
function defaultUiDesignActive(): boolean {
  try {
    return activePlugins().some((p) => p.name === "ui-design");
  } catch {
    return false;
  }
}

let uiDesignActiveProbe: () => boolean = defaultUiDesignActive;

/** 测试辅助：桩掉 ui-design 插件启用探针（传 null 恢复真实检查） */
export function setUiDesignActiveProbeForTest(fn: (() => boolean) | null): void {
  uiDesignActiveProbe = fn ?? defaultUiDesignActive;
}

/** design 模式的系统提示词附加段：设计稿（ui-design 插件）+ 高保真 HTML 原型双车道。
 *  插件未启用时（前端门禁之外的兜底）追加引导安装句，并声明先用 HTML 原型交付。
 *  会话选中了设计主题时追加一行主题句（渐进披露：只点名，正文 ~20KB 由模型
 *  按需 use_design_theme 加载，不进常驻提示词；未选中则零变化）。主题句取
 *  硬约束措辞（修复 10 定稿）：首个交付物前必须加载全文、禁止凭主题名即兴
 *  发挥——模型看不到正文时重复调用即可：run 内台账短路只回确认句，压缩
 *  清台账后下一次调用自动重贴全文，无需提示词外的兜底。 */
function designModeBlock(designTheme?: ThemeRef | null): string {
  const lines = [
    "You are operating in Design mode. The user is generally a designer or product person. Optimize for visual deliverables - UI design drafts and high-fidelity interactive prototypes - rather than production code.",
    "Where these instructions conflict with coding-specific defaults above, this mode's instructions take precedence.",
    "Primary lane: UI design drafts as `*.uidesign.json` documents in the workspace, edited either through the ui-design plugin's MCP tools (via the mcp gateway: search → describe → call) or by writing the documented JSON skeleton directly - the design panel auto-opens when a valid document lands and live-refreshes after every write.",
    "Secondary lane (interactive): a single-file HTML/CSS/JS high-fidelity prototype the user can preview in the browser panel.",
  ];
  const hit = designTheme ? findTheme(designTheme) : undefined;
  if (hit) {
    lines.push(
      `Design theme selected for this session: "${hit.name}" (${hit.scope === "builtin" ? "from the built-in theme pack" : "a user theme"}). MANDATORY: before producing the first visual deliverable, call use_design_theme and follow the loaded DESIGN.md exactly - palette hex values, typefaces and type scale, spacing and radius, component style - over your own aesthetic defaults; never improvise the theme's look from its name alone, the full spec exists only through that tool call (if the tool says it was already loaded, the spec is in your context - proceed; after context compaction the next call re-delivers the full text). When the theme conflicts with a platform design-spec skill, the theme governs brand look (color, type, spacing) while the skill governs usability rules such as touch targets and accessibility.`,
    );
  }
  lines.push(
    "Before authoring drafts, load the matching design-spec skill via use_skill (iOS: ios-design-guidelines; Android/Material: material-design-guidelines; general mobile baseline: mobile-design-tokens) and follow its type scale, spacing grid, touch-target sizes, and component rules.",
    "Craft rules: one artboard per screen state laid out side by side, real copy instead of lorem ipsum, consistent alignment, spacing and hierarchy across artboards.",
  );
  if (!uiDesignActiveProbe()) {
    lines.push(
      'The UI design plugin (ui-design) is NOT currently installed and enabled, so its MCP tools and design skills are unavailable: tell the user they can install or enable 「UI 设计」 from the plugin marketplace (设置 → 插件), and until then deliver in the secondary lane (HTML prototypes).',
    );
  }
  return lines.join("\n");
}

/** 当前档位的系统提示词附加段（code = 空串，composeModeSystemPrompt 过滤空段，
 *  默认提示词字节级不变；work/design 各自成段；design 段随会话主题热增减行） */
export function appModePromptBlock(designTheme?: ThemeRef | null): string {
  if (current === "work") return workModeBlock();
  if (current === "design") return designModeBlock(designTheme);
  return "";
}
