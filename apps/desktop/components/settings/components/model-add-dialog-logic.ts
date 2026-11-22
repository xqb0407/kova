/**
 * 「添加 / 编辑模型」弹窗的纯逻辑：校验、去重、过滤、保存载荷、种子合并。
 * 从 model-add-dialog.tsx 抽出来只为了能在 bun test 里直接跑（弹窗走 Portal，
 * 静态渲染拿不到内容；交互只能靠测这些函数）。不含 React。
 */

import {
  attrDraftThinkingLevels,
  attrDraftToSpec,
  THINK_LEVELS,
  type AttrDraft,
} from "./model-attr-editor";
import type { PiCustomApiKind, PiCustomModelSpec } from "@/lib/pi/pi-bridge";
import { t } from "@/lib/i18n";
import { fmtContextWindow } from "@/lib/model/model-format";
import type {
  ModelAddBuiltinModel,
  ModelAddHeader,
  ModelAddModelInput,
  ModelAddModelSeed,
  ModelAddSaveInput,
} from "./model-add-dialog";

/** 模型区的一行：id + 属性草稿 + 是否进过属性弹窗。
 *  draft 为 null / touched 为 false = 没在本次弹窗里编辑过：提交时只发 { id }、
 *  不落思考映射与生图标记，让目录种子继续生效（与旧弹窗"没进过属性编辑的模型
 *  不发属性"同口径，避免缺省值把种子冻住）。编辑预填的行有 draft 但 touched=false。 */
export type ModelRow = {
  id: string;
  draft: AttrDraft | null;
  touched: boolean;
  /** `/models` 元数据预填的窗口属性（不改 touched，不冻结思考/生图/单价） */
  seedSpec?: Pick<PiCustomModelSpec, "contextWindow" | "maxTokens">;
};

export const CUSTOM_PROVIDER_ID = "custom";

/**
 * 粘贴进来的地址常见两类问题：带上完整端点（`/v1/models`、`/v1/chat/completions`）
 * 或协议大小写不统一。这里统一收敛回 baseUrl；校验与发送/保存都以收敛后的值为准。
 * 后缀口径与 sidecar 的 normalizeModelBaseUrl 保持一致。
 */
const ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/responses",
  "/messages",
  "/models",
] as const;

/** 地址问题的纯判定：isBaseUrlOk 与 baseUrlError 共用，避免两套规则打架 */
type BaseUrlProblem = "empty" | "space" | "scheme" | "prefix" | "host" | "hash" | "invalid";

const baseUrlProblem = (baseUrl: string): BaseUrlProblem | null => {
  const v = baseUrl.trim();
  if (!v) return "empty";
  if (/\s/.test(v)) return "space";
  if (!/^https?:\/\//i.test(v)) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? "scheme" : "prefix";
  }
  // 协议后没内容 / 直接是路径 = 缺主机名（new URL 对这些是抛异常，文案不如这条准）
  const rest = v.replace(/^https?:\/\//i, "");
  if (!rest || rest.startsWith("/")) return "host";
  try {
    const u = new URL(v);
    if (u.hash) return "hash";
  } catch {
    return "invalid";
  }
  return null;
};

/** 保存/获取/测试的门禁：空串、空格、hash、缺主机、非法 URL 都算不合法 */
export const isBaseUrlOk = (baseUrl: string): boolean => baseUrlProblem(baseUrl) === null;

/**
 * 把完整端点收敛回 baseUrl：去掉已知端点后缀、末尾斜杠与 `#` 片段，保留查询串；
 * 协议/主机交给 URL 统一大小写。含空白或无法解析时原样返回，让校验去报错。
 */
export const normalizeBaseUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  let path = url.pathname.replace(/\/+$/, "");
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      break;
    }
  }
  url.hash = "";
  url.pathname = path || "/";
  const out = url.toString();
  return url.pathname === "/" && out.endsWith("/") ? out.slice(0, -1) : out;
};

/**
 * 接口地址的即时校验文案（null = 合法或尚未开始填）。空串不报——用户还没填
 * 不该先挨骂；填了才按常见错法给具体原因，而不只是"格式不对"。
 */
