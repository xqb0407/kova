"use client";

/**
 * 「添加 / 编辑模型」弹窗（新版样式）。纯 props 驱动，不接 sidecar —— 正式接入时
 * 由 model-settings 喂 providers / initial / onSave / onFetchModels。
 *
 * 两种形态（与旧「添加 AI 服务」弹窗等价，版式换新）：
 * - 内置厂商：提供商 + API Key + 补充凭据字段（extraCredentialFields 声明的，
 *   如 Cloudflare 的 Account/Gateway ID）+ 模型启用勾选区（getProviderModels 给
 *   目录全集；保存时把启用集原样交给调用方走 set_provider_filter）。
 * - 自定义（CUSTOM_PROVIDER_ID）：提供商与名称同排，再展开 API 格式 / 接口地址 /
 *   API Key / 自定义 Headers / 模型。模型区一行一个：行内只留图标 + 名称 + 容量
 *   摘要 + 属性/删除，「属性」开「模型属性」二级弹窗（复用 model-attr-editor 的
 *   AttrEditor）；「自动获取」按接口地址拉列表后开「已获取模型」勾选加入。
 *
 * 编辑模式（initial）：提供商下拉锁死；API Key 不回填（sidecar 只回掩码），
 * 留空保存 = 保持原 Key（内置与自定义端点同语义）。
 *
 * 提供商下拉走 Popover/Portal：表单区会滚动，absolute 面板会被裁剪。
 * 表单状态放在 ModelAddForm 里：DialogContent 关闭即卸载，下次打开按 initial
 * 重新初始化，不用靠 effect 盯 open 去重置。
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  EyeOffIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProviderIcon } from "@/components/custom-ui/provider-icon";
import {
  AttrEditor,
  emptyAttrDraft,
  specToAttrDraft,
  type AttrDraft,
} from "@/components/settings/components/model-attr-editor";
import {
  addModelRow,
  attrSummary,
  baseUrlError,
  buildSaveInput,
  canSave as canSaveGate,
  cleanHeaders,
  filterBuiltinModels,
  filterModelRows,
  isBaseUrlOk,
  isDraftFresh,
  mergeSeed,
  seedDraftWithModelSpec,
  thinkingSummary,
  toggleAllVisible,
  type ModelRow,
} from "@/components/settings/components/model-add-dialog-logic";
import type {
  PiCustomApiKind,
  PiCustomModelSpec,
  PiFetchedModelDetail,
} from "@/lib/pi/pi-bridge";
import { fmtContextWindow } from "@/lib/model/model-format";
import { cn } from "@/lib/utils";

/** 「自定义」选项的 providerId：调用方据此区分内置厂商与自定义端点 */
export { CUSTOM_PROVIDER_ID } from "@/components/settings/components/model-add-dialog-logic";
import { CUSTOM_PROVIDER_ID } from "@/components/settings/components/model-add-dialog-logic";

export type ModelAddProviderOption = { id: string; name: string };

export type ModelAddHeader = { name: string; value: string };

/** 内置服务的目录模型（启用勾选区条目） */
export type ModelAddBuiltinModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  /** 目录生效值：给了它，行内才有「属性」可改（上下文/输出/模态/单价/思考…） */
  spec?: PiCustomModelSpec;
  /** 思考档位现值（目录 supportedThinkingLevels）与关闭下发值、生图标记 */
  thinkingLevels?: string[];
  thinkingOff?: string;
  t2i?: boolean;
};

/** 内置服务的目录全集 + 当前启用集（null 语义由父层折算成全选） */
export type ModelAddBuiltinCatalog = {
  models: ModelAddBuiltinModel[];
  selected: string[];
};

/** 目录种子（lookup_thinking_seed 应答的结构子集）：新增模型属性预填用 */
export type ModelAddModelSeed = {
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  thinkingLevelMap?: Record<string, string | null> | null;
  supportedThinkingLevels: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

/** 一个待保存的自定义模型：属性提交口径照旧流程（spec 只带用户改过的/缺省的） */
export type ModelAddModelInput = {
  id: string;
  spec: PiCustomModelSpec;
  /** 勾选的思考档位（thinkingLevelMap 键） */
  thinkingLevels: string[];
  /** 关闭思考时下发的参数值（空 = 不发） */
  thinkingOff: string;
  /** 可生成图片标记（imagegen 配置覆盖层） */
  t2i: boolean;
  /** 本次在弹窗里进过属性编辑（草稿非空且确定过）。没进过 = 不落思考映射/
   *  生图标记，避免拿缺省值把目录推导覆盖成显式关闭 */
  touched?: boolean;
};

export type ModelAddCustomInput = {
  name: string;
  api: PiCustomApiKind;
  baseUrl: string;
  /** 已去掉空名行 */
  headers: ModelAddHeader[];
  models: ModelAddModelInput[];
};

export type ModelAddSaveInput = {
  providerId: string;
  apiKey: string;
  /** 内置服务的非密钥补充字段（仅声明了字段的 provider 会带） */
  env?: Record<string, string>;
  /** 内置服务的启用模型集（全选也照发，与旧行为一致） */
  models?: string[];
  /** 内置厂商：本次在弹窗里改过属性的模型，保存时逐个与目录求差落 update_model */
  modelAttrs?: ModelAddModelInput[];
  /** providerId === CUSTOM_PROVIDER_ID 时才有 */
  custom?: ModelAddCustomInput;
};

export type ModelAddFetchInput = Pick<
  ModelAddCustomInput,
  "api" | "baseUrl" | "headers"
> & {
  apiKey: string;
  /** 编辑态密钥留空时带上：sidecar 按 providerId 取已存凭据兜底 */
  providerId?: string;
};

/** 「测试连接」入参：拉取参数 + 用来发最小请求的模型 id */
export type ModelAddTestInput = ModelAddFetchInput & { model: string };

/** 编辑模式预填：内置厂商给凭据/启用集，自定义端点给完整表单 */
export type ModelAddInitial = {
  providerId: string;
  /** 编辑态掩码提示（sidecar 只回掩码，明文不进渲染进程） */
  apiKeyMasked?: string;
  /** 内置服务：补充字段初值（明文存 kv，直接回填可改） */
  env?: Record<string, string>;
  /** 内置服务：当前启用集（目录全集由 getProviderModels 动态给） */
  builtinSelected?: string[];
  /** 自定义端点：完整预填 */
  custom?: {
    name: string;
    api: PiCustomApiKind;
    baseUrl: string;
    headers: ModelAddHeader[];
    models: ModelAddModelInput[];
  };
};

export type ModelAddDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 内置厂商；「自定义」由组件固定追加在末尾，不要在这里传 */
  providers: ModelAddProviderOption[];
  onSave: (input: ModelAddSaveInput) => void | Promise<void>;
  /** 编辑模式预填；null/缺席 = 新增 */
  initial?: ModelAddInitial | null;
  /** 内置服务的补充凭据字段（如 Cloudflare 的 Account/Gateway ID），按 providerId 索引 */
  extraCredentialFields?: Record<
    string,
    { name: string; label: string; hint?: string }[]
  >;
  /** 内置服务的目录全集与当前启用集（启用勾选区候选），按 providerId 现取。
   *  异步：父层要查 get_provider_filter 才知道已启用的子集 */
  getProviderModels?: (providerId: string) => Promise<ModelAddBuiltinCatalog>;
  /** 「自动获取」：按接口地址拉模型 id 列表。不传则按钮不显示 */
  onFetchModels?: (input: ModelAddFetchInput) => Promise<PiFetchedModelDetail[]>;
  /** 「测试连接」：用表单当前值 + 第一个模型发一条最小请求，成功 resolve、失败 reject。
   *  不传则按钮不显示 */
  onTestConnection?: (input: ModelAddTestInput) => Promise<void>;
  /** 目录种子查询（旧弹窗的 lookup_thinking_seed）：新增/目录外模型的属性弹窗
   *  预填用，只补空字段不覆盖已填值。不传则属性弹窗全空 */
  onLookupSeed?: (modelId: string) => Promise<ModelAddModelSeed | null>;
  /** 保存失败的错误：显示在页脚上方，弹窗保持打开可改 */
  error?: string | null;
  /** 保存进行中：保存按钮禁用并显示"保存中…" */
  saving?: boolean;
};

