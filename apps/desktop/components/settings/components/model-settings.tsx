"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/custom-ui/setting-row";
import {
  CUSTOM_PROVIDER_ID,
  ModelAddDialog,
  type ModelAddBuiltinCatalog,
  type ModelAddFetchInput,
  type ModelAddInitial,
  type ModelAddModelInput,
  type ModelAddSaveInput,
  type ModelAddTestInput,
} from "@/components/settings/components/model-add-dialog";
import { THINK_LEVELS } from "@/components/settings/components/model-attr-editor";
import { ModelImportDialog } from "@/components/settings/components/model-import-dialog";
import {
  currentSpecForSave,
  mergeModelSpecForSave,
} from "@/components/settings/components/model-spec-save";
import {
  headerRecordToRows,
  headerRowsToRecord,
} from "@/lib/model/provider-headers";
import { ProviderIcon } from "@/components/custom-ui/provider-icon";
import { cn } from "@/lib/utils";
import { channelTimeoutMs, type DynamicModelsUpdatedFrame } from "pi-protocol";
import { subscribeWireFrames } from "@/lib/pi/wire-bus";
import {
  piRequest,
  type PiCredentialSummary,
  type PiCustomApiKind,
  type PiCustomModelSpec,
  type PiCustomProviderSummary,
  type PiFetchedModelDetail,
  type PiModelSummary,
  type PiProviderSummary,
  type PiStoredModelAttrs,
  type PiThinkingSeed,
} from "@/lib/pi/pi-bridge";
import { isDesktop } from "@/lib/desktop-env";
import {
  saveImageGenConfig,
  setModelImageCapable,
  useImageGenConfig,
} from "@/lib/settings/imagegen-config";
import {
  saveVisionToolSettings,
  setVisionToolModel,
  useVisionToolSettings,
} from "@/lib/settings/vision-tool-config";
import {
  setAutoVerifyEnabled,
  useAutoVerifySettings,
} from "@/lib/settings/auto-verify-config";
import { isUsableVisionModel } from "@/lib/pi/pi-vision-warning";
import {
  buildModelOptions,
  groupModelOptions,
  modelOptionId,
  splitModelOptionId,
} from "@/lib/pi/pi-model-groups";
import {
  ModelSelector,
  type ModelOption,
} from "@/components/assistant-ui/elements/model-selector.aui";
import { setSelectedModel, useSelectedModel } from "@/lib/model/model-settings";
import {
  THINKING_LEVEL_LABELS,
  setThinkingLevel,
  useThinkingLevel,
  type ThinkingLevel,
} from "@/lib/settings/thinking-settings";
import { refreshPiModels } from "@/lib/pi/pi-models";
import {
  getModelThinkingMap,
  setModelThinkingMap,
  type ModelThinkingMap,
} from "@/lib/pi/thinking-maps";
import { fmtContextWindow } from "@/lib/model/model-format";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ImportIcon,
  KeyRoundIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import { getLocale, useT } from "@/lib/i18n";

/**
 * 部分内置服务的凭据除 API Key 外还需要补充字段（pi-ai 侧按字段名回落
 * process.env，缺了就解析不出凭据 → 该服务所有模型被标成未认证，从
 * 默认模型/对话页选择器里整体消失）。值随 set_credential.env 存 sidecar kv
 * （credential.env.<provider>），非密钥、明文回传预填。
 */
const BUILTIN_CREDENTIAL_EXTRA_FIELDS: Record<
  string,
  { name: string; label: string; hintKey?: string }[]