export const baseUrlError = (baseUrl: string): string | null => {
  const problem = baseUrlProblem(baseUrl);
  if (!problem || problem === "empty") return null;
  switch (problem) {
    case "space":
      return t("settings.models.form.urlErrSpace");
    case "scheme":
      return t("settings.models.form.urlErrScheme");
    case "prefix":
      return t("settings.models.form.urlErrPrefix");
    case "host":
      return t("settings.models.form.urlErrHost");
    case "hash":
      return t("settings.models.form.urlErrHash");
    case "invalid":
      return t("settings.models.form.urlErrInvalid");
  }
};

/** 去掉空名行、名称去空格（值保留原样） */
export const cleanHeaders = (headers: ModelAddHeader[]): ModelAddHeader[] =>
  headers
    .filter((h) => h.name.trim())
    .map((h) => ({ name: h.name.trim(), value: h.value }));

/** 追加一个模型 id：空串忽略、已存在忽略（返回同一引用表示没变）。
 *  新行不带草稿——只提交 id，属性继续走目录/缺省推导 */
export const addModelRow = (
  rows: ModelRow[],
  raw: string,
  seedSpec?: ModelRow["seedSpec"],
): ModelRow[] => {
  const id = raw.trim();
  if (!id || rows.some((r) => r.id === id)) return rows;
  return [
    ...rows,
    { id, draft: null, touched: false, ...(seedSpec ? { seedSpec } : {}) },
  ];
};

/** 去掉成对的外层引号（从 JSON / 文档里复制时常带，含中文引号） */
const stripOuterQuotes = (value: string): string => {
  if (value.length >= 2) {
    const pairs: Array<[string, string]> = [
      ['"', '"'],
      ["'", "'"],
      ["“", "”"],
      ["‘", "’"],
    ];
    for (const [open, close] of pairs) {
      if (value.startsWith(open) && value.endsWith(close)) {
        return value.slice(open.length, -close.length).trim();
      }
    }
  }
  return value;
};

/**
 * 单条模型 ID 的校验：空串 = 忽略；内部空白 = 非法。
 * 单行 <input> 会把粘贴的多行折叠成空格，这正是之前把一串模型存成一条的根因。
 */
export const modelIdError = (raw: string): string | null => {
  const id = raw.trim();
  if (!id) return null;
  if (/\s/.test(id)) return t("settings.models.form.modelIdErrSpace");
  // 括号/引号/分隔符通常来自没拆干净的 JSON 或表格；模型 ID 不应包含它们
  if (/[\[\]{}"'`,;“”‘’]/.test(id) || /[\x00-\x1f]/.test(id)) {
    return t("settings.models.form.modelIdErrChars");
  }
  return null;
};

/**
 * 从粘贴文本里拆模型 ID：支持换行/逗号/分号、JSON 字符串数组，以及
 * `[{ "id": "..." }]` 这种直接贴 `/models` 数据的形态；逐条去引号、去空白。
 */
export const parseModelIds = (raw: string): string[] => {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => {
            if (typeof item === "string") return stripOuterQuotes(item.trim());
            if (typeof item === "number" && Number.isFinite(item)) return String(item);
            if (item && typeof item === "object") {
              const row = item as Record<string, unknown>;
              for (const key of ["id", "model", "model_id"] as const) {
                const value = row[key];
                if (typeof value === "string") return stripOuterQuotes(value.trim());
                if (typeof value === "number" && Number.isFinite(value)) return String(value);
              }
            }
            return "";
          })
          .filter(Boolean);
      }
    } catch {
      // 不是合法 JSON：继续按分隔符拆
    }
  }
  return text
    .split(/[\r\n,;\t，；、]+/)
    .map((part) => stripOuterQuotes(part.trim()))
    .filter(Boolean);
};

/** `/models` 元数据补进属性草稿：只填空字段，用户已填的不覆盖。 */
export const seedDraftWithModelSpec = (
  draft: AttrDraft,
  seed?: ModelRow["seedSpec"],
): AttrDraft => ({
  ...draft,
  ...(seed?.contextWindow !== undefined && !draft.ctx.trim()
    ? { ctx: String(seed.contextWindow) }
    : {}),
  ...(seed?.maxTokens !== undefined && !draft.max.trim()
    ? { max: String(seed.maxTokens) }
    : {}),
});