const CUSTOM_OPTION: ModelAddProviderOption = {
  id: CUSTOM_PROVIDER_ID,
  name: "自定义",
};

const API_FORMATS: { value: PiCustomApiKind; label: string; endpoint: string }[] = [
  { value: "openai-chat", label: "OpenAI Chat Completions", endpoint: "/chat/completions" },
  { value: "openai-responses", label: "OpenAI Responses", endpoint: "/responses" },
  { value: "anthropic-messages", label: "Anthropic Messages", endpoint: "/v1/messages" },
];

/**
 * 与 ui/Input 同一套填充式外观，给套不了 Input 的控件用（combobox 触发器是 button）。
 * 聚焦态的两份字面量是因为 Tailwind 静态扫描，拼不出来。
 */
const CONTROL =
  "bg-muted/60 hover:bg-muted h-9 w-full rounded-lg border border-transparent px-3 text-sm transition-colors outline-none";
const CONTROL_FOCUS_VISIBLE =
  "focus-visible:bg-background focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50";

/** 必填星标 */
const Req: FC = () => (
  <span className="text-destructive ms-0.5" aria-hidden>
    *
  </span>
);

const Field: FC<{
  label: ReactNode;
  htmlFor: string;
  required?: boolean;
  children: ReactNode;
}> = ({ label, htmlFor, required, children }) => (
  <div className="flex flex-col gap-2">
    <label htmlFor={htmlFor} className="text-sm font-medium">
      {label}
      {required && <Req />}
    </label>
    {children}
  </div>
);

/** 无单一控件可关联的区块（Headers、模型）：标题 + 内容 */
const Section: FC<{ label: ReactNode; required?: boolean; children: ReactNode }> = ({
  label,
  required,
  children,
}) => (
  <div className="flex flex-col gap-2.5">
    <div className="text-sm font-medium">
      {label}
      {required && <Req />}
    </div>
    {children}
  </div>
);

/** 「+ 添加」：沿用系统 outline 按钮 */
const AddButton: FC<{ onClick: () => void; children: ReactNode }> = ({
  onClick,
  children,
}) => (
  <Button variant="outline" className="h-9" onClick={onClick}>
    <PlusIcon className="size-4" />
    {children}
  </Button>
);

export function ModelAddDialog({
  open,
  onOpenChange,
  providers,
  onSave,
  initial,
  extraCredentialFields,
  getProviderModels,
  onFetchModels,
  onTestConnection,
  onLookupSeed,
  error,
  saving,
}: ModelAddDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 rounded-3xl p-6 sm:max-w-[600px]">
        <ModelAddForm
          key={initial?.providerId ?? "new"}
          providers={providers}
          initial={initial ?? null}
          extraCredentialFields={extraCredentialFields}
          getProviderModels={getProviderModels}
          saving={saving}
          error={error}
          onCancel={() => onOpenChange(false)}
          onSave={onSave}
          onFetchModels={onFetchModels}
          onTestConnection={onTestConnection}
          onLookupSeed={onLookupSeed}
        />
      </DialogContent>
    </Dialog>
  );
}

