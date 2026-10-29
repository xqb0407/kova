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
import type { PiCustomApiKind } from "@/lib/pi/pi-bridge";
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
export type ModelRow = { id: string; draft: AttrDraft | null; touched: boolean };

export const CUSTOM_PROVIDER_ID = "custom";

/** 接口地址必须是 http(s):// 开头（sidecar 同样校验） */
export const isBaseUrlOk = (baseUrl: string): boolean =>
  /^https?:\/\//.test(baseUrl.trim());

/**
 * 接口地址的即时校验文案（null = 合法或尚未开始填）。空串不报——用户还没填
 * 不该先挨骂；填了才按常见错法给具体原因，而不只是"格式不对"。
 */
export const baseUrlError = (baseUrl: string): string | null => {
  const v = baseUrl.trim();
  if (!v) return null;
  if (/\s/.test(v)) return "地址中不能有空格";
  if (!/^https?:\/\//i.test(v)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return "仅支持 http:// 或 https://";
    return "需以 http:// 或 https:// 开头";
  }
  // 协议后没内容 / 直接是路径 = 缺主机名（new URL 对这些是抛异常，文案不如这条准）
  const rest = v.replace(/^https?:\/\//i, "");
  if (!rest || rest.startsWith("/")) return "缺少主机名";
  try {
    const u = new URL(v);
    if (u.hash) return "地址不应包含 # 片段";
  } catch {
    return "地址格式不正确";
  }
  return null;
};

/** 去掉空名行、名称去空格（值保留原样） */
export const cleanHeaders = (headers: ModelAddHeader[]): ModelAddHeader[] =>
  headers
    .filter((h) => h.name.trim())
    .map((h) => ({ name: h.name.trim(), value: h.value }));

/** 追加一个模型 id：空串忽略、已存在忽略（返回同一引用表示没变）。
 *  新行不带草稿——只提交 id，属性继续走目录/缺省推导 */
export const addModelRow = (rows: ModelRow[], raw: string): ModelRow[] => {
  const id = raw.trim();
  if (!id || rows.some((r) => r.id === id)) return rows;
  return [...rows, { id, draft: null, touched: false }];
};

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
};

/** 保存按钮可用性：内置要密钥（编辑态例外）；自定义要名称 + 合法地址 + ≥1 模型 */
export const canSave = (i: SaveGateInput): boolean =>
  !i.saving &&
  i.providerId !== null &&
  (i.isCustom
    ? i.name.trim().length > 0 && isBaseUrlOk(i.baseUrl) && i.modelCount > 0
    : i.apiKey.trim().length > 0 || i.editingBuiltin);

/** 一行模型的提交形态（spec + 档位 + 生图标记分离）。
 *  没在本次弹窗里编辑过（draft null 或 touched false）只发 id：目录种子/缺省继续
 *  生效，不被缺省值冻住；touched 也决定父层是否落思考映射/生图标记 */
export const rowToModelInput = (
  id: string,
  draft: AttrDraft | null,
  touched: boolean,
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
        spec: { id },
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
          baseUrl: i.custom.baseUrl.trim(),
          headers: cleanHeaders(i.custom.headers),
          models: i.custom.models.map((r) => rowToModelInput(r.id, r.draft, r.touched)),
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
  if (!draft.reasoning) return "未标记支持深度思考（先在上方勾选）";
  const labels = THINK_LEVELS.filter((t) => draft[t.field]).map((t) => t.label);
  const off = draft.tOff.trim();
  if (labels.length === 0) return "无思考档位";
  return off ? `${labels.join(" / ")}；关闭时下发 ${off}` : labels.join(" / ");
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