/** 自定义模型行按 id / 显示名过滤（不区分大小写；空查询原样返回） */
export const filterModelRows = (rows: ModelRow[], query: string): ModelRow[] => {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) =>
      r.id.toLowerCase().includes(q) ||
      (r.draft?.name ?? "").toLowerCase().includes(q),
  );
};

/** 内置目录模型按 id / 名称过滤 */
export const filterBuiltinModels = (
  catalog: ModelAddBuiltinModel[],
  query: string,
): ModelAddBuiltinModel[] => {
  const q = query.trim().toLowerCase();
  if (!q) return catalog;
  return catalog.filter(
    (m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
  );
};

/** 全选/取消全选只作用于可见（过滤后）的集合，其它已选项保留 */
export const toggleAllVisible = (selected: string[], visibleIds: string[]): string[] => {
  const all = visibleIds.every((id) => selected.includes(id));
  return all
    ? selected.filter((id) => !visibleIds.includes(id))
    : [...new Set([...selected, ...visibleIds])];
};

export type SaveGateInput = {
  saving: boolean;
  providerId: string | null;
  isCustom: boolean;
  /** 内置厂商编辑态：密钥可留空 = 保持原 Key */
  editingBuiltin: boolean;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelCount: number;
  /** 自定义服务开启自动发现时不需要手写模型（模型由发现流程补齐） */
  autoDiscover?: boolean;
};

/** 保存按钮可用性：内置要密钥（编辑态例外）；自定义要名称 + 归一后的合法地址 +
 *  ≥1 模型（开启自动发现时豁免——发现结果本身就是模型来源）。
 *  地址按 normalizeBaseUrl 归一后判断，和保存/获取/测试同一口径：粘贴的完整端点、
 *  大小写、`#` 片段在落盘前会被收敛，不能出现"红字没报但保存被静默禁用"。 */
export const canSave = (i: SaveGateInput): boolean =>
  !i.saving &&
  i.providerId !== null &&
  (i.isCustom
    ? i.name.trim().length > 0 &&
      isBaseUrlOk(normalizeBaseUrl(i.baseUrl)) &&
      (i.modelCount > 0 || i.autoDiscover === true)
    : i.apiKey.trim().length > 0 || i.editingBuiltin);

/** 一行模型的提交形态（spec + 档位 + 生图标记分离）。
 *  没在本次弹窗里编辑过（draft null 或 touched false）只发 id：目录种子/缺省继续
 *  生效，不被缺省值冻住；touched 也决定父层是否落思考映射/生图标记 */
export const rowToModelInput = (
  id: string,
  draft: AttrDraft | null,
  touched: boolean,
  seedSpec?: ModelRow["seedSpec"],
): ModelAddModelInput =>
  draft && touched
    ? {
        id,
        spec: attrDraftToSpec(id, draft),
        thinkingLevels: attrDraftThinkingLevels(draft),
        thinkingOff: draft.tOff,
        t2i: draft.t2i,
        touched: true,
      }
    : {
        id,
        spec: { id, ...(seedSpec ?? {}) },
        thinkingLevels: [],
        thinkingOff: "",
        t2i: false,
        touched: false,
      };

export type BuildSaveInput = {
  providerId: string;
  apiKey: string;
  isCustom: boolean;
  custom: {
    name: string;
    api: PiCustomApiKind;
    baseUrl: string;
    headers: ModelAddHeader[];
    models: ModelRow[];
    /** 动态模型发现开关（原样透传给 add_custom_provider） */
    autoDiscover: boolean;
  };
  builtin: {
    /** 该 provider 声明了补充字段才带 env */
    hasEnvFields: boolean;
    env: Record<string, string>;
    selected: string[];
    /** 本次在弹窗里改过属性的内置模型 */
    attrs: Record<string, { draft: AttrDraft }>;
  };
};

/** 组装 onSave 载荷（与组件 submit 一致） */
export const buildSaveInput = (i: BuildSaveInput): ModelAddSaveInput => ({
  providerId: i.providerId,
  apiKey: i.apiKey.trim(),
  ...(i.isCustom
    ? {
        custom: {
          name: i.custom.name.trim(),
          api: i.custom.api,
          baseUrl: normalizeBaseUrl(i.custom.baseUrl),
          headers: cleanHeaders(i.custom.headers),
          models: i.custom.models.map((r) =>
            rowToModelInput(r.id, r.draft, r.touched, r.seedSpec),
          ),
          autoDiscover: i.custom.autoDiscover,
        },
      }
    : {
        ...(i.builtin.hasEnvFields ? { env: i.builtin.env } : {}),
        models: i.builtin.selected,
        ...(Object.keys(i.builtin.attrs).length > 0
          ? {
              modelAttrs: Object.entries(i.builtin.attrs).map(([id, { draft }]) =>
                // builtinAttrs 只在属性弹窗「确定」时写入 → 天然是 touched
                rowToModelInput(id, draft, true),
              ),
            }
          : {}),
      }),
});

/** 容量/输出的行内摘要："128K · 8192"，没填的不出现 */
export const attrSummary = (draft: AttrDraft | null): string => {
  if (!draft) return "";
  const num = (v: string) =>
    v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
  const ctx = num(draft.ctx);
  const max = num(draft.max);
  return [ctx !== undefined ? fmtContextWindow(ctx) : null, max !== undefined ? String(max) : null]
    .filter(Boolean)
    .join(" · ");
};

/** 折叠态思考区的一句话摘要：勾选的档位 + 关闭时下发的值 */
export const thinkingSummary = (draft: AttrDraft): string => {
  if (!draft.reasoning) return t("settings.models.attr.summaryDisabled");
  const labels = THINK_LEVELS.filter((lv) => draft[lv.field]).map((lv) =>
    t(lv.labelKey),
  );
  const off = draft.tOff.trim();
  if (labels.length === 0) return t("settings.models.attr.summaryNone");
  return off
    ? t("settings.models.attr.summaryOff", { levels: labels.join(" / "), value: off })
    : labels.join(" / ");
};

/** 草稿仍是 emptyAttrDraft 的缺省态 → 打开属性弹窗时值得去查目录种子 */
export const isDraftFresh = (draft: AttrDraft): boolean =>
  draft.ctx === "" && draft.max === "" && draft.cIn === "0" && draft.cOut === "0";

/** 种子合并（口径照旧弹窗 openAttrEditor 的异步预填）：只补空/缺省字段，
 *  用户已填的不动；档位按种子整体刷新（与目录生效值同源） */
export const mergeSeed = (draft: AttrDraft, seed: ModelAddModelSeed): AttrDraft => {
  const costNum = (cur: string, val: number): string =>
    cur.trim() === "" || cur.trim() === "0" ? String(val) : cur;
  return {
    ...draft,
    reasoning: draft.reasoning || seed.reasoning,
    ctx: draft.ctx || String(seed.contextWindow),
    max: draft.max || String(seed.maxTokens),
    text: draft.text || seed.input.includes("text"),
    image: draft.image || seed.input.includes("image"),
    tOff:
      draft.tOff ||
      (typeof seed.thinkingLevelMap?.off === "string" ? seed.thinkingLevelMap.off : ""),
    tMin: seed.supportedThinkingLevels.includes("minimal"),
    tLow: seed.supportedThinkingLevels.includes("low"),
    tMed: seed.supportedThinkingLevels.includes("medium"),
    tHigh: seed.supportedThinkingLevels.includes("high"),
    tXhigh: seed.supportedThinkingLevels.includes("xhigh"),
    tMax: seed.supportedThinkingLevels.includes("max"),
    cIn: costNum(draft.cIn, seed.cost.input),
    cOut: costNum(draft.cOut, seed.cost.output),
    cRead: costNum(draft.cRead, seed.cost.cacheRead),
    cWrite: costNum(draft.cWrite, seed.cost.cacheWrite),
  };
};