const ModelAddForm: FC<{
  providers: ModelAddProviderOption[];
  initial: ModelAddInitial | null;
  extraCredentialFields?: ModelAddDialogProps["extraCredentialFields"];
  getProviderModels?: ModelAddDialogProps["getProviderModels"];
  saving?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSave: ModelAddDialogProps["onSave"];
  onFetchModels: ModelAddDialogProps["onFetchModels"];
  onTestConnection: ModelAddDialogProps["onTestConnection"];
  onLookupSeed: ModelAddDialogProps["onLookupSeed"];
}> = ({
  providers,
  initial,
  extraCredentialFields,
  getProviderModels,
  saving,
  error,
  onCancel,
  onSave,
  onFetchModels,
  onTestConnection,
  onLookupSeed,
}) => {
  const providerFieldId = useId();
  const nameFieldId = useId();
  const apiFieldId = useId();
  const urlFieldId = useId();
  const keyFieldId = useId();

  const editing = initial !== null;
  // 编辑模式锁死提供商（旧弹窗同语义：编辑目标不可切换）
  const [providerId, setProviderId] = useState<string | null>(
    initial?.providerId ?? null,
  );
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  // 自定义端点
  const [name, setName] = useState(initial?.custom?.name ?? "");
  const [api, setApi] = useState<PiCustomApiKind>(
    initial?.custom?.api ?? "openai-chat",
  );
  const [baseUrl, setBaseUrl] = useState(initial?.custom?.baseUrl ?? "");
  const [headers, setHeaders] = useState<ModelAddHeader[]>(
    initial?.custom?.headers ?? [],
  );
  const [models, setModels] = useState<ModelRow[]>(() =>
    (initial?.custom?.models ?? []).map((m) => ({
      id: m.id,
      draft: specToAttrDraft(m.id, m.spec, {
        levels: m.thinkingLevels,
        off: m.thinkingOff,
        t2i: m.t2i,
      }),
      // 编辑预填只是基线：用户没重新进属性弹窗就算没改过
      touched: false,
    })),
  );
  const [addingModel, setAddingModel] = useState(false);
  const [modelDraft, setModelDraft] = useState("");
  // 自定义模型多的时候的行内搜索
  const [modelSearch, setModelSearch] = useState("");
  // 批量删除的勾选：跨搜索累积；删除行后清理失效的 id
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // 内置厂商：补充字段 + 启用集（目录全集经 getProviderModels 现取）
  const [env, setEnv] = useState<Record<string, string>>(initial?.env ?? {});
  const [builtinSelected, setBuiltinSelected] = useState<string[]>(
    initial?.builtinSelected ?? [],
  );
  const [builtinCatalog, setBuiltinCatalog] = useState<ModelAddBuiltinModel[]>([]);
  const [builtinSearch, setBuiltinSearch] = useState("");
  // 内置模型在弹窗里改过的属性（草稿）：行内「属性」弹窗确定时写入，随保存提交
  const [builtinAttrs, setBuiltinAttrs] = useState<
    Record<string, { draft: AttrDraft }>
  >({});
  // 已取过目录的 providerId：同一服务不反复拉取（父层 models 刷新会换回调身份，
  // 不能据此重置用户改到一半的勾选）
  const builtinLoadedFor = useRef<string | null>(null);

  // 「模型属性」二级弹窗：null = 关闭；draft 是行草稿的副本，确定才写回。
  // attrSeed：打开的是缺省态新模型时异步拉的目录种子（undefined = 拉取中/不适用）
  const [attrEdit, setAttrEdit] = useState<{ id: string; draft: AttrDraft } | null>(
    null,
  );
  const [attrSeed, setAttrSeed] = useState<ModelAddModelSeed | null | undefined>(
    undefined,
  );
  // 种子归属的模型 id：异步回来时核对"属性弹窗还开着同一个模型"，防止 A 的种子
  // 串到后打开的 B 上（旧弹窗用 attrEditIdRef 做过同样的事）
  const attrSeedFor = useRef<string | null>(null);

  // 自动获取：拉到的列表非 null 即二级弹窗打开
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "error">("idle");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetched, setFetched] = useState<PiFetchedModelDetail[] | null>(null);

  // 测试连接：用表单当前值 + 第一个模型发最小请求
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  const isCustom = providerId === CUSTOM_PROVIDER_ID;
  const editingBuiltin = editing && !isCustom;

  const selected = useMemo(
    () =>
      providerId === null
        ? null
        : isCustom
          ? CUSTOM_OPTION
          : (providers.find((p) => p.id === providerId) ?? null),
    [providerId, isCustom, providers],
  );

  const baseUrlOk = isBaseUrlOk(baseUrl);
  // 即时格式校验：空串不报（还没填不算错），填了给具体原因
  const urlError = isCustom ? baseUrlError(baseUrl) : null;

  // 模型多的时候按 id/名称过滤行内列表
  const filteredModels = useMemo(
    () => filterModelRows(models, modelSearch),
    [models, modelSearch],
  );
  const pickedVisible = filteredModels.filter((r) => picked.has(r.id)).length;
  const allVisiblePicked =
    filteredModels.length > 0 && pickedVisible === filteredModels.length;
  const togglePicked = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePickedAll = () =>
    setPicked((prev) =>
      new Set(toggleAllVisible([...prev], filteredModels.map((r) => r.id))),
    );
  const removePicked = () => {
    setModels((prev) => prev.filter((r) => !picked.has(r.id)));
    setPicked(new Set());
  };
  const removeRow = (id: string) => {
    setModels((prev) => prev.filter((r) => r.id !== id));
    setPicked((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // 目录全集与当前启用集异步现取；编辑预填的启用集优先于父层给的当前值
  useEffect(() => {
    if (!providerId || isCustom) {
      setBuiltinCatalog([]);
      builtinLoadedFor.current = null;
      return;
    }
    if (builtinLoadedFor.current === providerId) return;
    let alive = true;
    builtinLoadedFor.current = providerId;
    void (getProviderModels?.(providerId) ?? Promise.resolve({ models: [], selected: [] }))
      .then((r) => {
        if (!alive) return;
        setBuiltinCatalog(r.models);
        setBuiltinSelected(
          initial?.providerId === providerId && initial.builtinSelected
            ? initial.builtinSelected
            : r.selected,
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [providerId, isCustom, getProviderModels, initial]);
  const builtinFiltered = useMemo(
    () => filterBuiltinModels(builtinCatalog, builtinSearch),
    [builtinCatalog, builtinSearch],
  );
  const builtinAllVisibleSelected =
    builtinFiltered.length > 0 &&
    builtinFiltered.every((m) => builtinSelected.includes(m.id));
  const toggleBuiltin = (id: string) =>
    setBuiltinSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  const toggleBuiltinAll = () =>
    setBuiltinSelected((prev) =>
      toggleAllVisible(prev, builtinFiltered.map((m) => m.id)),
    );

  const envFields = providerId && !isCustom
    ? (extraCredentialFields?.[providerId] ?? [])
    : [];

  // 内置厂商要密钥（编辑态可留空 = 保持原 Key）；自定义端点要名称 + 合法地址 +
  // 至少一个模型（本地端点常常没密钥）
  const canSave = canSaveGate({
    saving: !!saving,
    providerId,
    isCustom,
    editingBuiltin,
    name,
    baseUrl,
    apiKey,
    modelCount: models.length,
  });

  const submit = () => {
    if (!canSave || providerId === null) return;
    void onSave(
      buildSaveInput({
        providerId,
        apiKey,
        isCustom,
        custom: { name, api, baseUrl, headers, models },
        builtin: {
          hasEnvFields: envFields.length > 0,
          env,
          selected: builtinSelected,
          attrs: builtinAttrs,
        },
      }),
    );
  };

  const addModelId = (raw: string, meta?: PiFetchedModelDetail) => {
    const seedSpec =
      meta && (meta.contextLength !== undefined || meta.maxTokens !== undefined)
        ? {
            ...(meta.contextLength !== undefined
              ? { contextWindow: meta.contextLength }
              : {}),
            ...(meta.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
          }
        : undefined;
    setModels((prev) => addModelRow(prev, raw, seedSpec));
  };

  /** 打开属性弹窗；新模型（还没有草稿 / 草稿仍是缺省态）异步拉目录种子，
   *  回来后由弹窗内部合并。种子按模型 id 守卫，关掉或换模型后不再落地 */
  const openAttr = (row: ModelRow) => {
    setAttrSeed(undefined);
    setAttrEdit({
      id: row.id,
      draft: seedDraftWithModelSpec(
        row.draft ? { ...row.draft } : emptyAttrDraft(row.id),
        row.seedSpec,
      ),
    });
    if (!onLookupSeed) return;
    const fresh = row.draft === null || isDraftFresh(row.draft);
    if (!fresh) return;
    attrSeedFor.current = row.id;
    void onLookupSeed(row.id)
      .then((seed) => {
        if (attrSeedFor.current === row.id) setAttrSeed(seed);
      })
      .catch(() => {
        if (attrSeedFor.current === row.id) setAttrSeed(null);
      });
  };

  /** 内置模型的属性弹窗：优先用本次弹窗里改过的草稿（重开不丢改动），
   *  否则从目录生效值预填（无种子查询——值已在目录里） */
  const openBuiltinAttr = (m: ModelAddBuiltinModel) => {
    if (!m.spec) return;
    attrSeedFor.current = null;
    setAttrSeed(undefined);
    setAttrEdit({
      id: m.id,
      draft:
        builtinAttrs[m.id]?.draft ??
        specToAttrDraft(m.id, m.spec, {
          levels: m.thinkingLevels ?? [],
          off: m.thinkingOff ?? "",
          t2i: m.t2i ?? false,
        }),
    });
  };

  // 测试连接 / 自动获取的结果只对当次参数有效：地址、格式或密钥一改就作废
  useEffect(() => {
    setTestState("idle");
    setTestError(null);
    setFetchState("idle");
    setFetchError(null);
  }, [baseUrl, api, apiKey]);

  const fetchModels = async () => {
    if (!onFetchModels || fetchState === "loading") return;
    // 地址不合法不当场禁用按钮（"点了没反应"会被当成功能坏了）：
    // 允许点击，点了把原因写在按钮下方
    if (!baseUrlOk) {
      setFetchState("error");
      setFetchError("请先填写以 http:// 或 https:// 开头的接口地址");
      return;
    }
    setFetchState("loading");
    setFetchError(null);
    try {
      const list = await onFetchModels({
        api,
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        apiKey: apiKey.trim(),
        headers: cleanHeaders(headers),
        // 编辑态密钥留空：sidecar 按 providerId 取已存凭据兜底
        ...(editing && !apiKey.trim() && initial.providerId
          ? { providerId: initial.providerId }
          : {}),
      });
      setFetched(list);
      setFetchState("idle");
    } catch (err) {
      setFetchState("error");
      setFetchError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 测试连接：缺地址/缺模型不禁用按钮，点了把原因写在旁边（同自动获取的道理） */
  const testConnection = async () => {
    if (!onTestConnection || testState === "testing") return;
    if (!baseUrlOk) {
      setTestState("error");
      setTestError("请先填写以 http:// 或 https:// 开头的接口地址");
      return;
    }
    const model = models[0]?.id;
    if (!model) {
      setTestState("error");
      setTestError("请先添加至少一个模型（测试会用第一个模型发请求）");
      return;
    }
    setTestState("testing");
    setTestError(null);
    try {
      await onTestConnection({
        api,
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        apiKey: apiKey.trim(),
        headers: cleanHeaders(headers),
        model,
        ...(editing && !apiKey.trim() && initial.providerId
          ? { providerId: initial.providerId }
          : {}),
      });
      setTestState("ok");
    } catch (err) {
      setTestState("error");
      setTestError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <DialogTitle className="shrink-0 text-xl font-semibold">
        {editing ? "编辑模型" : "添加模型"}
      </DialogTitle>

      <div className="mt-6 min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5">
          {/* 自定义时名称与提供商同排 */}
          <div className={cn("grid gap-4", isCustom && "grid-cols-2")}>
            <Field label="提供商" htmlFor={providerFieldId} required>
              {editing ? (
                // 编辑模式锁死提供商（旧弹窗同语义）
                <div
                  className={cn(CONTROL, "flex items-center gap-2 pe-3 text-start opacity-60")}
                  aria-disabled
                >
                  {selected && selected.id !== CUSTOM_PROVIDER_ID && (
                    <ProviderIcon
                      provider={selected.id}
                      providerName={selected.name}
                      className="size-4 shrink-0"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {selected?.name ?? providerId}
                  </span>
                  <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
                </div>
              ) : (
                <ProviderCombobox
                  id={providerFieldId}
                  providers={providers}
                  selected={selected}
                  onSelect={(opt) => setProviderId(opt.id)}
                />
              )}
            </Field>
            {isCustom && (
              <Field label="提供商名称" htmlFor={nameFieldId} required>
                <Input
                  id={nameFieldId}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="请输入提供商名称"
                  autoComplete="off"
                />
              </Field>
            )}
          </div>

          {isCustom && (
            <>
              {/* 格式窄、地址长，同排省一行的纵向空间 */}
              <div className="grid grid-cols-[14rem_1fr] gap-4">
                <Field label="API 格式" htmlFor={apiFieldId}>
                  <Select value={api} onValueChange={(v) => v && setApi(v)}>
                    <SelectTrigger id={apiFieldId} className="w-full">
                      <SelectValue>
                        {(v: PiCustomApiKind | null) =>
                          API_FORMATS.find((f) => f.value === v)?.label ??
                          "选择 API 格式"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start">
                      {API_FORMATS.map((f) => (
                        <SelectItem key={f.value} value={f.value}>
                          {f.label}
                          <span className="text-muted-foreground ms-1.5 text-xs">
                            {f.endpoint}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="接口地址" htmlFor={urlFieldId} required>
                  <Input
                    id={urlFieldId}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={
                      api === "anthropic-messages"
                        ? "https://api.anthropic.com"
                        : "https://api.example.com/v1"
                    }
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={urlError !== null || undefined}
                    className="font-mono text-xs md:text-xs"
                  />
                  {/* 填了才校验：空着不报，避免一打开就满屏红 */}
                  {urlError && (
                    <p className="text-destructive -mt-0.5 text-xs">{urlError}</p>
                  )}
                </Field>
              </div>
            </>
          )}

          {/* 内置厂商新增必填；编辑态留空 = 保持原 Key；自定义端点可空（本地端点） */}
          <Field
            label="API Key"
            htmlFor={keyFieldId}
            required={!isCustom && !editingBuiltin}
          >
            <div className="relative">
              <Input
                id={keyFieldId}
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  initial?.apiKeyMasked
                    ? `已保存 ${initial.apiKeyMasked}，留空保持不变`
                    : "请输入 API Key"
                }
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="pe-10"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                className="text-muted-foreground hover:text-foreground absolute end-2 top-1/2 -translate-y-1/2 rounded-md p-1 transition-colors"
              >
                {showKey ? (
                  <EyeIcon className="size-4" />
                ) : (
                  <EyeOffIcon className="size-4" />
                )}
              </button>
            </div>
          </Field>

          {/* 内置服务的补充凭据字段（如 Cloudflare 网关）：缺了它们该服务的模型
              解析不出凭据，整体从模型选择里消失 */}
          {envFields.map((f) => (
            <Field key={f.name} label={f.label} htmlFor={`env-${f.name}`}>
              <Input
                id={`env-${f.name}`}
                value={env[f.name] ?? ""}
                onChange={(e) =>
                  setEnv((prev) => ({ ...prev, [f.name]: e.target.value }))
                }
                placeholder={editing ? `${f.name}，留空清除` : f.name}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono text-xs md:text-xs"
              />
              {f.hint && (
                <p className="text-muted-foreground text-xs">{f.hint}</p>
              )}
            </Field>
          ))}

          {isCustom ? (
            <>
              {/* 自定义请求头：键值行可增删；空名行保存时忽略 */}
              <Section label="自定义 Headers">
                {headers.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {headers.map((h, i) => (
                      <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                        <Input
                          value={h.name}
                          onChange={(e) =>
                            setHeaders((prev) =>
                              prev.map((row, j) =>
                                j === i ? { ...row, name: e.target.value } : row,
                              ),
                            )
                          }
                          placeholder="Header 名称"
                          autoComplete="off"
                          spellCheck={false}
                          className="font-mono text-xs md:text-xs"
                        />
                        <Input
                          value={h.value}
                          onChange={(e) =>
                            setHeaders((prev) =>
                              prev.map((row, j) =>
                                j === i ? { ...row, value: e.target.value } : row,
                              ),
                            )
                          }
                          placeholder="值"
                          autoComplete="off"
                          spellCheck={false}
                          className="font-mono text-xs md:text-xs"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="删除这行请求头"
                          className="text-muted-foreground hover:text-foreground size-9"
                          onClick={() =>
                            setHeaders((prev) => prev.filter((_, j) => j !== i))
                          }
                        >
                          <XIcon className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <AddButton
                    onClick={() =>
                      setHeaders((prev) => [...prev, { name: "", value: "" }])
                    }
                  >
                    添加
                  </AddButton>
                </div>
              </Section>

              {/* 模型：一行一个，行内 属性/删除；手填或自动获取后勾选加入。
                  多的时候列表限高滚动 + 搜索，不再把整个表单顶长 */}
              <Section
                label={`模型${models.length > 0 ? `（${models.length}）` : ""}`}
                required
              >
                {models.length > 0 && (
                  <>
                    {(models.length > 8 || modelSearch.length > 0) && (
                      <div className="relative">
                        <SearchIcon className="text-muted-foreground absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
                        <Input
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          placeholder="搜索模型…"
                          className="h-9 ps-7"
                        />
                      </div>
                    )}
                    <div className="border-input max-h-56 overflow-y-auto rounded-xl border p-1">
                      {filteredModels.map((row) => (
                        <div
                          key={row.id}
                          className="hover:bg-muted/60 group flex h-10 items-center gap-2.5 rounded-lg px-2"
                        >
                        {/* 自定义端点无品牌，按 modelId 认厂家；内置按服务 */}
                        <Checkbox
                          checked={picked.has(row.id)}
                          onCheckedChange={() => togglePicked(row.id)}
                          aria-label={`选择模型 ${row.id}`}
                          className="shrink-0"
                        />
                        <ProviderIcon
                          provider={isCustom ? row.id : providerId}
                          modelId={row.id}
                          providerName={selected?.name}
                          className="size-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm" title={row.id}>
                          {row.draft?.name.trim() || row.id}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                          {attrSummary(row.draft)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${row.id} 属性`}
                          className="text-muted-foreground group-hover:text-foreground"
                          onClick={() => openAttr(row)}
                        >
                          <Settings2Icon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`移除模型 ${row.id}`}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => removeRow(row.id)}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                      ))}
                      {filteredModels.length === 0 && (
                        <div className="text-muted-foreground py-6 text-center text-sm">
                          没有匹配的模型
                        </div>
                      )}
                    </div>
                    {/* 批量操作：全选只作用于当前筛选的可见集；删除所选跨搜索累积 */}
                    {models.length > 8 && (
                      <div className="flex items-center gap-3">
                        <label className="text-muted-foreground hover:bg-muted/60 flex h-8 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm">
                          <Checkbox
                            checked={allVisiblePicked}
                            indeterminate={
                              !allVisiblePicked && pickedVisible > 0
                            }
                            onCheckedChange={togglePickedAll}
                          />
                          全选（当前筛选 {pickedVisible}/{filteredModels.length}）
                        </label>
                        {picked.size > 0 && (
                          <Button
                            variant="ghost"
                            className="text-destructive hover:text-destructive h-8 px-2"
                            onClick={removePicked}
                          >
                            <Trash2Icon className="size-3.5" />
                            删除所选（{picked.size}）
                          </Button>
                        )}
                      </div>
                    )}
                  </>
                )}
                <div className="flex items-center gap-3">
                  {addingModel ? (
                    <Input
                      autoFocus
                      value={modelDraft}
                      onChange={(e) => setModelDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addModelId(modelDraft);
                          setModelDraft("");
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          setModelDraft("");
                          setAddingModel(false);
                        }
                      }}
                      onBlur={() => {
                        addModelId(modelDraft);
                        setModelDraft("");
                        setAddingModel(false);
                      }}
                      placeholder="输入模型 ID，回车添加"
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="w-64 font-mono text-xs md:text-xs"
                    />
                  ) : (
                    <AddButton onClick={() => setAddingModel(true)}>添加</AddButton>
                  )}
                  {onFetchModels && (
                    <Button
                      variant="ghost"
                      className="h-9 px-3"
                      disabled={fetchState === "loading"}
                      onClick={() => void fetchModels()}
                    >
                      {fetchState === "loading" ? (
                        <>
                          <RefreshCwIcon className="size-3.5 animate-spin" />
                          获取中…
                        </>
                      ) : (
                        "自动获取"
                      )}
                    </Button>
                  )}
                  {onTestConnection && (
                    <Button
                      variant="ghost"
                      className={cn(
                        "h-9 px-3",
                        testState === "ok" && "text-lime-600 hover:text-lime-600",
                      )}
                      disabled={testState === "testing"}
                      onClick={() => void testConnection()}
                    >
                      {testState === "testing" ? (
                        <>
                          <RefreshCwIcon className="size-3.5 animate-spin" />
                          测试中…
                        </>
                      ) : testState === "ok" ? (
                        <>
                          <CheckIcon className="size-3.5" />
                          连接成功
                        </>
                      ) : (
                        <>
                          <PlugIcon className="size-3.5" />
                          测试连接
                        </>
                      )}
                    </Button>
                  )}
                </div>
                {fetchState === "error" && fetchError && (
                  <p className="text-destructive text-xs break-all">{fetchError}</p>
                )}
                {testState === "error" && testError && (
                  <p className="text-destructive text-xs break-all">{testError}</p>
                )}
              </Section>
            </>
          ) : (
            /* 内置厂商：目录模型的启用勾选区（保存走 set_provider_filter） */
            builtinCatalog.length > 0 && (
              <Section
                label={`模型（已选 ${builtinSelected.length}/${builtinCatalog.length}）`}
              >
                <div className="relative">
                  <SearchIcon className="text-muted-foreground absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
                  <Input
                    value={builtinSearch}
                    onChange={(e) => setBuiltinSearch(e.target.value)}
                    placeholder="搜索模型…"
                    className="h-9 ps-7"
                  />
                </div>
                <div className="border-input max-h-56 overflow-y-auto rounded-xl border p-1">
                  {builtinFiltered.map((m) => {
                    const touched = builtinAttrs[m.id];
                    return (
                      <div
                        key={m.id}
                        title={m.id}
                        className="hover:bg-muted/60 flex h-9 items-center gap-3 rounded-lg px-2 text-sm"
                      >
                        <Checkbox
                          checked={builtinSelected.includes(m.id)}
                          onCheckedChange={() => toggleBuiltin(m.id)}
                        />
                        <span
                          className="min-w-0 flex-1 cursor-pointer truncate"
                          onClick={() => toggleBuiltin(m.id)}
                        >
                          {m.name || m.id}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                          {touched
                            ? attrSummary(touched.draft)
                            : m.contextWindow != null
                              ? fmtContextWindow(m.contextWindow)
                              : ""}
                        </span>
                        {/* 目录带生效值的模型可改属性（与旧弹窗的铅笔一致）：
                            改过的高亮，随「保存」与目录求差后落 update_model */}
                        {m.spec && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`${m.id} 属性`}
                            className={cn(
                              "shrink-0",
                              touched
                                ? "text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                            onClick={() => openBuiltinAttr(m)}
                          >
                            <Settings2Icon />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  {builtinFiltered.length === 0 && (
                    <div className="text-muted-foreground py-6 text-center text-sm">
                      没有匹配的模型
                    </div>
                  )}
                </div>
                <label className="text-muted-foreground flex h-8 w-fit cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-muted/60">
                  <Checkbox
                    checked={builtinAllVisibleSelected}
                    indeterminate={
                      !builtinAllVisibleSelected &&
                      builtinFiltered.some((m) => builtinSelected.includes(m.id))
                    }
                    onCheckedChange={toggleBuiltinAll}
                  />
                  全选（当前筛选）
                </label>
                <p className="text-muted-foreground text-xs">
                  勾选该服务要启用的模型；全部勾选表示不筛选。
                </p>
              </Section>
            )
          )}
        </div>
      </div>

      {error && (
        <p className="text-destructive mt-3 shrink-0 text-xs break-all">{error}</p>
      )}

      <DialogFooter className="mt-5 shrink-0 gap-3">
        <Button variant="outline" className="min-w-18" onClick={onCancel}>
          取消
        </Button>
        <Button
          disabled={!canSave}
          onClick={submit}
          className="disabled:bg-muted-foreground/50 disabled:text-primary-foreground min-w-18 disabled:opacity-100"
        >
          {saving ? "保存中…" : "保存"}
        </Button>
      </DialogFooter>

      {attrEdit !== null && (
        <ModelAttrDialog
          key={attrEdit.id}
          edit={attrEdit}
          seed={attrSeed}
          onCommit={(draft) => {
            if (isCustom) {
              setModels((prev) =>
                prev.map((r) =>
                  r.id === attrEdit.id ? { id: r.id, draft, touched: true } : r,
                ),
              );
            } else {
              setBuiltinAttrs((prev) => ({ ...prev, [attrEdit.id]: { draft } }));
            }
            attrSeedFor.current = null;
            setAttrEdit(null);
          }}
          onClose={() => {
            attrSeedFor.current = null;
            setAttrEdit(null);
          }}
        />
      )}

      {fetched !== null && (
        <FetchedModelsDialog
          models={fetched}
          onClose={() => setFetched(null)}
          onAdd={(picked) => {
            picked.forEach((model) => addModelId(model.id, model));
            setFetched(null);
          }}
        />
      )}
    </>
  );
};

/**
 * 「模型属性」二级弹窗：复用 model-attr-editor 的 AttrEditor（与旧「添加 AI 服务」
 * 同一份表单）。思考区默认折叠成一行摘要（口径照旧弹窗的"自动"态），点「手动
 * 覆盖」才展开编辑；「恢复自动」回落到 openai 兼容网关的保守缺省并重新折叠。
 * 种子异步到达时合并进草稿（只补空/缺省字段）——草稿是弹窗内部状态，父层不能
 * 直接改，必须在这里 useEffect 消费。
 */
const ModelAttrDialog: FC<{
  edit: { id: string; draft: AttrDraft };
  seed?: ModelAddModelSeed | null;
  onCommit: (draft: AttrDraft) => void;
  onClose: () => void;
}> = ({ edit, seed, onCommit, onClose }) => {
  const [draft, setDraft] = useState<AttrDraft>(edit.draft);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  useEffect(() => {
    if (seed) setDraft((prev) => mergeSeed(prev, seed));
  }, [seed]);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle className="flex min-w-0 items-center gap-2 pr-6 text-base font-semibold">
          <span className="shrink-0">模型属性</span>
          <Badge variant="outline" title={edit.id} className="max-w-[360px]">
            <span className="min-w-0 truncate">{edit.id}</span>
          </Badge>
        </DialogTitle>
        <AttrEditor
          draft={draft}
          busy={false}
          showThinking
          thinkingAuto
          thinkingOverride={thinkingOpen}
          thinkingAutoSummary={thinkingSummary(draft)}
          defaultedAttrs={[]}
          onRequestThinkingOverride={() => setThinkingOpen(true)}
          onRestoreAutoThinking={() => {
            setDraft((prev) => ({
              ...prev,
              tOff: "",
              tMin: true,
              tLow: true,
              tMed: true,
              tHigh: true,
              tXhigh: false,
              tMax: false,
            }));
            setThinkingOpen(false);
          }}
          onRestoreAutoAttrs={() =>
            setDraft((prev) => ({
              ...prev,
              ctx: "",
              max: "",
              text: false,
              image: false,
              cIn: "",
              cOut: "",
              cRead: "",
              cWrite: "",
              pcShort: "",
              pcLong: "",
            }))
          }
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
          onConfirm={() => onCommit(draft)}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
};

/**
 * 二级弹窗「已获取模型」：勾选要加入的模型。默认全不勾——用户筛选后勾了谁就加谁，
 * 预填全选会让"只想要几条"的操作把整个端点都带回来。已有模型重复勾选会在
 * 加入时按 id 去重，不另做禁用。全选作用于当前筛选的可见集。
 */
const FetchedModelsDialog: FC<{
  models: PiFetchedModelDetail[];
  onClose: () => void;
  onAdd: (picked: PiFetchedModelDetail[]) => void;
}> = ({ models, onClose, onAdd }) => {
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? models.filter((m) => m.id.toLowerCase().includes(q)) : models;
  }, [models, search]);
  const visibleChecked = filtered.filter((m) => checked.has(m.id)).length;
  const allVisibleSelected =
    filtered.length > 0 && visibleChecked === filtered.length;

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filtered.forEach((m) => next.delete(m.id));
      else filtered.forEach((m) => next.add(m.id));
      return next;
    });

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 rounded-3xl p-6 sm:max-w-[480px]"
      >
        <DialogTitle className="text-xl font-semibold">已获取模型</DialogTitle>
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground absolute top-5 right-5"
            />
          }
        >
          <XIcon className="size-5" />
          <span className="sr-only">关闭</span>
        </DialogClose>

        <div className="mt-6 flex flex-col gap-2.5">
          <div className="relative">
            <SearchIcon className="text-muted-foreground absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索模型…"
              className="h-9 ps-7"
            />
          </div>
          <div className="border-input max-h-56 overflow-y-auto rounded-2xl border p-1">
            {filtered.map((m) => (
              <label
                key={m.id}
                className="hover:bg-muted/60 flex h-10 cursor-pointer items-center gap-3.5 rounded-lg px-2.5 text-sm"
              >
                <Checkbox
                  checked={checked.has(m.id)}
                  onCheckedChange={() => toggle(m.id)}
                />
                <span className="min-w-0 flex-1 truncate">{m.id}</span>
                {m.contextLength !== undefined && (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {fmtContextWindow(m.contextLength)}
                  </span>
                )}
              </label>
            ))}
            {filtered.length === 0 && (
              <div className="text-muted-foreground py-8 text-center text-sm">
                {models.length === 0 ? "没有获取到模型" : "没有匹配的模型"}
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between gap-4">
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <Checkbox
              checked={allVisibleSelected}
              indeterminate={
                !allVisibleSelected && filtered.some((m) => checked.has(m.id))
              }
              onCheckedChange={toggleAll}
            />
            {/* 计数按当前筛选的可见集：搜索后看到的是"这几条里勾了几条"，
                不然 4/39 会让人以为全选在操作全量 */}
            全选（{visibleChecked}/{filtered.length}）
          </label>
          <div className="flex gap-3">
            <Button variant="outline" className="min-w-18" onClick={onClose}>
              取消
            </Button>
            <Button
              className="min-w-18"
              disabled={checked.size === 0}
              onClick={() => onAdd(models.filter((m) => checked.has(m.id)))}
            >
              添加
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * 提供商选择：触发器是填充式按钮（图标 + 名称 / 占位），面板走 Popover Portal——
 * 表单区会滚动，absolute 面板会被裁掉。面板顶部是搜索框（打开即聚焦），
 * 「自定义」固定在末尾、不随搜索过滤消失。键盘：↑↓ 移高亮、Enter 选中；
 * Esc/点外部由 base-ui 收起面板，不会关掉整个弹窗。
 */
const ProviderCombobox: FC<{
  id: string;
  providers: ModelAddProviderOption[];
  selected: ModelAddProviderOption | null;
  onSelect: (opt: ModelAddProviderOption) => void;
}> = ({ id, providers, selected, onSelect }) => {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [listOpen, setListOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    );
  }, [providers, search]);
  // 「自定义」永远是最后一项，参与键盘高亮
  const customIndex = filtered.length;

  const pick = (opt: ModelAddProviderOption) => {
    onSelect(opt);
    setListOpen(false);
    setSearch("");
  };

  // 高亮项跟着键盘滚进可视区
  useEffect(() => {
    if (!listOpen) return;
    listRef.current
      ?.querySelector<HTMLElement>("[data-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, [active, listOpen]);

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(i + 1, customIndex));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        pick(active < filtered.length ? filtered[active] : CUSTOM_OPTION);
        break;
      // Esc 交给 base-ui：只收面板，焦点回触发器
    }
  };

  return (
    <Popover
      open={listOpen}
      onOpenChange={(next) => {
        setListOpen(next);
        if (next) {
          setSearch("");
          setActive(0);
        } else {
          setSearch("");
        }
      }}
    >
      <PopoverTrigger
        render={
          <button
            id={id}
            type="button"
            role="combobox"
            aria-expanded={listOpen}
            className={cn(
              CONTROL,
              CONTROL_FOCUS_VISIBLE,
              "flex items-center gap-2 text-start",
            )}
          >
            {selected ? (
              <>
                {selected.id !== CUSTOM_PROVIDER_ID && (
                  <ProviderIcon
                    provider={selected.id}
                    providerName={selected.name}
                    className="size-4 shrink-0"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{selected.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground flex-1">请选择提供商</span>
            )}
            <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
          </button>
        }
      />
      <PopoverContent
        align="start"
        /* 表单滚动区矮于面板时，默认碰撞避让会兜底翻到锚点侧面（面板跑右边）。
           面板是 Portal 渲染，超出发弹窗底边也不会被裁——钉死在下方即可：
           不翻面、水平方向 shift 进视口 */
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        className="max-h-(--available-height) w-96 max-w-[calc(100vw-4rem)] p-0"
        initialFocus={searchRef}
      >
        <div className="relative shrink-0 p-2 pb-0">
          <SearchIcon className="text-muted-foreground absolute start-5 top-1/2 size-4 -translate-y-1/2" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActive(0);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="请选择提供商"
            autoComplete="off"
            spellCheck={false}
            className="h-9 ps-8"
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {filtered.map((opt, i) => (
            <ProviderRow
              key={opt.id}
              active={i === active}
              selected={selected?.id === opt.id}
              onHover={() => setActive(i)}
              onPick={() => pick(opt)}
            >
              <span className="bg-background flex size-8 shrink-0 items-center justify-center rounded-lg border">
                <ProviderIcon
                  provider={opt.id}
                  providerName={opt.name}
                  className="size-4"
                />
              </span>
              <span className="min-w-0 flex-1 truncate text-start">{opt.name}</span>
            </ProviderRow>
          ))}
          {filtered.length === 0 && (
            <div className="text-muted-foreground py-6 text-center text-sm">
              没有匹配的提供商
            </div>
          )}
        </div>
        <div className="shrink-0 border-t p-2 pt-1">
          <ProviderRow
            active={active === customIndex}
            selected={selected?.id === CUSTOM_PROVIDER_ID}
            onHover={() => setActive(customIndex)}
            onPick={() => pick(CUSTOM_OPTION)}
          >
            <span className="flex size-8 shrink-0 items-center justify-center">
              <PlusIcon className="text-muted-foreground size-4" />
            </span>
            <span className="flex-1 text-start">{CUSTOM_OPTION.name}</span>
          </ProviderRow>
        </div>
      </PopoverContent>
    </Popover>
  );
};

const ProviderRow: FC<{
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
  children: ReactNode;
}> = ({ active, selected, onHover, onPick, children }) => (
  <button
    type="button"
    role="option"
    aria-selected={selected}
    data-active={active || undefined}
    onMouseEnter={onHover}
    onClick={onPick}
    className="data-active:bg-muted flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-sm outline-none"
  >
    {children}
  </button>
);