> = {
  "cloudflare-ai-gateway": [
    { name: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare Account ID" },
    {
      name: "CLOUDFLARE_GATEWAY_ID",
      label: "AI Gateway ID",
      hintKey: "settings.models.form.cloudflareGatewayHint",
    },
  ],
  "cloudflare-workers-ai": [
    { name: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare Account ID" },
  ],
};

/** 行内启用开关（iOS 风格） */
const ToggleSwitch: FC<{
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}> = ({ checked, disabled, onToggle }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={onToggle}
    className={cn(
      "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
      checked ? "bg-primary" : "bg-muted-foreground/30",
    )}
  >
    <span
      className={cn(
        "absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]",
        checked ? "left-[1.15rem]" : "left-0.5",
      )}
    />
  </button>
);

/**
 * 思考映射编辑的种子：以目录生效值（supportedThinkingLevels + thinkingLevelMap.off）
 * 为准；模型未知（新添加尚未注册）时给 openai 兼容网关的保守缺省：
 * minimal/low/medium/high 可用、xhigh/max 关、off 不发。
 */
function thinkingSeed(info: PiModelSummary | undefined) {
  const supported = info?.supportedThinkingLevels;
  return {
    enabled: (level: string) =>
      supported ? supported.includes(level) : !["xhigh", "max"].includes(level),
    off: typeof info?.thinkingLevelMap?.off === "string" ? info.thinkingLevelMap.off : "",
  };
}

/** 模型配置页：默认模型 / AI 服务（自定义提供商）/ 厂商账户（凭据）/ 模型目录 */
export const ModelSettings: FC = () => {
  const t = useT();
  const [models, setModels] = useState<PiModelSummary[] | null>(null);
  const [providers, setProviders] = useState<PiProviderSummary[]>([]);
  const [credentials, setCredentials] = useState<PiCredentialSummary[]>([]);
  const [customProviders, setCustomProviders] = useState<
    PiCustomProviderSummary[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [credOpen, setCredOpen] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [newProvider, setNewProvider] = useState("");
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);
  // 从 opencode / Codex  导入模型服务的预览弹窗
  const [importOpen, setImportOpen] = useState(false);

  // 添加/编辑模型弹窗（新版 ModelAddDialog）：表单状态在弹窗内部
  const [svcOpen, setSvcOpen] = useState(false);
  /** null = 新增；编辑时 = 目标 providerId（目前只有自定义端点支持编辑） */
  const [svcEditing, setSvcEditing] = useState<string | null>(null);
  /** 弹窗预填：编辑自定义端点时给完整表单，null = 新增 */
  const [svcInitial, setSvcInitial] = useState<ModelAddInitial | null>(null);
  /** 弹窗内的保存错误：显示在弹窗里，不整页替换——保存失败时弹窗保持打开可改 */
  const [svcError, setSvcError] = useState<string | null>(null);
  // 打开编辑弹窗时的生效值快照 + 行里显式存过的值：提交时用来区分"用户改过的
  // 字段"与"目录种子/缺省算出来的生效值"，只回写前者（见 model-spec-save.ts）
  const [svcAttrsLoaded, setSvcAttrsLoaded] = useState<Record<string, PiCustomModelSpec>>({});
  const [svcModelStored, setSvcModelStored] = useState<Record<string, PiStoredModelAttrs>>({});
  // 列表行快速测试：成功后短暂显示 ✓ 的 providerId
  const [testOkId, setTestOkId] = useState<string | null>(null);
  const selected = useSelectedModel();
  const defaultThinking = useThinkingLevel();

  // 文生图区块：整包配置在 sidecar kv（pi.imagegen），模型候选复用本页目录
  const imagegen = useImageGenConfig();
  // 视觉辅助区块：see_image 工具开关（sidecar kv pi.visionTool；关闭时不注册
  // 工具、不替换图片占位，提示词零污染）。视觉模型可手动指定，留「自动选择」
  // 为缺省；候选与 sidecar 自动挑选同一份谓词口径（isUsableVisionModel），
  // 选择器复用共享 ModelSelector（搜索/分组/厂商图标/「视觉」能力徽标同 composer）
  const visionTool = useVisionToolSettings();
  const autoVerify = useAutoVerifySettings();
  const visionModels = (models ?? []).filter(isUsableVisionModel);
  const visionModelAvailable = visionModels.length > 0;
  const VISION_AUTO_OPTION: ModelOption = {
    id: "auto",
    name: t("settings.models.vision.autoName"),
    description: t("settings.models.vision.autoDesc"),
  };
  const visionModelOptions = [
    VISION_AUTO_OPTION,
    ...buildModelOptions(visionModels),
  ];
  const visionModelGroups = groupModelOptions(
    visionModels,
    visionModelOptions.filter((o) => o.id !== VISION_AUTO_OPTION.id),
  );
  const visionValue =
    visionTool.provider && visionTool.modelId
      ? `${visionTool.provider}/${visionTool.modelId}`
      : VISION_AUTO_OPTION.id;
  const visionSelectedLabel = visionTool.provider && visionTool.modelId
    ? (visionModels.find((m) => modelOptionId(m) === visionValue)?.name ??
      `${visionTool.provider}/${visionTool.modelId}`)
    : VISION_AUTO_OPTION.name;
  const pickVisionModel = (id: string) => {
    // 「自动选择」= 清空显式指定，不写一个假的 provider/modelId
    if (id === VISION_AUTO_OPTION.id) {
      void setVisionToolModel("", "").catch(() =>
        toast.error(t("settings.models.saveFailed")),
      );
      return;
    }
    const { provider, modelId } = splitModelOptionId(id);
    void setVisionToolModel(provider, modelId).catch(() =>
      toast.error(t("settings.models.saveFailed")),
    );
  };
  // 只列已勾选「可生成图片」标记且已配好凭据、启用的模型（文生图能力存 imagegen
  // 配置覆盖层，标记入口在本页模型属性弹窗）；当前选择若已不在清单（删除/取消标记），
  // 合成一项保住回显
  const imageModelOptions = (models ?? [])
    .filter((m) => m.authed && m.enabled && m.t2i)
    .map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: (
        <span className="flex items-center gap-2">
          <ProviderIcon
            provider={m.provider}
            modelId={m.id}
            providerName={m.providerName}
          />
          {`${m.providerName} · ${m.name || m.id}`}
        </span>
      ),
    }));
  {
    const cur =
      imagegen.provider && imagegen.modelId
        ? `${imagegen.provider}/${imagegen.modelId}`
        : "";
    if (cur && !imageModelOptions.some((o) => o.value === cur)) {
      // 已不在清单的选择（服务删除/取消标记）：按复合 id 还原 mark，保住回显
      const sep = cur.indexOf("/");
      imageModelOptions.unshift({
        value: cur,
        label: (
          <span className="flex items-center gap-2">
            <ProviderIcon
              provider={cur.slice(0, sep)}
              modelId={cur.slice(sep + 1)}
            />
            {`${cur}${t("settings.models.imagegen.currentSuffix")}`}
          </span>
        ),
      });
    }
  }

  const load = useCallback(() => {
    if (!isDesktop()) return;
    setError(null);
    piRequest<{
      type: "models";
      models: PiModelSummary[];
      providers: PiProviderSummary[];
    }>({ type: "list_models" })
      .then((res) => {
        setModels(res.models);
        setProviders(res.providers);
        setLastRefresh(
          new Date().toLocaleTimeString(
            getLocale() === "en" ? "en-US" : "zh-CN",
            { hour12: false },
          ),
        );
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    piRequest<{ type: "credentials"; credentials: PiCredentialSummary[] }>({
      type: "list_credentials",
    })
      .then((res) => setCredentials(res.credentials))
      .catch(() => {});
    piRequest<{
      type: "custom_providers";
      providers: PiCustomProviderSummary[];
    }>({ type: "list_custom_providers" })
      .then((res) => setCustomProviders(res.providers))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 动态发现后台刷新的广播帧（保存/启停后的按需补发现、sidecar 启动扫描）：
  // 缓存有增删才发。收到即重拉清单；有新增时 toast 提示（用户没主动操作也会
  // 长出新模型，不提示会显得"服务自己变了"）
  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    void subscribeWireFrames<DynamicModelsUpdatedFrame>(
      ["dynamic_models_updated"],
      (frame) => {
        if (!alive || frame?.type !== "dynamic_models_updated") return;
        load();
        refreshPiModels();
        if (frame.added > 0) {
          toast.success(
            t("settings.models.service.discovered", {
              provider: frame.provider,
              added: frame.added,
              total: frame.total,
            }),
          );
        }
      },
    ).then((off) => {
      if (alive) unsubscribe = off;
      else off();
    })
      // 传输建立失败（非桌面环境等）：本页依赖 isDesktop 门控的拉取已兜底，
      // 只是少了后台刷新的自动重拉，静默降级
      .catch(() => {});
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [load, t]);

  const saveCredential = useCallback(async () => {
    if (!newProvider || !newKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await piRequest({
        type: "set_credential",
        provider: newProvider,
        apiKey: newKey.trim(),
      });
      setNewKey("");
      setCredOpen(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [newProvider, newKey, busy, load]);

  const deleteCredential = useCallback(
    async (providerId: string) => {
      setBusy(true);
      try {
        await piRequest({ type: "delete_credential", provider: providerId });
        load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /** 添加/更新自定义 OpenAI 兼容提供商；id 传 providerId 表示编辑更新 */
  const saveCustomProvider = useCallback(
    async (input: {
      providerId?: string;
      name: string;
      baseUrl: string;
      apiKey: string;
      api: PiCustomApiKind;
      models: PiCustomModelSpec[];
      /** 动态模型发现开关：sidecar 保存后按新鲜期后台补发现 */
      autoDiscover?: boolean;
      /** 自定义请求头（空对象 = 不发送；编辑时空对象会清空已存头） */
      headers: Record<string, string>;
    }) => {
      setBusy(true);
      setError(null);
      try {
        const res = await piRequest({
          type: "add_custom_provider",
          // 业务 id 走 providerId 字段（协议层 reqId 占用 "id"），有值 = 编辑更新
          ...(input.providerId ? { providerId: input.providerId } : {}),
          name: input.name,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          api: input.api,
          models: input.models,
          autoDiscover: input.autoDiscover === true,
          headers: input.headers,
        }) as { type: "custom_provider"; provider: string };
        load();
        // 与 update_model 同理：模型能力（input/视觉等）变了，对话侧目录快照必须跟上
        refreshPiModels();
        // add_custom_provider 的应答带真实 providerId：新增后落思考映射/生图标记用
        return res;
      } catch (err) {
        // 双通道反馈：弹窗内常驻一行（可对照着改）+ toast 防止没注意到。
        // 不用页面级 error——那会把整页换成错误页、弹窗被卸载
        const msg = err instanceof Error ? err.message : String(err);
        setSvcError(msg);
        toast.error(msg);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const deleteCustomProvider = useCallback(
    async (providerId: string) => {
      setBusy(true);
      try {
        await piRequest({
          type: "delete_custom_provider",
          provider: providerId,
        });
        load();
        // 对话页的模型目录也得跟上：sidecar 已把它移出目录并清掉全局选中键，
        // 不刷新的话对话页仍认为该模型可用，发送闸门会放过一轮「界面显示 A、
        // sidecar 拿默认模型 B 应答」的请求
        refreshPiModels();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const closeServiceDialog = useCallback(() => {
    setSvcOpen(false);
    setSvcEditing(null);
    setSvcInitial(null);
    setSvcError(null);
    setSvcAttrsLoaded({});
    setSvcModelStored({});
  }, []);

  /** 打开"添加模型"弹窗（新增） */
  const openNewService = useCallback(() => {
    setSvcEditing(null);
    setSvcInitial(null);
    setSvcError(null);
    setSvcAttrsLoaded({});
    setSvcModelStored({});
    setSvcOpen(true);
  }, []);

  /** 打开"编辑模型"弹窗（仅自定义端点支持编辑）：完整回填表单与各模型属性。
   *  Key 不回填（sidecar 只回掩码），输入框留空保存 = 保持原 Key。
   *  思考档位预填写目录生效值（supportedThinkingLevels/thinkingLevelMap.off），
   *  与旧属性弹窗 openAttrEditor 的口径一致；保存时按差异落思考映射。
   *  AUTO 模型（动态发现）不进可编辑行——保存会整表替换 models 行，把 AUTO
   *  一起提交会把发现结果全部晋升为手写；它们由服务列表的刷新按钮管理 */
  const openEditService = useCallback((cp: PiCustomProviderSummary) => {
    const attrs: Record<string, PiCustomModelSpec> = {};
    const stored: Record<string, PiStoredModelAttrs> = {};
    const modelsIn: ModelAddModelInput[] = [];
    for (const m of cp.models) {
      if (m.auto) continue;
      attrs[m.id] = {
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: m.input,
        cost: m.cost,
      };
      if (m.stored) stored[m.id] = m.stored;
      // 生图标记与思考档位的现值在 list_models 行里（spec 摘要不含）
      const row = (models ?? []).find(
        (x) => x.provider === cp.providerId && x.id === m.id,
      );
      modelsIn.push({
        id: m.id,
        spec: attrs[m.id],
        thinkingLevels: row?.supportedThinkingLevels ?? [],
        thinkingOff:
          typeof row?.thinkingLevelMap?.off === "string"
            ? row.thinkingLevelMap.off
            : "",
        t2i: row?.t2i ?? false,
      });
    }
    setSvcEditing(cp.providerId);
    setSvcInitial({
      providerId: CUSTOM_PROVIDER_ID,
      ...(cp.apiKeyMasked ? { apiKeyMasked: cp.apiKeyMasked } : {}),
      custom: {
        name: cp.name,
        api: cp.api,
        baseUrl: cp.baseUrl,
        headers: headerRecordToRows(cp.headers),
        models: modelsIn,
        autoDiscover: cp.autoDiscover ?? false,
      },
    });
    // 快照与回填同源：提交时按它判断哪些字段真被改过（见 model-spec-save.ts）
    setSvcAttrsLoaded(attrs);
    setSvcModelStored(stored);
    setSvcError(null);
    setSvcOpen(true);
  }, [models]);

  /** 「自动获取」适配：按接口格式调 sidecar fetch_models；弹窗自管加载/错误态，
   *  这里只发请求、返回 id 列表（编辑态密钥留空时 sidecar 按已存凭据兜底） */
  const fetchServiceModels = useCallback(
    async (input: ModelAddFetchInput): Promise<PiFetchedModelDetail[]> => {
      // 弹窗发来的 providerId 是「自定义」占位 id（CUSTOM_PROVIDER_ID，弹窗靠它
      // 识别自定义服务），真实服务 id 在 svcEditing——凭据按真实 id 才兜得到底
      const fallbackProviderId =
        input.providerId === CUSTOM_PROVIDER_ID ? (svcEditing ?? undefined) : input.providerId;
      const res = await piRequest<{
        type: "fetched_models";
        models: string[];
        details?: PiFetchedModelDetail[];
      }>(
        {
          type: "fetch_models",
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          ...(fallbackProviderId ? { providerId: fallbackProviderId } : {}),
          api: input.api,
          // 空名行忽略、同名后行覆盖（见 provider-headers.ts）
          headers: headerRowsToRecord(input.headers),
        },
        // 两段式：结果帧最晚 fetch 15s 超时后到，显式按预算等（缺省会传 15s
        // 触发通道的抬升告警）
        channelTimeoutMs("fetch_models"),
      );
      const byId = new Map((res.details ?? []).map((d) => [d.id, d]));
      return res.models.map((id) => byId.get(id) ?? { id });
    },
    [svcEditing],
  );

  /** 「测试连接」适配：按接口格式对端点发一条最小请求（表单当前值 + 首个模型）；
   *  编辑态密钥留空时 sidecar 按 providerId 取已存凭据兜底（明文 key 不出渲染进程） */
  const testServiceConnection = useCallback(
    async (input: ModelAddTestInput): Promise<void> => {
      // 同 fetchServiceModels：占位 id 换成真实服务 id，密钥留空才兜得到已存凭据
      const fallbackProviderId =
        input.providerId === CUSTOM_PROVIDER_ID ? (svcEditing ?? undefined) : input.providerId;
      await piRequest(
        {
          type: "test_provider",
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          ...(fallbackProviderId ? { providerId: fallbackProviderId } : {}),
          api: input.api,
          model: input.model,
          headers: headerRowsToRecord(input.headers),
        },
        // 两段式：结果帧最晚 fetch 20s 超时后到，显式按预算等
        channelTimeoutMs("test_provider"),
      );
    },
    [svcEditing],
  );

  /** 内置厂商的目录模型全集 + 当前启用集（弹窗「模型」勾选区候选）。
   *  无过滤行 = 全部启用（稀疏白名单语义，见 list_models 处理）。
   *  带上生效值 spec/思考/生图标记：行内「属性」弹窗预填用 */
  const fetchBuiltinCatalog = useCallback(
    async (id: string): Promise<ModelAddBuiltinCatalog> => {
      const catalog = (models ?? []).filter((m) => m.provider === id);
      const all = catalog.map((m) => ({
        id: m.id,
        name: m.name || undefined,
        contextWindow: m.contextWindow,
        spec: {
          id: m.id,
          name: m.name || undefined,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          input: m.input,
          cost: m.cost,
          promptCache: m.promptCache,
        },
        thinkingLevels: m.supportedThinkingLevels ?? undefined,
        thinkingOff:
          typeof m.thinkingLevelMap?.off === "string"
            ? m.thinkingLevelMap.off
            : undefined,
        t2i: m.t2i,
      }));
      const allIds = all.map((m) => m.id);
      try {
        const res = await piRequest<{
          type: "provider_filter";
          provider: string;
          models: string[] | null;
        }>({ type: "get_provider_filter", provider: id });
        return {
          models: all,
          selected: res.models
            ? res.models.filter((x) => allIds.includes(x))
            : allIds,
        };
      } catch {
        return { models: all, selected: allIds };
      }
    },
    [models],
  );

  /** 属性弹窗的目录种子预填（新增/目录外模型）：与旧弹窗 openAttrEditor 同一 IPC */
  const lookupSeed = useCallback(
    (modelId: string) =>
      piRequest<{ type: "thinking_seed"; seed: PiThinkingSeed | null }>({
        type: "lookup_thinking_seed",
        modelId,
      }).then((r) => r.seed),
    [],
  );

  /** 启用/停用自定义服务 */
  const toggleCustomProvider = useCallback(
    async (cp: PiCustomProviderSummary) => {
      setBusy(true);
      setError(null);
      try {
        await piRequest({
          type: "toggle_custom_provider",
          provider: cp.providerId,
          enabled: !cp.enabled,
        });
        load();
        // 停用同删除：模型离开目录、选中键被清，对话页目录必须同步刷新
        refreshPiModels();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /** 列表行快速测试：用已保存配置 + 首个模型发一条最小请求 */
  const quickTestProvider = useCallback(
    async (cp: PiCustomProviderSummary) => {
      const model = cp.models[0]?.id;
      if (!model || busy) return;
      setError(null);
      setBusy(true);
      try {
        await piRequest(
          {
            type: "test_provider",
            baseUrl: cp.baseUrl,
            // 不回传明文：providerId 让 sidecar 端取已存凭据
            apiKey: "",
            providerId: cp.providerId,
            api: cp.api,
            model,
          },
          channelTimeoutMs("test_provider"),
        );
        setTestOkId(cp.providerId);
        setTimeout(
          () => setTestOkId((v) => (v === cp.providerId ? null : v)),
          1500,
        );
      } catch (err) {
        // setError(err instanceof Error ? err.message : String(err));
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  /** 动态发现服务卡片刷新：强制拉网关 /models 重注册（refresh_dynamic_models
   *  两段式，迟到帧配对回来带增删计数）。完成后 load() 重拉清单——
   *  dynamic_models_updated 帧也会触发重拉，这里先手动刷保证按钮反馈即时 */
  const refreshDynamicModels = useCallback(
    async (cp: PiCustomProviderSummary) => {
      if (busy) return;
      setError(null);
      setBusy(true);
      try {
        const res = await piRequest<{
          type: "dynamic_models_refreshed";
          provider: string;
          added: number;
          removed: number;
          total: number;
        }>(
          { type: "refresh_dynamic_models", provider: cp.providerId },
          channelTimeoutMs("refresh_dynamic_models"),
        );
        load();
        refreshPiModels();
        toast.success(
          res.added > 0
            ? t("settings.models.service.refreshAdded", {
                count: res.added,
                total: res.total,
              })
            : res.removed > 0
              ? t("settings.models.service.refreshRemoved", {
                  count: res.removed,
                  total: res.total,
                })
              : t("settings.models.service.refreshLatest", { total: res.total }),
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, load, t],
  );

  /** 提交「添加/编辑模型」弹窗：自定义端点走 add_custom_provider，内置厂商走
   *  凭据 + 模型过滤。思考档位/生图标记不在 spec 里：保存成功拿到真实
   *  providerId 后逐模型落 imagegen 覆盖层与思考映射（与旧属性弹窗的确认逻辑
   *  同口径：与目录种子求差，无差但有存覆盖则清除） */
  const submitService = useCallback(
    async (input: ModelAddSaveInput) => {
      setError(null);
      setSvcError(null);
      if (input.providerId === CUSTOM_PROVIDER_ID && input.custom) {
        const custom = input.custom;
        try {
          const res = await saveCustomProvider({
            providerId: svcEditing ?? undefined,
            name: custom.name,
            baseUrl: custom.baseUrl,
            apiKey: input.apiKey,
            api: custom.api,
            models: custom.models.map((m) =>
              mergeModelSpecForSave({
                id: m.id,
                current: currentSpecForSave({
                  spec: m.spec,
                  touched: m.touched === true,
                  loaded: svcAttrsLoaded[m.id],
                }),
                loaded: svcAttrsLoaded[m.id],
                stored: svcModelStored[m.id],
              }),
            ),
            autoDiscover: custom.autoDiscover,
            // 空名行忽略、同名以最后一行为准（见 provider-headers.ts）
            headers: Object.fromEntries(
              custom.headers.map((h) => [h.name, h.value]),
            ),
          });
          const providerId = svcEditing ?? res.provider;
          // models 列表此刻还没刷新：新增模型的现值按缺省（无覆盖）算。
          // 没进过属性弹窗的模型直接跳过——thinkingLevels 是空占位，拿它跟
          // 保守缺省求差会把档位写成"显式关闭"
          for (const m of custom.models) {
            if (!m.touched) continue;
            const row = (models ?? []).find(
              (x) => x.provider === providerId && x.id === m.id,
            );
            if ((row?.t2i ?? false) !== m.t2i) {
              await setModelImageCapable(providerId, m.id, m.t2i).catch(() => {});
            }
            const seed = thinkingSeed(row);
            const patch: ModelThinkingMap = {};
            for (const t of THINK_LEVELS) {
              if (m.thinkingLevels.includes(t.level) !== seed.enabled(t.level)) {
                patch[t.level] = m.thinkingLevels.includes(t.level) ? t.level : null;
              }
            }
            if (m.thinkingOff.trim() !== seed.off) {
              patch.off = m.thinkingOff.trim() || null;
            }
            if (Object.keys(patch).length) {
              await setModelThinkingMap(providerId, m.id, patch).catch(() => {});
            } else if (getModelThinkingMap(providerId, m.id)) {
              // 与目录种子无差异但存有覆盖 → 清除覆盖（恢复自动）
              await setModelThinkingMap(providerId, m.id, null).catch(() => {});
            }
          }
          refreshPiModels();
          closeServiceDialog();
          toast.success(
            svcEditing
              ? t("settings.models.service.updated")
              : t("settings.models.service.added"),
          );
        } catch {
          // saveCustomProvider 内已 setSvcError + toast
        }
        return;
      }
      // 内置厂商：保存凭据（已有凭据时密钥可留空）+ 模型过滤（勾选集写 pi_models 行）。
      // 声明了补充字段的 provider 始终发 set_credential：即使 Key 留空也要同步 env
      const credExists = credentials.some((c) => c.providerId === input.providerId);
      const envFields = BUILTIN_CREDENTIAL_EXTRA_FIELDS[input.providerId];
      if (!input.apiKey && !credExists) {
        setSvcError(t("settings.models.service.apiKeyRequired"));
        return;
      }
      setBusy(true);
      try {
        if (input.apiKey || envFields) {
          await piRequest({
            type: "set_credential",
            provider: input.providerId,
            apiKey: input.apiKey,
            ...(envFields
              ? {
                  // 空值剔除：清空的字段从 kv 移除，pi-ai 回落 process.env
                  env: Object.fromEntries(
                    envFields
                      .map((f) => [f.name, (input.env?.[f.name] ?? "").trim()])
                      .filter(([, v]) => v !== ""),
                  ),
                }
              : {}),
          });
        }
        await piRequest({
          type: "set_provider_filter",
          provider: input.providerId,
          models: input.models ?? [],
        });
        // 本次改过属性的内置模型：与目录现值求差，差了才 update_model（与旧
        // 属性弹窗确认逻辑同口径）；生图标记与思考映射同样按差异落
        for (const m of input.modelAttrs ?? []) {
          const row = (models ?? []).find(
            (x) => x.provider === input.providerId && x.id === m.id,
          );
          const patch: Record<string, unknown> = {
            type: "update_model",
            provider: input.providerId,
            modelId: m.id,
          };
          if (m.spec.name !== (row?.name ?? undefined)) patch.name = m.spec.name ?? null;
          if (m.spec.reasoning !== row?.reasoning) patch.reasoning = m.spec.reasoning;
          if (m.spec.contextWindow !== row?.contextWindow)
            patch.contextWindow = m.spec.contextWindow ?? null;
          if (m.spec.maxTokens !== row?.maxTokens)
            patch.maxTokens = m.spec.maxTokens ?? null;
          if (JSON.stringify(m.spec.input) !== JSON.stringify(row?.input ?? ["text"]))
            patch.input = m.spec.input;
          if (JSON.stringify(m.spec.cost) !== JSON.stringify(row?.cost))
            patch.cost = m.spec.cost;
          if (
            JSON.stringify(m.spec.promptCache ?? null) !==
            JSON.stringify(row?.promptCache ?? null)
          )
            patch.promptCache = m.spec.promptCache ?? null;
          if (Object.keys(patch).length > 3) await piRequest(patch);
          if ((row?.t2i ?? false) !== m.t2i) {
            await setModelImageCapable(input.providerId, m.id, m.t2i).catch(() => {});
          }
          const seed = thinkingSeed(row);
          const tpatch: ModelThinkingMap = {};
          for (const lv of THINK_LEVELS) {
            if (m.thinkingLevels.includes(lv.level) !== seed.enabled(lv.level)) {
              tpatch[lv.level] = m.thinkingLevels.includes(lv.level) ? lv.level : null;
            }
          }
          if (m.thinkingOff.trim() !== seed.off) {
            tpatch.off = m.thinkingOff.trim() || null;
          }
          if (Object.keys(tpatch).length) {
            await setModelThinkingMap(input.providerId, m.id, tpatch).catch(() => {});
          } else if (getModelThinkingMap(input.providerId, m.id)) {
            await setModelThinkingMap(input.providerId, m.id, null).catch(() => {});
          }
        }
        if ((input.modelAttrs?.length ?? 0) > 0) refreshPiModels();
        closeServiceDialog();
        load();
      } catch (err) {
        // 显示在弹窗里（页面级 error 会把整页换掉、弹窗消失）
        setSvcError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [
      svcEditing,
      svcAttrsLoaded,
      svcModelStored,
      models,
      credentials,
      saveCustomProvider,
      closeServiceDialog,
      load,
      t,
    ],
  );

  const groups = useMemo(() => {
    if (!models) return [];
    const query = search.trim().toLowerCase();
    // 只列已配置凭据（authed）的模型；被过滤隐藏的不出现在默认模型列表（在服务弹窗里管理）
    const filtered = models.filter(
      (m) =>
        m.authed &&
        m.enabled !== false &&
        (!query ||
          m.name.toLowerCase().includes(query) ||
          m.id.toLowerCase().includes(query) ||
          m.providerName.toLowerCase().includes(query)),
    );
    const byProvider = new Map<string, typeof filtered>();
    for (const m of filtered) {
      const bucket = byProvider.get(m.providerName);
      if (bucket) bucket.push(m);
      else byProvider.set(m.providerName, [m]);
    }
    return [...byProvider.entries()];
  }, [models, search]);

  const visibleModelCount = useMemo(
    () => (models ?? []).filter((m) => m.enabled !== false).length,
    [models],
  );

  const hasAuthedModel = models?.some((m) => m.authed) ?? false;

  /** 弹窗提供商选项：已添加的自定义服务不出现（catalog 会把它们注册成 provider，
   *  走服务列表里的编辑按钮）；「自定义」由 ModelAddDialog 固定追加在末尾 */
  const providerOptions = useMemo(() => {
    const customIds = new Set(customProviders.map((cp) => cp.providerId));
    return providers
      .filter((p) => !customIds.has(p.id))
      .map((p) => ({ id: p.id, name: p.name }));
  }, [providers, customProviders]);

  /** 已配置的内置厂商（有凭据且非自定义服务）：在 AI 服务列表中统一展示管理 */
  const builtinServices = useMemo(() => {
    const customIds = new Set(customProviders.map((cp) => cp.providerId));
    return credentials
      .filter((c) => !customIds.has(c.providerId))
      .map((c) => {
        const p = providers.find((x) => x.id === c.providerId);
        // authed 来自 list_models 的行（sidecar 侧 getAuth 解析结果）：凭据存了
        // 但解析不出（如 Cloudflare 缺 Account/Gateway ID）时为 false，卡片要照实说
        const authed = (models ?? [])
          .filter((m) => m.provider === c.providerId)
          .some((m) => m.authed);
        return {
          providerId: c.providerId,
          name: p?.name ?? c.providerId,
          authed,
          modelCount: (models ?? []).filter(
            (m) => m.provider === c.providerId && m.enabled !== false,
          ).length,
        };
      });
  }, [credentials, customProviders, providers, models]);

  /** AI 服务列表点"编辑"（内置厂商）：弹窗内会异步取目录与当前启用集回填；
   *  Key 留空保存 = 保持原 Key（sidecar 空串语义） */
  const openBuiltinService = useCallback(
    (id: string) => {
      setSvcEditing(id);
      setSvcInitial({
        providerId: id,
        env: credentials.find((c) => c.providerId === id)?.env ?? {},
      });
      setSvcError(null);
      setSvcAttrsLoaded({});
      setSvcModelStored({});
      setSvcOpen(true);
    },
    [credentials],
  );

  /** 删除内置厂商服务：移除凭据并清空其 pi_models 行（过滤与属性覆盖一并清除） */
  const deleteBuiltinService = useCallback(
    async (providerId: string) => {
      setBusy(true);
      setError(null);
      try {
        await piRequest({ type: "delete_credential", provider: providerId });
        await piRequest({
          type: "set_provider_filter",
          provider: providerId,
          models: [],
        });
        load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  // web 预览没有 桌面后端（pi sidecar / invoke），直接给出降级提示
  if (!isDesktop()) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        {t("settings.models.desktopOnly")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="text-destructive text-sm">{error}</div>
        <Button variant="outline" size="sm" className="mt-3" onClick={load}>
          {t("settings.models.catalog.retry")}
        </Button>
      </div>
    );
  }

  if (!models) {
    return (
      <div className="flex flex-col gap-2 p-8">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  const configured = new Set(credentials.map((c) => c.providerId));

  const selectedModel = selected
    ? models.find(
        (m) => m.provider === selected.provider && m.id === selected.modelId,
      )
    : undefined;
  const selectedText = selectedModel
    ? (selectedModel.name || selectedModel.id)
    : selected
      ? `${selected.provider}/${selected.modelId}`
      : t("settings.models.noServices");

  const thinkingItems = (Object.keys(THINKING_LEVEL_LABELS) as ThinkingLevel[]).map(
    (level) => ({
      value: level,
      label: t(`settings.models.thinking.${level}`),
    }),
  );

  const imageSizeOptions = [
    { value: "1024x1024", label: t("settings.models.imagegen.sizeSquare") },
    { value: "1792x1024", label: t("settings.models.imagegen.sizeLandscape") },
    { value: "1024x1792", label: t("settings.models.imagegen.sizePortrait") },
    { value: "auto", label: t("settings.models.imagegen.sizeAuto") },
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("settings.models.title")}
        </h1>

        {/* 默认项 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">
            {t("settings.models.defaultSection")}
          </h2>
          <div className="bg-muted/50 flex items-center gap-4 rounded-2xl px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {t("settings.models.defaultModel")}
              </div>
              <div className="text-muted-foreground truncate text-sm">
                {selectedText}
              </div>
            </div>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger
                render={
                  <Button variant="ghost" className="text-muted-foreground h-8">
                    {t("settings.models.change")}
                    <ChevronDownIcon className="size-4" />
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-96 p-0">
                <div className="relative p-2 pb-0">
                  <SearchIcon className="text-muted-foreground absolute start-5 top-1/2 size-4 -translate-y-1/2" />
                  <Input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("settings.models.searchModels")}
                    className="h-9 ps-8"
                  />
                </div>
                <div className="max-h-80 overflow-y-auto p-2">
                  {groups.map(([providerName, items]) => (
                    <div key={providerName} className="pb-2">
                      <div className="text-muted-foreground px-2.5 pb-1 text-[13px] leading-5 font-medium">
                        {/* 标题只写服务名：行内已经有模型 mark，标题再挂服务 mark
                            会出现同品牌两个图标 */}
                        {providerName}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {items.map((m) => {
                          const isSelected =
                            selected?.provider === m.provider &&
                            selected?.modelId === m.id;
                          return (
                            <button
                              key={`${m.provider}/${m.id}`}
                              type="button"
                              onClick={() => {
                                setSelectedModel({
                                  provider: m.provider,
                                  modelId: m.id,
                                });
                                setPickerOpen(false);
                              }}
                              data-selected={isSelected}
                              className={cn(
                                "hover:bg-muted flex h-9 items-center gap-2 rounded-md px-2.5 text-sm",
                                "data-selected:bg-muted",
                              )}
                            >
                              <span className="w-4 shrink-0">
                                {isSelected && <CheckIcon className="size-4" />}
                              </span>
                              <ProviderIcon
                                provider={m.provider}
                                modelId={m.id}
                                providerName={m.providerName}
                              />
                              <span className="min-w-0 flex-1 truncate text-start">
                                {m.name || m.id}
                              </span>
                              {m.reasoning && (
                                <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-5">
                                  {t("settings.models.reasoningBadge")}
                                </span>
                              )}
                              {m.input?.includes("image") && (
                                <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-5">
                                  {t("settings.models.visionBadge")}
                                </span>
                              )}
                              <span className="text-muted-foreground w-12 shrink-0 text-end text-[13px] leading-5 tabular-nums">
                                {fmtContextWindow(m.contextWindow)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {groups.length === 0 && (
                    <div className="text-muted-foreground py-8 text-center text-sm">
                      {t("settings.models.noMatchingModels")}
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className="bg-muted/50 flex items-center gap-4 rounded-2xl px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {t("settings.models.defaultLevel")}
              </div>
              <div className="text-muted-foreground text-sm leading-5">
                {t("settings.models.defaultLevelDesc")}
              </div>
            </div>
            <Select
              value={defaultThinking}
              items={thinkingItems}
              onValueChange={(v) => void setThinkingLevel(v as ThinkingLevel)}
            >
              <SelectTrigger size="sm" className="min-w-40 border bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {thinkingItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>

        {/* 视觉辅助：see_image 工具开关（sidecar kv；关闭时不注册工具、不替换
            图片占位，工具表/请求上下文与未引入该能力前逐字节一致——提示词零污染） */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {t("settings.models.vision.title")}
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.models.vision.intro")}
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.models.vision.enableLabel")}
              desc={
                visionModelAvailable
                  ? t("settings.models.vision.enableDescAvailable")
                  : t("settings.models.vision.enableDescUnavailable")
              }
            >
              <Switch
                checked={visionTool.enabled}
                onCheckedChange={(v) =>
                  void saveVisionToolSettings({ ...visionTool, enabled: v }).catch(
                    () => toast.error(t("settings.models.saveFailed")),
                  )
                }
              />
            </SettingRow>
            <SettingRow
              label={t("settings.models.vision.modelLabel")}
              desc={t("settings.models.vision.modelDesc")}
            >
              <ModelSelector.Root
                models={visionModelOptions}
                value={visionValue}
                onValueChange={pickVisionModel}
              >
                <ModelSelector.Trigger
                  variant="outline"
                  size="sm"
                  className="max-w-72 [&>span]:min-w-0 bg-background border-none"
                  title={visionSelectedLabel}
                >
                  {visionTool.provider && visionTool.modelId && (
                    <ProviderIcon
                      provider={visionTool.provider}
                      modelId={visionTool.modelId}
                      providerName={visionModels.find(
                        (m) => modelOptionId(m) === visionValue,
                      )?.providerName}
                    />
                  )}
                  <span className="truncate">{visionSelectedLabel}</span>
                </ModelSelector.Trigger>
                <ModelSelector.Content searchable className="w-80">
                  <ModelSelector.Search placeholder={t("settings.models.vision.searchModels")} />
                  <ModelSelector.List>
                    <ModelSelector.Item model={VISION_AUTO_OPTION} />
                    <ModelSelector.Empty>
                      {t("settings.models.vision.empty")}
                    </ModelSelector.Empty>
                    {visionModelGroups.map((group) => (
                      <ModelSelector.Group key={group.title} heading={group.title}>
                        {group.options.map((o) => (
                          <ModelSelector.Item key={o.id} model={o} />
                        ))}
                      </ModelSelector.Group>
                    ))}
                  </ModelSelector.List>
                </ModelSelector.Content>
              </ModelSelector.Root>
            </SettingRow>
          </div>
        </section>

        {/* autoVerify：run 改了文件后自动注入只读验证 followUp（sidecar kv pi.autoVerify；
         *  goal 模式互斥、automation 线程强制 off，注入走 [[auto-verify]] 哨兵不进气泡） */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {t("settings.models.autoVerify.title")}
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.models.autoVerify.intro")}
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.models.autoVerify.enableLabel")}
              desc={t("settings.models.autoVerify.enableDesc")}
            >
              <Switch
                checked={autoVerify.enabled}
                onCheckedChange={(v) =>
                  void setAutoVerifyEnabled(v).catch(() =>
                    toast.error(t("settings.models.saveFailed")),
                  )
                }
              />
            </SettingRow>
          </div>
        </section>

        {/* 文生图：generate_image 工具的开关/默认模型/尺寸（云端 API，配置存 sidecar kv） */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {t("settings.models.imagegen.title")}
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.models.imagegen.intro")}
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.models.imagegen.enableLabel")}
              desc={t("settings.models.imagegen.enableDesc")}
            >
              <Switch
                checked={imagegen.enabled}
                onCheckedChange={(v) =>
                  void saveImageGenConfig({ ...imagegen, enabled: v }).catch(
                    () => toast.error(t("settings.models.saveFailed")),
                  )
                }
              />
            </SettingRow>
            <SettingRow
              label={t("settings.models.imagegen.modelLabel")}
              desc={
                imageModelOptions.length
                  ? t("settings.models.imagegen.modelDescReady")
                  : t("settings.models.imagegen.modelDescEmpty")
              }
            >
              <Select
                value={
                  imagegen.provider && imagegen.modelId
                    ? `${imagegen.provider}/${imagegen.modelId}`
                    : ""
                }
                onValueChange={(v) => {
                  if (!v) return;
                  const at = v.lastIndexOf("/");
                  const provider = at > 0 ? v.slice(0, at) : v;
                  const modelId = at > 0 ? v.slice(at + 1) : "";
                  void saveImageGenConfig({
                    ...imagegen,
                    provider,
                    modelId,
                  }).catch(() => toast.error(t("settings.models.saveFailed")));
                }}
                items={imageModelOptions}
              >
                <SelectTrigger size="sm" className="max-w-80 min-w-64 border bg-background">
                  <SelectValue placeholder={t("settings.models.imagegen.selectPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {imageModelOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow
              label={t("settings.models.imagegen.sizeLabel")}
              desc={t("settings.models.imagegen.sizeDesc")}
            >
              <Select
                value={imagegen.size}
                onValueChange={(v) => {
                  if (!v) return;
                  void saveImageGenConfig({ ...imagegen, size: v }).catch(
                    () => toast.error(t("settings.models.saveFailed")),
                  );
                }}
                items={imageSizeOptions}
              >
                <SelectTrigger size="sm" className="min-w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {imageSizeOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </div>
        </section>

        {/* AI 服务（自定义 OpenAI 兼容提供商 / 内置厂商快捷配置） */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">
              {t("settings.models.service.title")}
            </h2>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <ImportIcon className="size-4" />
                {t("settings.models.service.importFromTools")}
              </Button>
              <Button onClick={openNewService}>
                <PlusIcon className="size-4" />
                {t("settings.models.service.add")}
              </Button>
            </div>
          </div>

          {customProviders.length === 0 && builtinServices.length === 0 ? (
            <div className="bg-muted/50 flex flex-col items-center rounded-2xl py-16">
              <div className="bg-background ring-foreground/10 flex size-11 items-center justify-center rounded-full ring-1">
                <ServerIcon className="text-muted-foreground size-5" />
              </div>
              <div className="mt-3 text-sm font-medium">
                {t("settings.models.service.emptyTitle")}
              </div>
              <div className="text-muted-foreground mt-1 text-[13px] leading-5">
                {t("settings.models.service.emptyDesc")}
              </div>
              <div className="mt-4 flex items-center gap-2">
                <Button onClick={openNewService}>
                  <PlusIcon className="size-4" />
                  {t("settings.models.service.add")}
                </Button>
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  <ImportIcon className="size-4" />
                  {t("settings.models.service.importFromTools")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {customProviders.map((cp) => (
                <div
                  key={cp.providerId}
                  className="hover:bg-muted/60 flex items-center gap-3 rounded-xl px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {/* 服务行 = provider 位置：只按服务身份认 mark（自定义端点的
                          id 是 custom-<slug>、名字由用户起，两者都是线索），不借
                          该服务下某个模型的品牌——那会让"我的中转站"挂上 Claude */}
                      <ProviderIcon
                        provider={cp.providerId}
                        providerName={cp.name}
                        className="size-4"
                      />
                      <span
                        title={
                          cp.enabled
                            ? t("settings.models.service.enabled")
                            : t("settings.models.service.disabled")
                        }
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          cp.enabled ? "bg-lime-500" : "bg-muted-foreground/40",
                        )}
                      />
                      <span className="min-w-0 truncate text-sm font-medium">
                        {cp.name}
                      </span>
                      {cp.autoDiscover && (
                        <span
                          title={t("settings.models.service.autoDiscoverTitle")}
                          className="rounded bg-muted px-1.5 py-0.5 text-[13px] leading-5 text-muted-foreground"
                        >
                          {t("settings.models.service.autoDiscover")}
                        </span>
                      )}
                      {selected?.provider === cp.providerId && (
                        <span className="rounded bg-lime-500/15 px-1.5 py-0.5 text-[13px] leading-5 font-medium text-lime-600">
                          {t("settings.models.service.defaultBadge")}
                        </span>
                      )}
                      {!cp.enabled && (
                        <span className="text-muted-foreground text-[13px] leading-5">
                          {t("settings.models.service.disabled")}
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate text-[13px] leading-5">
                      {cp.baseUrl} ·{" "}
                      {t("settings.models.service.modelCount", {
                        count: cp.models.length,
                      })}
                      {cp.autoDiscover &&
                        cp.models.some((m) => m.auto) &&
                        t("settings.models.service.autoCount", {
                          count: cp.models.filter((m) => m.auto).length,
                        })}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title={t("settings.models.service.edit")}
                      disabled={busy}
                      onClick={() => openEditService(cp)}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <PencilIcon className="size-3.5" />
                    </button>
                    {cp.autoDiscover && cp.enabled && (
                      <button
                        type="button"
                        title={t("settings.models.service.refreshModels")}
                        disabled={busy}
                        onClick={() => void refreshDynamicModels(cp)}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        <RefreshCwIcon className="size-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      title={t("settings.models.service.test")}
                      disabled={busy || !cp.enabled}
                      onClick={() => void quickTestProvider(cp)}
                      className={cn(
                        "disabled:opacity-50",
                        testOkId === cp.providerId
                          ? "text-lime-600"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {testOkId === cp.providerId ? (
                        <CheckIcon className="size-3.5" />
                      ) : (
                        <PlugIcon className="size-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      title={t("settings.models.service.delete")}
                      disabled={busy}
                      onClick={() => void deleteCustomProvider(cp.providerId)}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                    <ToggleSwitch
                      checked={cp.enabled}
                      disabled={busy}
                      onToggle={() => void toggleCustomProvider(cp)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 已配置的内置厂商：与自定义服务同列表管理（编辑过滤/密钥、删除） */}
          {builtinServices.length > 0 && (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {builtinServices.map((svc) => (
                <div
                  key={svc.providerId}
                  className="hover:bg-muted/60 flex items-center gap-3 rounded-xl px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <ProviderIcon
                        provider={svc.providerId}
                        providerName={svc.name}
                        className="size-4"
                      />
                      <span
                        title={
                          svc.authed
                            ? t("settings.models.service.authedTitle")
                            : t("settings.models.service.unauthedTitle")
                        }
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          svc.authed ? "bg-lime-500" : "bg-amber-500",
                        )}
                      />
                      <span className="min-w-0 truncate text-sm font-medium">
                        {svc.name}
                      </span>
                      {selected?.provider === svc.providerId && (
                        <span className="rounded bg-lime-500/15 px-1.5 py-0.5 text-[13px] leading-5 font-medium text-lime-600">
                          {t("settings.models.service.defaultBadge")}
                        </span>
                      )}
                      <span className="text-muted-foreground text-[13px] leading-5">
                        {t("settings.models.service.builtin")}
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate text-[13px] leading-5">
                      {t("settings.models.service.modelCount", { count: svc.modelCount })}
                      {!svc.authed && t("settings.models.service.credInvalid")}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title={t("settings.models.service.edit")}
                      disabled={busy}
                      onClick={() => openBuiltinService(svc.providerId)}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <PencilIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("settings.models.service.delete")}
                      disabled={busy}
                      onClick={() => void deleteBuiltinService(svc.providerId)}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 厂商账户（内置 Provider 凭据）—— 暂时停用，需要时恢复此段 */}
        {/* <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">厂商账户</h2>
            <Button
              disabled={credOpen}
              onClick={() => {
                setCredOpen(true);
                setNewProvider("");
                setNewKey("");
              }}
            >
              <KeyRoundIcon className="size-4" />
              添加账户
            </Button>
          </div>

          <div className="bg-muted/50 rounded-2xl px-5 py-4">
            {credentials.length === 0 && !credOpen ? (
              <div className="text-muted-foreground text-sm leading-relaxed">
                还没有登录任何厂商账户。
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {credentials.map((c) => (
                  <div
                    key={c.providerId}
                    className="flex items-center gap-2 text-sm"
                  >
                    <CheckIcon className="text-primary size-4 shrink-0" />
                    <span className="font-medium">
                      {providers.find((p) => p.id === c.providerId)?.name ??
                        c.providerId}
                    </span>
                    <span className="text-muted-foreground text-[13px] leading-5">
                      API Key 已保存至本机
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      title="删除账户"
                      onClick={() => void deleteCredential(c.providerId)}
                      className="text-muted-foreground hover:text-destructive ml-auto disabled:opacity-50"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </div>
                ))}
                {credOpen && (
                  <div className="flex items-center gap-2 pt-1">
                    <Select
                      value={newProvider || null}
                      onValueChange={(v) => setNewProvider(v ?? "")}
                    >
                      <SelectTrigger className="min-w-44">
                        <SelectValue placeholder="选择厂商" />
                      </SelectTrigger>
                      <SelectContent>
                        {providers
                          .filter((p) => !configured.has(p.id))
                          .map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="password"
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      placeholder="API Key"
                      autoComplete="off"
                      className="h-9 flex-1"
                      onKeyDown={(e) => {
                        // IME 组合中：回车是确认候选词，不是保存
                        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                        if (e.key === "Enter") void saveCredential();
                      }}
                    />
                    <Button
                      size="sm"
                      className="h-9"
                      disabled={!newProvider || !newKey.trim() || busy}
                      onClick={() => void saveCredential()}
                    >
                      保存
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-9"
                      onClick={() => setCredOpen(false)}
                    >
                      取消
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {!hasAuthedModel && (
            <div className="text-muted-foreground flex items-start gap-1.5 text-[13px] leading-5">
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              尚未配置任何厂商账户：添加 API Key 后即可在"默认模型"中选择对应模型。
            </div>
          )}
        </section> */}

        {/* 模型目录 */}
        <div className="bg-muted/50 flex items-center justify-between gap-4 rounded-2xl px-5 py-4">
          <span className="text-muted-foreground truncate text-sm">
            {t("settings.models.catalog.line", {
              count: visibleModelCount,
              time: lastRefresh ?? t("settings.models.catalog.never"),
            })}
          </span>
          {/* 目录是随 sidecar 分发的内置快照，不需要"更新"；增删改各路径都已
              自动 load()。只在加载失败或目录为空时留一个重试入口，平时不常驻
              （点了会连对话侧共用目录一起重读）。 */}
          {(error !== null || (models !== null && models.length === 0)) && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-8 shrink-0"
              disabled={busy}
              onClick={() => {
                load();
                refreshPiModels();
              }}
            >
              <RefreshCwIcon className="size-4" />
              {t("settings.models.catalog.retry")}
            </Button>
          )}
        </div>
      </div>

      {/* 从其它工具导入模型服务：解析在 sidecar，写入复用 add_custom_provider */}
      <ModelImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        existingProviders={customProviders.map((cp) => ({
          name: cp.name,
          providerId: cp.providerId,
        }))}
        onImported={load}
      />

      {/* 添加/编辑模型弹窗（新版）：内含模型属性二级弹窗与「已获取模型」勾选 */}
      <ModelAddDialog
        open={svcOpen}
        onOpenChange={(o) => !o && closeServiceDialog()}
        providers={providerOptions}
        initial={svcInitial}
        extraCredentialFields={BUILTIN_CREDENTIAL_EXTRA_FIELDS}
        getProviderModels={fetchBuiltinCatalog}
        onFetchModels={fetchServiceModels}
        onTestConnection={testServiceConnection}
        onLookupSeed={lookupSeed}
        onSave={submitService}
        error={svcError}
        saving={busy}
      />
    </div>
  );
};
