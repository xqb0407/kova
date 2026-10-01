"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { cn } from "@/lib/utils";
import {
  piRequest,
  type PiCredentialSummary,
  type PiCustomApiKind,
  type PiCustomModelSpec,
  type PiCustomProviderSummary,
  type PiModelSummary,
  type PiProviderSummary,
  type PiThinkingSeed,
} from "@/lib/pi/pi-bridge";
import { isTauri } from "@/lib/tauri";
import {
  saveImageGenConfig,
  setModelImageCapable,
  useImageGenConfig,
} from "@/lib/settings/imagegen-config";
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
import { Badge } from "@/components/ui/badge";

/** 接口格式选项：label 显示在触发器与下拉列表，endpoint 仅在下拉列表中作辅助说明 */
const API_FORMATS: {
  value: PiCustomApiKind;
  label: string;
  endpoint: string;
}[] = [
  { value: "openai-chat", label: "OpenAI Chat Completions", endpoint: "/chat/completions" },
  { value: "openai-responses", label: "OpenAI Responses", endpoint: "/responses" },
  { value: "anthropic-messages", label: "Anthropic Messages", endpoint: "/v1/messages" },
];

/** 弹窗表单字段：小标签 + 控件 */
const Field: FC<{
  label: ReactNode;
  className?: string;
  children: ReactNode;
}> = ({ label, className, children }) => (
  <Label className={cn("flex flex-col items-start gap-1.5", className)}>
    <span className="text-muted-foreground text-xs">{label}</span>
    {children}
  </Label>
);

/** 模型行勾选框 */
const ModelBox: FC<{ checked: boolean }> = ({ checked }) => (
  <span
    className={cn(
      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
      checked
        ? "border-primary bg-primary text-primary-foreground"
        : "border-foreground/25",
    )}
  >
    {checked && <CheckIcon className="size-3" />}
  </span>
);

/** 字段标签 + 缺省猜测值"未确认"徽标（网关 /models 无元数据、由 sidecar 缺省兜底的属性） */
const DefaultedLabel: FC<{ text: string; show: boolean }> = ({ text, show }) =>
  show ? (
    <span className="flex items-center gap-1.5">
      {text}
      <Badge
        variant="outline"
        className="h-4 shrink-0 px-1.5 text-[10px] font-normal"
        title="该值仍是 sidecar 缺省猜测（网关未提供此元数据），对照网关文档核实后填入即可确认"
      >
        未确认
      </Badge>
    </span>
  ) : (
    <>{text}</>
  );

/** 模型属性编辑表单（"支持深度思考"等能力标记也在这里）：渲染于二级弹窗内 */
const AttrEditor: FC<{
  draft: AttrDraft;
  busy: boolean;
  /** 是否显示思考映射编辑（模型已有确定的 provider 归属时可编辑） */
  showThinking: boolean;
  /** 目录已覆盖该模型档位且无前端覆盖 → 折叠为"自动"只读态 */
  thinkingAuto: boolean;
  /** 本次打开内用户点了"手动覆盖"：自动态展开为编辑态 */
  thinkingOverride: boolean;
  /** 目录生效档位的一句话摘要（自动态展示） */
  thinkingAutoSummary: string;
  /** 仍为 sidecar 缺省猜测值的属性字段（上下文窗口/最大输出旁标"未确认"） */
  defaultedAttrs: string[];
  onRequestThinkingOverride: () => void;
  onRestoreAutoThinking: () => void;
  onChange: (patch: Partial<AttrDraft>) => void;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({
  draft,
  busy,
  showThinking,
  thinkingAuto,
  thinkingOverride,
  thinkingAutoSummary,
  defaultedAttrs,
  onRequestThinkingOverride,
  onRestoreAutoThinking,
  onChange,
  onConfirm,
  onCancel,
}) => (
  <div className="flex flex-col gap-3">
    <div className="grid grid-cols-4 gap-2">
      <Field label="名称" className="col-span-4">
        <Input
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="h-8 text-[13px]"
        />
      </Field>
      <Field
        label={
          <DefaultedLabel
            text="上下文窗口"
            show={defaultedAttrs.includes("contextWindow")}
          />
        }
        className="col-span-2"
      >
        <Input
          type="number"
          min={0}
          value={draft.ctx}
          onChange={(e) => onChange({ ctx: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <Field
        label={
          <DefaultedLabel
            text="最大输出"
            show={defaultedAttrs.includes("maxTokens")}
          />
        }
        className="col-span-2"
      >
        <Input
          type="number"
          min={0}
          value={draft.max}
          onChange={(e) => onChange({ max: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <div className="col-span-4 flex items-center gap-4 text-sm">
        <span className="text-muted-foreground shrink-0">输入模态</span>
        <Label className="flex items-center gap-1.5 text-sm">
          <Checkbox
            checked={draft.text}
            onCheckedChange={(checked) => onChange({ text: checked })}
            className="size-4"
          />
          文本
        </Label>
        <Label className="flex items-center gap-1.5 text-sm">
          <Checkbox
            checked={draft.image}
            onCheckedChange={(checked) => onChange({ image: checked })}
            className="size-4"
          />
          图像
        </Label>
        {/* 能力标记：非推理模型勾上后对话页的深度思考开关才会真正下发 reasoning 参数 */}
        <Label className="ml-auto flex items-center gap-1.5 text-sm">
          <Checkbox
            checked={draft.reasoning}
            onCheckedChange={(checked) => onChange({ reasoning: checked })}
            className="size-4"
          />
          支持深度思考
        </Label>
        {/* 输出能力标记（存 imagegen 配置覆盖层）：勾上才会出现在文生图默认模型下拉 */}
        <Label
          className="flex items-center gap-1.5 text-sm"
          title="标记为可生成图片的模型（如 gpt-image-1 / dall-e-3 / seedream）：勾选后才会出现在「文生图 → 默认文生图模型」下拉里；供 generate_image 工具按 OpenAI images 协议调用"
        >
          <Checkbox
            checked={draft.t2i}
            onCheckedChange={(checked) => onChange({ t2i: checked })}
            className="size-4"
          />
          可生成图片
        </Label>
      </div>
      <Field label="输入单价">
        <Input
          type="number"
          step="any"
          min={0}
          value={draft.cIn}
          onChange={(e) => onChange({ cIn: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <Field label="输出单价">
        <Input
          type="number"
          step="any"
          min={0}
          value={draft.cOut}
          onChange={(e) => onChange({ cOut: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <Field label="缓存读">
        <Input
          type="number"
          step="any"
          min={0}
          value={draft.cRead}
          onChange={(e) => onChange({ cRead: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <Field label="缓存写">
        <Input
          type="number"
          step="any"
          min={0}
          value={draft.cWrite}
          onChange={(e) => onChange({ cWrite: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
    </div>
    {showThinking &&
      (thinkingAuto && !thinkingOverride ? (
        <div className="flex items-center gap-2 border-t pt-2.5 text-sm">
          <span className="text-muted-foreground shrink-0">思考档位</span>
          <Badge variant="outline" className="shrink-0">
            自动（目录）
          </Badge>
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={thinkingAutoSummary}
          >
            {thinkingAutoSummary}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 shrink-0 text-sm"
            onClick={onRequestThinkingOverride}
          >
            手动覆盖
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t pt-2.5">
          {thinkingAuto && (
            <div className="flex items-center gap-2 text-sm">
              <span className="min-w-0 truncate text-muted-foreground">
                基于目录值编辑；改动将作为该模型的覆盖保存
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7 shrink-0 text-sm"
                onClick={onRestoreAutoThinking}
              >
                恢复自动
              </Button>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm">
            <span
              className="text-muted-foreground shrink-0 cursor-help"
              title="关闭思考时显式下发的参数值。默认开思考的网关必须填它才关得掉（OpenAI 兼容常见值：none）；留空 = 不发关闭参数。"
            >
              关闭时下发
            </span>
            <Input
              value={draft.tOff}
              onChange={(e) => onChange({ tOff: e.target.value })}
              placeholder="如 none，留空不发送"
              className="h-8 w-full max-w-48 text-[13px]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
            <span className="text-muted-foreground shrink-0">可用档位</span>
            {THINK_LEVELS.map((t) => (
              <Label key={t.level} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={draft[t.field]}
                  onCheckedChange={(checked) =>
                    onChange({ [t.field]: checked } as Partial<AttrDraft>)
                  }
                  className="size-4"
                />
                {t.label}
              </Label>
            ))}
          </div>
        </div>
      ))}
    <div className="flex justify-end gap-1.5">
      <Button size="sm" variant="ghost" className="h-8 text-sm" onClick={onCancel}>
        取消
      </Button>
      <Button size="sm" className="h-8 text-sm" disabled={busy} onClick={onConfirm}>
        确定
      </Button>
    </div>
  </div>
);

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
        "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
        checked ? "left-[1.15rem]" : "left-0.5",
      )}
    />
  </button>
);

/** 模型属性编辑表单的草稿（字符串态，提交时解析）；t* 字段是思考参数映射编辑 */
type AttrDraft = {
  name: string;
  ctx: string;
  max: string;
  text: boolean;
  image: boolean;
  reasoning: boolean;
  /** 可生成图片标记（存 imagegen 配置覆盖层，非 models 表列）：文生图下拉过滤依据 */
  t2i: boolean;
  tOff: string;
  tMin: boolean;
  tLow: boolean;
  tMed: boolean;
  tHigh: boolean;
  tXhigh: boolean;
  tMax: boolean;
  cIn: string;
  cOut: string;
  cRead: string;
  cWrite: string;
};

/** 档位复选框的渲染表：level = thinkingLevelMap 键（勾选时透传同名下发值） */
const THINK_LEVELS: {
  level: string;
  field: "tMin" | "tLow" | "tMed" | "tHigh" | "tXhigh" | "tMax";
  label: string;
}[] = [
  { level: "minimal", field: "tMin", label: "最小" },
  { level: "low", field: "tLow", label: "轻度" },
  { level: "medium", field: "tMed", label: "中" },
  { level: "high", field: "tHigh", label: "高" },
  { level: "xhigh", field: "tXhigh", label: "很高" },
  { level: "max", field: "tMax", label: "最高" },
];

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

/** 目录生效档位的一句话摘要（属性弹窗"自动（目录）"折叠态展示） */
function thinkingLevelsSummary(
  info: PiModelSummary | undefined,
  draftReasoning: boolean,
): string {
  const supported = info?.supportedThinkingLevels ?? [];
  const labels = THINK_LEVELS.filter((t) => supported.includes(t.level)).map(
    (t) => t.label,
  );
  const off =
    typeof info?.thinkingLevelMap?.off === "string"
      ? info.thinkingLevelMap.off
      : "";
  if (labels.length) {
    return off ? `${labels.join(" / ")}；关闭时下发 ${off}` : labels.join(" / ");
  }
  // 自定义端点模型的目录缺省 reasoning=false：档位空是"没勾支持"，不是"模型不支持"
  if (draftReasoning && info && !info.reasoning)
    return "保存后支持思考，档位将按目录重新推导";
  if (info && !info.reasoning) return "未标记支持深度思考（先在上方勾选）";
  return "无思考档位";
}

/** 模型配置页：默认模型 / AI 服务（自定义提供商）/ 厂商账户（凭据）/ 模型目录 */
export const ModelSettings: FC = () => {
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

  // 添加/编辑 AI 服务弹窗：svcProvider = ""（未选择）/ "custom"（自定义端点）/ 内置 providerId
  const [svcOpen, setSvcOpen] = useState(false);
  const [svcProvider, setSvcProvider] = useState("");
  const [svcProvOpen, setSvcProvOpen] = useState(false);
  const [svcProvSearch, setSvcProvSearch] = useState("");
  /** null = 新增；其他 = 正在编辑的自定义提供商 providerId */
  const [svcEditing, setSvcEditing] = useState<string | null>(null);
  const [svcName, setSvcName] = useState("");
  const [svcBaseUrl, setSvcBaseUrl] = useState("");
  const [svcApiKey, setSvcApiKey] = useState("");
  const [svcApi, setSvcApi] = useState<PiCustomApiKind>("openai-chat");
  // 双栏模型面板：左侧可用模型（自定义端点为远端拉取，内置厂商为目录过滤），右侧已勾选
  const [svcAvail, setSvcAvail] = useState<string[]>([]);
  const [svcSelected, setSvcSelected] = useState<string[]>([]);
  const [svcFetchState, setSvcFetchState] = useState<
    "idle" | "fetching" | "done" | "error"
  >("idle");
  const [svcFetchError, setSvcFetchError] = useState<string | null>(null);
  const [svcModelSearch, setSvcModelSearch] = useState("");
  const [svcCustomInput, setSvcCustomInput] = useState("");
  // 测试连接（custom 模式）：用表单当前值 + 首个已选模型发一条最小请求
  const [svcTestState, setSvcTestState] = useState<
    "idle" | "testing" | "ok" | "error"
  >("idle");
  const [svcTestError, setSvcTestError] = useState<string | null>(null);
  // 列表行快速测试：成功后短暂显示 ✓ 的 providerId
  const [testOkId, setTestOkId] = useState<string | null>(null);
  const svcFetchSeq = useRef(0);
  // 模型属性编辑：custom 服务保存时随 add_custom_provider 提交；内置厂商确认即走 update_model
  const [svcModelAttrs, setSvcModelAttrs] = useState<Record<string, PiCustomModelSpec>>({});
  const [attrEditId, setAttrEditId] = useState<string | null>(null);
  const [attrDraft, setAttrDraft] = useState<AttrDraft | null>(null);
  /** 与 attrEditId 同步的 ref：种子查找异步返回时核对弹窗还开着同一模型 */
  const attrEditIdRef = useRef<string | null>(null);
  // 本次打开属性弹窗内，用户是否点了"手动覆盖"把自动折叠态展开
  const [thinkingOverrideEdit, setThinkingOverrideEdit] = useState(false);
  const selected = useSelectedModel();
  const defaultThinking = useThinkingLevel();

  // 文生图区块：整包配置在 sidecar kv（pi.imagegen），模型候选复用本页目录
  const imagegen = useImageGenConfig();
  // 只列已勾选「可生成图片」标记且已配好凭据、启用的模型（文生图能力存 imagegen
  // 配置覆盖层，标记入口在本页模型属性弹窗）；当前选择若已不在清单（删除/取消标记），
  // 合成一项保住回显
  const imageModelOptions = (models ?? [])
    .filter((m) => m.authed && m.enabled && m.t2i)
    .map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: `${m.providerName} · ${m.name || m.id}`,
    }));
  {
    const cur =
      imagegen.provider && imagegen.modelId
        ? `${imagegen.provider}/${imagegen.modelId}`
        : "";
    if (cur && !imageModelOptions.some((o) => o.value === cur)) {
      imageModelOptions.unshift({ value: cur, label: `${cur}（当前）` });
    }
  }

  const load = useCallback(() => {
    if (!isTauri()) return;
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
          new Date().toLocaleTimeString("zh-CN", { hour12: false }),
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
    }) => {
      setBusy(true);
      setError(null);
      try {
        await piRequest({
          type: "add_custom_provider",
          // 业务 id 走 providerId 字段（协议层 reqId 占用 "id"），有值 = 编辑更新
          ...(input.providerId ? { providerId: input.providerId } : {}),
          name: input.name,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          api: input.api,
          models: input.models,
        });
        load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
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
    setSvcProvider("");
    setSvcProvOpen(false);
    setSvcProvSearch("");
    setSvcName("");
    setSvcBaseUrl("");
    setSvcApiKey("");
    setSvcApi("openai-chat");
    setSvcAvail([]);
    setSvcSelected([]);
    setSvcFetchState("idle");
    setSvcFetchError(null);
    setSvcModelSearch("");
    setSvcCustomInput("");
    setSvcTestState("idle");
    setSvcTestError(null);
    setSvcModelAttrs({});
    setAttrEditId(null);
    setAttrDraft(null);
  }, []);

  /** 打开"添加 AI 服务"弹窗（新增） */
  const openNewService = useCallback(() => {
    setSvcProvider("");
    setSvcEditing(null);
    setSvcProvSearch("");
    setSvcName("");
    setSvcBaseUrl("");
    setSvcApiKey("");
    setSvcApi("openai-chat");
    setSvcAvail([]);
    setSvcSelected([]);
    setSvcFetchState("idle");
    setSvcFetchError(null);
    setSvcModelSearch("");
    setSvcCustomInput("");
    setSvcTestState("idle");
    setSvcTestError(null);
    setSvcModelAttrs({});
    setAttrEditId(null);
    setAttrDraft(null);
    setSvcOpen(true);
  }, []);

  /** 打开"编辑 AI 服务"弹窗（仅自定义端点支持编辑），回填模型属性；
   * Key 不回填（sidecar 只回掩码），输入框留空保存 = 保持原 Key */
  const openEditService = useCallback((cp: PiCustomProviderSummary) => {
    const ids = cp.models.map((m) => m.id);
    const attrs: Record<string, PiCustomModelSpec> = {};
    for (const m of cp.models) {
      attrs[m.id] = {
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: m.input,
        cost: m.cost,
      };
    }
    setSvcProvider("custom");
    setSvcEditing(cp.providerId);
    setSvcProvSearch("");
    setSvcName(cp.name);
    setSvcBaseUrl(cp.baseUrl);
    // 不回填已存 Key（sidecar 只回掩码）：留空保存 = 保持原 Key
    setSvcApiKey("");
    setSvcApi(cp.api);
    setSvcAvail(ids);
    setSvcSelected(ids);
    setSvcFetchState("idle");
    setSvcFetchError(null);
    setSvcModelSearch("");
    setSvcCustomInput("");
    setSvcTestState("idle");
    setSvcTestError(null);
    setSvcModelAttrs(attrs);
    setAttrEditId(null);
    setAttrDraft(null);
    setSvcOpen(true);
  }, []);

  /** 拉取端点的模型列表（fill 左栏）；按接口格式调对应协议 */
  const fetchServiceModels = useCallback(async () => {
    if (svcProvider !== "custom") return;
    const baseUrl = svcBaseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(baseUrl)) return;
    const seq = ++svcFetchSeq.current;
    setSvcFetchState("fetching");
    setSvcFetchError(null);
    try {
      const res = await piRequest<{ type: "fetched_models"; models: string[] }>({
        type: "fetch_models",
        baseUrl,
        apiKey: svcApiKey.trim(),
        // 编辑态且留空：sidecar 按 providerId 取已存凭据兜底
        ...(svcEditing ? { providerId: svcEditing } : {}),
        api: svcApi,
      });
      if (seq !== svcFetchSeq.current) return;
      setSvcAvail(res.models);
      setSvcFetchState("done");
    } catch (err) {
      if (seq !== svcFetchSeq.current) return;
      setSvcFetchState("error");
      setSvcFetchError(err instanceof Error ? err.message : String(err));
    }
  }, [svcProvider, svcBaseUrl, svcApiKey, svcEditing, svcApi]);

  // 填好接口地址后自动拉取模型列表（防抖）
  useEffect(() => {
    if (!svcOpen || svcProvider !== "custom") return;
    if (!/^https?:\/\//.test(svcBaseUrl.trim())) {
      setSvcFetchState("idle");
      setSvcFetchError(null);
      return;
    }
    const timer = setTimeout(() => void fetchServiceModels(), 600);
    return () => clearTimeout(timer);
  }, [svcOpen, svcProvider, svcBaseUrl, svcApiKey, svcApi, fetchServiceModels]);

  const toggleModel = useCallback((id: string) => {
    setSvcSelected((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  }, []);

  /** 测试连接：按接口格式对端点发一条最小请求（用表单当前值 + 首个已选模型） */
  const testService = useCallback(async () => {
    if (svcProvider !== "custom") return;
    const baseUrl = svcBaseUrl.trim().replace(/\/+$/, "");
    const model = svcSelected[0];
    if (!/^https?:\/\//.test(baseUrl) || !model) return;
    setSvcTestState("testing");
    setSvcTestError(null);
    try {
      await piRequest({
        type: "test_provider",
        baseUrl,
        apiKey: svcApiKey.trim(),
        // 编辑态且留空：sidecar 按 providerId 取已存凭据兜底（明文 key 不出渲染进程）
        ...(svcEditing ? { providerId: svcEditing } : {}),
        api: svcApi,
        model,
      });
      setSvcTestState("ok");
    } catch (err) {
      setSvcTestState("error");
      setSvcTestError(err instanceof Error ? err.message : String(err));
    }
  }, [svcProvider, svcBaseUrl, svcApiKey, svcEditing, svcApi, svcSelected]);

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
        await piRequest({
          type: "test_provider",
          baseUrl: cp.baseUrl,
          // 不回传明文：providerId 让 sidecar 端取已存凭据
          apiKey: "",
          providerId: cp.providerId,
          api: cp.api,
          model,
        });
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

  const addCustomModel = useCallback(() => {
    const id = svcCustomInput.trim();
    if (!id) return;
    setSvcSelected((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSvcAvail((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSvcCustomInput("");
  }, [svcCustomInput]);

  /** 属性编辑的当前值来源：custom 优先表单草稿（本次编辑会话内），没有草稿回退
   *  目录摘要（已含 sidecar 种子与用户历史值）；内置厂商直接用目录 */
  const resolveAttrSource = useCallback(
    (id: string): Partial<PiCustomModelSpec> => {
      if (svcProvider === "custom") {
        const draft = svcModelAttrs[id];
        if (draft) return draft;
        const m = (models ?? []).find(
          (x) => x.provider === (svcEditing ?? "") && x.id === id,
        );
        return m
          ? {
              name: m.name,
              reasoning: m.reasoning,
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens,
              input: m.input,
              cost: m.cost,
            }
          : {};
      }
      const m = (models ?? []).find(
        (x) => x.provider === svcProvider && x.id === id,
      );
      return m
        ? {
            name: m.name,
            reasoning: m.reasoning,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            input: m.input,
            cost: m.cost,
          }
        : {};
    },
    [svcProvider, svcEditing, svcModelAttrs, models],
  );

  /** 思考映射归属的 provider id：custom 服务只有"编辑已有服务"时才确定 */
  const thinkingProvider =
    svcProvider === "custom" ? (svcEditing ?? "") : (svcProvider ?? "");

  /** 打开模型属性编辑（右侧"模型设置"行的铅笔按钮） */
  const openAttrEditor = useCallback(
    (id: string) => {
      const src = resolveAttrSource(id);
      const tKey = svcProvider === "custom" ? (svcEditing ?? "") : (svcProvider ?? "");
      const tSeed = thinkingSeed(
        tKey
          ? (models ?? []).find((x) => x.provider === tKey && x.id === id)
          : undefined,
      );
      setThinkingOverrideEdit(false);
      setAttrEditId(id);
      attrEditIdRef.current = id;
      setAttrDraft({
        name: src.name ?? id,
        ctx: src.contextWindow != null ? String(src.contextWindow) : "",
        max: src.maxTokens != null ? String(src.maxTokens) : "",
        text: (src.input ?? ["text"]).includes("text"),
        image: (src.input ?? []).includes("image"),
        reasoning: src.reasoning ?? false,
        // 生图标记现值：provider 明确时从 list_models 行取（新服务的模型无归属，false）
        t2i: tKey
          ? ((models ?? []).find((x) => x.provider === tKey && x.id === id)?.t2i ??
            false)
          : false,
        tOff: tSeed.off,
        tMin: tSeed.enabled("minimal"),
        tLow: tSeed.enabled("low"),
        tMed: tSeed.enabled("medium"),
        tHigh: tSeed.enabled("high"),
        tXhigh: tSeed.enabled("xhigh"),
        tMax: tSeed.enabled("max"),
        cIn: String(src.cost?.input ?? 0),
        cOut: String(src.cost?.output ?? 0),
        cRead: String(src.cost?.cacheRead ?? 0),
        cWrite: String(src.cost?.cacheWrite ?? 0),
      });
      // 目录里查不到该模型（自定义端点新模型/目录外新增）：按 modelId 反查内置
      // 目录拿种子异步补进草稿——同名官方模型直接继承 reasoning/关闭下发值
      //（如 off:"none"）与 contextWindow/maxTokens/input/cost 目录真值，
      // 避免弹窗默认假值覆盖种子；用户已改过的字段不覆盖
      if (src.reasoning === undefined) {
        void piRequest<{ type: "thinking_seed"; seed: PiThinkingSeed | null }>({
          type: "lookup_thinking_seed",
          modelId: id,
        })
          .then((res) => {
            const seed = res.seed;
            if (!seed || attrEditIdRef.current !== id) return;
            setAttrDraft((prev) => {
              if (!prev) return prev;
              const off =
                typeof seed.thinkingLevelMap?.off === "string"
                  ? seed.thinkingLevelMap.off
                  : "";
              // 单价初值是 "0"，仅在仍是初值时补目录真值
              const costNum = (cur: string, val: number): string =>
                cur.trim() === "" || cur.trim() === "0" ? String(val) : cur;
              return {
                ...prev,
                reasoning: prev.reasoning || seed.reasoning,
                ctx: prev.ctx || String(seed.contextWindow),
                max: prev.max || String(seed.maxTokens),
                text: prev.text || seed.input.includes("text"),
                image: prev.image || seed.input.includes("image"),
                tOff: prev.tOff || off,
                tMin: seed.supportedThinkingLevels.includes("minimal"),
                tLow: seed.supportedThinkingLevels.includes("low"),
                tMed: seed.supportedThinkingLevels.includes("medium"),
                tHigh: seed.supportedThinkingLevels.includes("high"),
                tXhigh: seed.supportedThinkingLevels.includes("xhigh"),
                tMax: seed.supportedThinkingLevels.includes("max"),
                cIn: costNum(prev.cIn, seed.cost.input),
                cOut: costNum(prev.cOut, seed.cost.output),
                cRead: costNum(prev.cRead, seed.cost.cacheRead),
                cWrite: costNum(prev.cWrite, seed.cost.cacheWrite),
              };
            });
          })
          .catch(() => {});
      }
    },
    [resolveAttrSource, svcProvider, svcEditing, models],
  );

  const cancelAttrEditor = useCallback(() => {
    setAttrEditId(null);
    attrEditIdRef.current = null;
    setAttrDraft(null);
  }, []);

  /** 确认属性编辑：custom 存进表单草稿随保存提交；内置厂商 diff 后立即 update_model */
  const confirmAttrEditor = useCallback(async () => {
    if (!attrEditId || !attrDraft) return;
    const num = (v: string): number | undefined => {
      const n = Number(v);
      return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
    };
    const parsed: PiCustomModelSpec = {
      id: attrEditId,
      name: attrDraft.name.trim() || undefined,
      reasoning: attrDraft.reasoning,
      contextWindow: num(attrDraft.ctx),
      maxTokens: num(attrDraft.max),
      input: [attrDraft.text && "text", attrDraft.image && "image"].filter(
        (s): s is string => !!s,
      ),
      cost: {
        input: num(attrDraft.cIn) ?? 0,
        output: num(attrDraft.cOut) ?? 0,
        cacheRead: num(attrDraft.cRead) ?? 0,
        cacheWrite: num(attrDraft.cWrite) ?? 0,
      },
    };
    if (svcProvider === "custom") {
      setSvcModelAttrs((prev) => ({ ...prev, [attrEditId]: parsed }));
    } else if (svcProvider) {
      // 内置厂商：只提交与目录当前值不同的字段，避免把继承值固化成覆盖
      const src = resolveAttrSource(attrEditId);
      const patch: Record<string, unknown> = {
        type: "update_model",
        provider: svcProvider,
        modelId: attrEditId,
      };
      if (parsed.name !== src.name) patch.name = parsed.name ?? null;
      if (parsed.reasoning !== src.reasoning) patch.reasoning = parsed.reasoning;
      if (parsed.contextWindow !== src.contextWindow)
        patch.contextWindow = parsed.contextWindow ?? null;
      if (parsed.maxTokens !== src.maxTokens)
        patch.maxTokens = parsed.maxTokens ?? null;
      if (JSON.stringify(parsed.input) !== JSON.stringify(src.input ?? ["text"]))
        patch.input = parsed.input;
      if (JSON.stringify(parsed.cost) !== JSON.stringify(src.cost))
        patch.cost = parsed.cost;
      if (Object.keys(patch).length > 3) {
        setBusy(true);
        try {
          await piRequest(patch);
          load();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }
    }
    // 生图标记：imagegen 配置覆盖层（与思考映射同路数），provider 明确才提交
    if (thinkingProvider) {
      const t2iCur =
        (models ?? []).find((x) => x.provider === thinkingProvider && x.id === attrEditId)
          ?.t2i ?? false;
      if (attrDraft.t2i !== t2iCur) {
        void setModelImageCapable(thinkingProvider, attrEditId, attrDraft.t2i)
          .then(() => {
            void load();
            refreshPiModels();
          })
          .catch((err) =>
            setError(err instanceof Error ? err.message : String(err)),
          );
      }
    }
    // 思考映射：种子取目录生效值，只把改动的键推给 setModelThinkingMap
    if (thinkingProvider) {
      const tInfo = (models ?? []).find(
        (x) => x.provider === thinkingProvider && x.id === attrEditId,
      );
      const tSeed = thinkingSeed(tInfo);
      const patch: ModelThinkingMap = {};
      for (const t of THINK_LEVELS) {
        if (attrDraft[t.field] !== tSeed.enabled(t.level)) {
          patch[t.level] = attrDraft[t.field] ? t.level : null;
        }
      }
      const offNow = attrDraft.tOff.trim();
      if (offNow !== tSeed.off) patch.off = offNow || null;
      if (Object.keys(patch).length) {
        void setModelThinkingMap(thinkingProvider, attrEditId, patch).then(() =>
          refreshPiModels(),
        );
      } else if (getModelThinkingMap(thinkingProvider, attrEditId)) {
        // 与目录种子无差异但存有覆盖 → 清除覆盖（恢复自动）
        void setModelThinkingMap(thinkingProvider, attrEditId, null).then(() =>
          refreshPiModels(),
        );
      }
    }
    setAttrEditId(null);
    attrEditIdRef.current = null;
    setAttrDraft(null);
  }, [
    attrEditId,
    attrDraft,
    svcProvider,
    thinkingProvider,
    models,
    resolveAttrSource,
    load,
  ]);

  /** 属性弹窗思考区的目录信息（provider+id 定位）；未知模型 = undefined */
  const thinkingEditInfo =
    thinkingProvider && attrEditId
      ? (models ?? []).find(
          (x) => x.provider === thinkingProvider && x.id === attrEditId,
        )
      : undefined;
  /** 目录覆盖了档位且没有前端覆盖值 → 默认折叠为"自动"，编辑只留给需要配的对象 */
  const thinkingEditAuto = !!(
    thinkingProvider &&
    attrEditId &&
    thinkingEditInfo?.supportedThinkingLevels &&
    !getModelThinkingMap(thinkingProvider, attrEditId)
  );
  /** 恢复自动：档位草稿复位到目录种子；确认时 diff 为空会走清除覆盖分支 */
  const restoreAutoThinking = useCallback(() => {
    const seed = thinkingSeed(thinkingEditInfo);
    setAttrDraft((prev) =>
      prev
        ? {
            ...prev,
            tOff: seed.off,
            tMin: seed.enabled("minimal"),
            tLow: seed.enabled("low"),
            tMed: seed.enabled("medium"),
            tHigh: seed.enabled("high"),
            tXhigh: seed.enabled("xhigh"),
            tMax: seed.enabled("max"),
          }
        : prev,
    );
  }, [thinkingEditInfo]);

  /** 内置厂商：当前所选服务的目录模型（弹窗双栏面板用） */
  const svcBuiltinCatalog = useMemo(() => {
    if (!svcProvider || svcProvider === "custom") return [];
    return (models ?? []).filter((m) => m.provider === svcProvider);
  }, [models, svcProvider]);

  const svcBuiltinFiltered = useMemo(() => {
    const q = svcModelSearch.trim().toLowerCase();
    return q
      ? svcBuiltinCatalog.filter(
          (m) =>
            m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
        )
      : svcBuiltinCatalog;
  }, [svcBuiltinCatalog, svcModelSearch]);

  /** 选择服务：custom 清空勾选；内置厂商预填已保存的模型过滤（无过滤 = 目录全选） */
  const pickProvider = useCallback(
    async (id: string) => {
      setSvcProvider(id);
      setSvcProvOpen(false);
      setSvcProvSearch("");
      if (id === "custom") {
        setSvcSelected([]);
        return;
      }
      try {
        const res = await piRequest<{
          type: "provider_filter";
          provider: string;
          models: string[] | null;
        }>({ type: "get_provider_filter", provider: id });
        const catalog = (models ?? [])
          .filter((m) => m.provider === id)
          .map((m) => m.id);
        setSvcSelected(
          res.models ? res.models.filter((x) => catalog.includes(x)) : catalog,
        );
      } catch {
        setSvcSelected([]);
      }
    },
    [models],
  );

  /** 提交服务弹窗：自定义端点走 add_custom_provider，内置厂商走凭据 + 模型过滤 */
  const submitService = useCallback(async () => {
    if (busy || !svcProvider) return;
    setError(null);
    if (svcProvider === "custom") {
      if (!svcName.trim() || !svcBaseUrl.trim() || !svcSelected.length) return;
      try {
        await saveCustomProvider({
          providerId: svcEditing || undefined,
          name: svcName.trim(),
          baseUrl: svcBaseUrl.trim(),
          apiKey: svcApiKey.trim(),
          api: svcApi,
          models: svcSelected.map((id) => ({ ...(svcModelAttrs[id] ?? {}), id })),
        });
        closeServiceDialog();
      } catch {
        // saveCustomProvider 内已 setError
      }
    } else {
      // 内置厂商：保存凭据（已有凭据时密钥可留空）+ 模型过滤（勾选集写 pi_models 行）
      const credExists = credentials.some((c) => c.providerId === svcProvider);
      if (!svcApiKey.trim() && !credExists) return;
      setBusy(true);
      try {
        if (svcApiKey.trim()) {
          await piRequest({
            type: "set_credential",
            provider: svcProvider,
            apiKey: svcApiKey.trim(),
          });
        }
        await piRequest({
          type: "set_provider_filter",
          provider: svcProvider,
          models: svcSelected,
        });
        closeServiceDialog();
        load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }
  }, [
    busy,
    svcProvider,
    svcName,
    svcBaseUrl,
    svcApiKey,
    svcApi,
    svcSelected,
    svcEditing,
    svcModelAttrs,
    credentials,
    saveCustomProvider,
    closeServiceDialog,
    load,
  ]);

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

  const svcProvOptions = useMemo(() => {
    // 已添加的自定义服务不在"添加"列表里出现（catalog 会把它们注册成 provider），
    // 它们走服务列表里的编辑按钮；否则选中后会被当成内置厂商处理
    const customIds = new Set(customProviders.map((cp) => cp.providerId));
    const all = [
      { id: "custom", name: "自定义端点" },
      ...providers
        .filter((p) => !customIds.has(p.id))
        .map((p) => ({ id: p.id, name: p.name })),
    ];
    const q = svcProvSearch.trim().toLowerCase();
    return q
      ? all.filter(
          (o) =>
            o.name.toLowerCase().includes(q) ||
            o.id.toLowerCase().includes(q),
        )
      : all;
  }, [providers, customProviders, svcProvSearch]);

  const svcAvailFiltered = useMemo(() => {
    const q = svcModelSearch.trim().toLowerCase();
    return q
      ? svcAvail.filter((id) => id.toLowerCase().includes(q))
      : svcAvail;
  }, [svcAvail, svcModelSearch]);

  /** 服务弹窗左栏当前可见的模型 ID（跟随搜索过滤），供全选/取消全选 */
  const svcVisibleIds = useMemo(
    () =>
      svcProvider !== "custom"
        ? svcBuiltinFiltered.map((m) => m.id)
        : svcAvailFiltered,
    [svcProvider, svcBuiltinFiltered, svcAvailFiltered],
  );
  const svcAllVisibleSelected =
    svcVisibleIds.length > 0 && svcVisibleIds.every((id) => svcSelected.includes(id));

  const toggleSelectAllVisible = useCallback(() => {
    setSvcSelected((prev) => {
      const allSelected = svcVisibleIds.every((id) => prev.includes(id));
      return allSelected
        ? prev.filter((id) => !svcVisibleIds.includes(id))
        : [...prev, ...svcVisibleIds.filter((id) => !prev.includes(id))];
    });
  }, [svcVisibleIds]);

  /** 已配置的内置厂商（有凭据且非自定义服务）：在 AI 服务列表中统一展示管理 */
  const builtinServices = useMemo(() => {
    const customIds = new Set(customProviders.map((cp) => cp.providerId));
    return credentials
      .filter((c) => !customIds.has(c.providerId))
      .map((c) => {
        const p = providers.find((x) => x.id === c.providerId);
        return {
          providerId: c.providerId,
          name: p?.name ?? c.providerId,
          modelCount: (models ?? []).filter(
            (m) => m.provider === c.providerId && m.enabled !== false,
          ).length,
        };
      });
  }, [credentials, customProviders, providers, models]);

  /** AI 服务列表点"编辑"（内置厂商）：重置表单 → 选中该厂商并预填模型过滤 → 打开弹窗 */
  const openBuiltinService = useCallback(
    (id: string) => {
      openNewService();
      setSvcEditing(id); // 编辑态：禁用服务切换，弹窗标题显示"编辑 AI 服务"
      void pickProvider(id);
    },
    [openNewService, pickProvider],
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

  // web 预览没有 Tauri 后端（pi sidecar / invoke），直接给出降级提示
  if (!isTauri()) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        模型配置依赖桌面端 pi 服务，请在 Tauri 应用中打开设置。
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="text-destructive text-sm">{error}</div>
        <Button variant="outline" size="sm" className="mt-3" onClick={load}>
          重试
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
      : "还没有可用的 AI 服务";

  const svcProviderLabel =
    svcProvider === "custom"
      ? "自定义端点"
      : (providers.find((p) => p.id === svcProvider)?.name ?? svcProvider);

  const svcSaveDisabled =
    busy ||
    !svcProvider ||
    (svcProvider === "custom"
      ? !svcName.trim() || !svcBaseUrl.trim() || svcSelected.length === 0
      : !svcApiKey.trim() &&
        !credentials.some((c) => c.providerId === svcProvider));

  /** 服务选择下拉：自定义端点独占一行；内置厂商与密钥同排 */
  const svcSelectorField = (
    <Field label="服务">
      <Popover open={svcProvOpen} onOpenChange={setSvcProvOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              disabled={svcEditing !== null}
              className="bg-muted/60 focus-visible:bg-background focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-transparent px-3 text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-1 disabled:opacity-50"
            >
              {svcProvider ? (
                svcProviderLabel
              ) : (
                <span className="text-muted-foreground">选择服务</span>
              )}
              <ChevronDownIcon className="size-4 opacity-50" />
            </button>
          }
        />
        <PopoverContent align="start" className="w-[24rem] p-0">
          <div className="relative p-2 pb-0">
            <SearchIcon className="text-muted-foreground absolute start-5 top-1/2 size-4 -translate-y-1/2" />
            <Input
              value={svcProvSearch}
              onChange={(e) => setSvcProvSearch(e.target.value)}
              placeholder="筛选服务"
              className="h-9 ps-8"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-2">
            {svcProvOptions.map((opt) => {
              const isSel = svcProvider === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  data-selected={isSel}
                  onClick={() => void pickProvider(opt.id)}
                  className={cn(
                    "hover:bg-muted flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-sm",
                    "data-selected:bg-muted",
                  )}
                >
                  <span className="w-4 shrink-0">
                    {isSel && <CheckIcon className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-start">
                    {opt.name}
                  </span>
                  {/* {opt.id !== "custom" &&
                    configured.has(opt.id) && (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-primary"
                        title="已配置 Key"
                      />
                    )} */}
                </button>
              );
            })}
            {svcProvOptions.length === 0 && (
              <div className="text-muted-foreground py-8 text-center text-sm">
                没有匹配的服务
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <h1 className="text-2xl font-bold tracking-tight">模型配置</h1>

        {/* 默认项 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">默认项</h2>
          <div className="bg-muted/50 flex items-center gap-4 rounded-2xl px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">默认模型</div>
              <div className="text-muted-foreground truncate text-sm">
                {selectedText}
              </div>
            </div>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger
                render={
                  <Button variant="ghost" className="text-muted-foreground h-8">
                    更改
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
                    placeholder="搜索模型"
                    className="h-9 ps-8"
                  />
                </div>
                <div className="max-h-80 overflow-y-auto p-2">
                  {groups.map(([providerName, items]) => (
                    <div key={providerName} className="pb-2">
                      <div className="text-muted-foreground px-2.5 pb-1 text-xs font-medium">
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
                              <span className="min-w-0 flex-1 truncate text-start">
                                {m.name || m.id}
                              </span>
                              {m.reasoning && (
                                <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[11px]">
                                  推理
                                </span>
                              )}
                              <span className="text-muted-foreground w-12 shrink-0 text-end text-xs tabular-nums">
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
                      没有匹配的模型
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className="bg-muted/50 flex items-center gap-4 rounded-2xl px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">默认档位</div>
              <div className="text-muted-foreground truncate text-sm">
                新对话与从未在对话页选过档位的会话的深度思考档位；
                对话页改档位只影响该会话，不会改这里
              </div>
            </div>
            <Select
              value={defaultThinking}
              items={Object.entries(THINKING_LEVEL_LABELS).map(
                ([value, label]) => ({ value, label }),
              )}
              onValueChange={(v) => void setThinkingLevel(v as ThinkingLevel)}
            >
              <SelectTrigger size="sm" className="w-40 border bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(THINKING_LEVEL_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>

        {/* 文生图：generate_image 工具的开关/默认模型/尺寸（云端 API，配置存 sidecar kv） */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">文生图</h2>
          <p className="text-muted-foreground text-sm">
            智能体按对话需要调用 generate_image 生成图片（文生图/图生图），图片直接展示在对话中，
            并存到工作区 .kova/imagegen 下——把保存的路径交给智能体即可继续改图。
            按张计费，默认关闭；生图模型需先在下方「模型服务」添加（OpenAI 兼容端点），
            并在其模型属性里勾选「可生成图片」。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="启用文生图"
              desc="关闭时智能体遇到画图请求会婉拒并提示到这里开启。"
            >
              <Switch
                checked={imagegen.enabled}
                onCheckedChange={(v) =>
                  void saveImageGenConfig({ ...imagegen, enabled: v }).catch(
                    () => toast.error("保存失败，请重试"),
                  )
                }
              />
            </SettingRow>
            <SettingRow
              label="默认文生图模型"
              desc={
                imageModelOptions.length
                  ? "只列在模型属性里勾选了「可生成图片」的模型；密钥沿用其 provider 凭据。"
                  : "暂无可选生图模型：先在下方「AI 服务」为 OpenAI 兼容端点添加生图模型（如 gpt-image-1），再进该模型的属性编辑勾选「可生成图片」。"
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
                  }).catch(() => toast.error("保存失败，请重试"));
                }}
                items={imageModelOptions}
              >
                <SelectTrigger size="sm" className="w-64 border bg-background">
                  <SelectValue placeholder="选择模型" />
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
              label="默认尺寸"
              desc="模型可按单次生成需要覆盖；大图建议模型侧选 jpeg。"
            >
              <Select
                value={imagegen.size}
                onValueChange={(v) => {
                  if (!v) return;
                  void saveImageGenConfig({ ...imagegen, size: v }).catch(
                    () => toast.error("保存失败，请重试"),
                  );
                }}
                items={[
                  { value: "1024x1024", label: "1024×1024 方图" },
                  { value: "1792x1024", label: "1792×1024 横图" },
                  { value: "1024x1792", label: "1024×1792 竖图" },
                  { value: "auto", label: "自动" },
                ]}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1024x1024">1024×1024 方图</SelectItem>
                  <SelectItem value="1792x1024">1792×1024 横图</SelectItem>
                  <SelectItem value="1024x1792">1024×1792 竖图</SelectItem>
                  <SelectItem value="auto">自动</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
          </div>
        </section>

        {/* AI 服务（自定义 OpenAI 兼容提供商 / 内置厂商快捷配置） */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">AI 服务</h2>
            <Button onClick={openNewService}>
              <PlusIcon className="size-4" />
              添加服务
            </Button>
          </div>

          {customProviders.length === 0 && builtinServices.length === 0 ? (
            <div className="bg-muted/50 flex flex-col items-center rounded-2xl py-16">
              <div className="bg-background ring-foreground/10 flex size-11 items-center justify-center rounded-full ring-1">
                <ServerIcon className="text-muted-foreground size-5" />
              </div>
              <div className="mt-3 text-sm font-medium">还没有 AI 服务</div>
              <div className="text-muted-foreground mt-1 text-xs">
                添加 AI 服务即可开始。
              </div>
              <Button className="mt-4" onClick={openNewService}>
                <PlusIcon className="size-4" />
                添加服务
              </Button>
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
                      <span
                        title={cp.enabled ? "已启用" : "已停用"}
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          cp.enabled ? "bg-lime-500" : "bg-muted-foreground/40",
                        )}
                      />
                      <span className="shrink-0 text-sm font-medium">
                        {cp.name}
                      </span>
                      {selected?.provider === cp.providerId && (
                        <span className="rounded bg-lime-500/15 px-1.5 py-0.5 text-[11px] font-medium text-lime-600">
                          默认
                        </span>
                      )}
                      {!cp.enabled && (
                        <span className="text-muted-foreground text-[11px]">
                          已停用
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate text-xs">
                      {cp.baseUrl} · {cp.models.length} 个模型
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title="编辑"
                      disabled={busy}
                      onClick={() => openEditService(cp)}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <PencilIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="测试连接"
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
                      title="删除"
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
                      <span
                        title="已配置凭据"
                        className="size-2 shrink-0 rounded-full bg-lime-500"
                      />
                      <span className="shrink-0 text-sm font-medium">
                        {svc.name}
                      </span>
                      {selected?.provider === svc.providerId && (
                        <span className="rounded bg-lime-500/15 px-1.5 py-0.5 text-[11px] font-medium text-lime-600">
                          默认
                        </span>
                      )}
                      <span className="text-muted-foreground text-[11px]">
                        内置服务
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate text-xs">
                      {svc.modelCount} 个模型
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title="编辑"
                      disabled={busy}
                      onClick={() => openBuiltinService(svc.providerId)}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <PencilIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="删除"
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
              <div className="text-muted-foreground text-sm">
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
                    <span className="text-muted-foreground text-xs">
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
            <div className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              尚未配置任何厂商账户：添加 API Key 后即可在"默认模型"中选择对应模型。
            </div>
          )}
        </section> */}

        {/* 模型目录 */}
        <div className="bg-muted/50 flex items-center justify-between gap-4 rounded-2xl px-5 py-4">
          <span className="text-muted-foreground truncate text-sm">
            目录: 内置快照 · {visibleModelCount} 个模型 · 更新于{" "}
            {lastRefresh ?? "从未获取"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-8 shrink-0"
            disabled={busy}
            onClick={load}
          >
            <RefreshCwIcon className="size-4" />
            更新模型目录
          </Button>
        </div>
      </div>

      {/* 添加/编辑 AI 服务弹窗 */}
      <Dialog
        open={svcOpen}
        onOpenChange={(open) => !open && closeServiceDialog()}
      >
        <DialogContent className="flex h-[80dvh]  flex-col sm:max-w-4xl">
          {/* pe-8：避让右上角 Dialog 自带的关闭 X 按钮 */}
          <div className="flex items-center justify-between gap-4 pe-8">
            <DialogTitle className="text-base font-semibold">
              {svcEditing ? "编辑 AI 服务" : "添加 AI 服务"}
            </DialogTitle>
            <div className="flex items-center gap-2">
              {svcProvider === "custom" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={
                    svcTestState === "testing" ||
                    svcSelected.length === 0 ||
                    !/^https?:\/\//.test(svcBaseUrl.trim())
                  }
                  onClick={() => void testService()}
                >
                  {svcTestState === "testing" ? (
                    <RefreshCwIcon className="size-3.5 animate-spin" />
                  ) : (
                    <PlugIcon className="size-3.5" />
                  )}
                  {svcTestState === "testing" ? "测试中..." : "测试连接"}
                </Button>
              )}
              <Button
                variant="ghost"
                className="text-muted-foreground h-8"
                onClick={closeServiceDialog}
              >
                取消
              </Button>
              <Button
                disabled={svcSaveDisabled}
                onClick={() => void submitService()}
              >
                保存服务
              </Button>
            </div>
          </div>

          {/* 测试连接结果 */}
          {svcProvider === "custom" &&
            (svcTestState === "testing" || svcTestState === "error") && (
              <div
                className={cn(
                  "text-xs",
                  svcTestState === "testing"
                    ? "text-muted-foreground"
                    : "text-destructive break-all",
                )}
              >
                {svcTestState === "testing"
                  ? "正在发送测试请求..."
                  : svcTestError}
              </div>
            )}
          {svcProvider === "custom" && svcTestState === "ok" && (
            <div className="text-xs text-lime-600">连接成功</div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            {svcProvider === "custom" ? (
              <>
                {/* 服务选择（可搜索） */}
                {svcSelectorField}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="名称">
                    <Input
                      value={svcName}
                      onChange={(e) => setSvcName(e.target.value)}
                      placeholder="如：My Proxy"
                      className="h-9"
                    />
                  </Field>
                  <Field label="接口地址">
                    <Input
                      value={svcBaseUrl}
                      onChange={(e) => setSvcBaseUrl(e.target.value)}
                      placeholder={
                        svcApi === "anthropic-messages"
                          ? "https://api.anthropic.com"
                          : "https://api.example.com/v1"
                      }
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-9 font-mono text-xs"
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="API 密钥">
                    <Input
                      type="password"
                      value={svcApiKey}
                      onChange={(e) => setSvcApiKey(e.target.value)}
                      placeholder={
                        svcEditing
                          ? `已保存 ${customProviders.find((c) => c.providerId === svcEditing)?.apiKeyMasked ?? ""}，留空保持不变`
                          : "sk-..."
                      }
                      autoComplete="off"
                      className="h-9"
                    />
                  </Field>
                  <Field label="接口格式">
                    <Select
                      value={svcApi}
                      onValueChange={(v) => v && setSvcApi(v)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {(v: PiCustomApiKind | null) =>
                            API_FORMATS.find((f) => f.value === v)?.label ??
                            "选择接口格式"
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
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
                </div>
              </>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* 服务 + 密钥 同排 */}
                {svcSelectorField}
                <Field label="API 密钥">
                  <Input
                    type="password"
                    value={svcApiKey}
                    onChange={(e) => setSvcApiKey(e.target.value)}
                    placeholder={
                      credentials.some((c) => c.providerId === svcProvider)
                        ? "已保存，留空保持不变"
                        : "sk-..."
                    }
                    autoComplete="off"
                    className="h-9"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitService();
                    }}
                  />
                  <span className="text-muted-foreground text-[11px]">
                    在下方勾选该服务要启用的模型；全部勾选表示不筛选。
                  </span>
                </Field>
              </div>
            )}

            {/* 双栏模型面板：自定义端点为远端列表；内置厂商为目录中该服务的模型 */}
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2 sm:grid-rows-[minmax(0,1fr)]">
              {/* 左栏：该服务的模型 */}
              <div className="bg-muted/50 flex h-full min-h-60 flex-col rounded-2xl p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">该服务的模型</span>
                  {svcProvider === "custom" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-7 px-2 text-xs"
                      disabled={
                        svcFetchState === "fetching" ||
                        !/^https?:\/\//.test(svcBaseUrl.trim())
                      }
                      onClick={() => void fetchServiceModels()}
                    >
                      <RefreshCwIcon
                        className={cn(
                          "size-3.5",
                          svcFetchState === "fetching" && "animate-spin",
                        )}
                      />
                      获取列表
                    </Button>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="relative flex-1">
                    <SearchIcon className="text-muted-foreground absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
                    <Input
                      value={svcModelSearch}
                      onChange={(e) => setSvcModelSearch(e.target.value)}
                      placeholder="搜索模型 ID..."
                      className="h-8 bg-background/60 ps-7 text-xs"
                    />
                  </div>
                  {/* 全选/取消全选：作用于搜索过滤后的可见列表 */}
                  <button
                    type="button"
                    disabled={svcVisibleIds.length === 0}
                    onClick={toggleSelectAllVisible}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs",
                      "hover:bg-muted/60 text-muted-foreground hover:text-foreground",
                      "disabled:pointer-events-none disabled:opacity-50",
                    )}
                  >
                    <ModelBox checked={svcAllVisibleSelected} />
                    {svcAllVisibleSelected ? "取消全选" : "全选"}
                  </button>
                </div>
                <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
                  {svcProvider !== "custom" ? (
                    // 内置厂商：列出该服务的目录模型
                    svcBuiltinFiltered.length === 0 ? (
                      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
                        该服务暂无目录模型
                      </div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {svcBuiltinFiltered.map((m) => {
                          const checked = svcSelected.includes(m.id);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              title={m.id}
                              onClick={() => toggleModel(m.id)}
                              className="hover:bg-muted/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start"
                            >
                              <ModelBox checked={checked} />
                              <span className="min-w-0 flex-1 truncate text-xs">
                                {m.name || m.id}
                              </span>
                              <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                                {fmtContextWindow(m.contextWindow)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )
                  ) : svcFetchState === "fetching" ? (
                    <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
                      正在获取模型列表...
                    </div>
                  ) : svcFetchState === "error" ? (
                    <div className="text-destructive flex h-full flex-col items-center justify-center gap-1.5 px-2 text-center text-xs">
                      <span className="break-all">{svcFetchError}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => void fetchServiceModels()}
                      >
                        重试
                      </Button>
                    </div>
                  ) : /^https?:\/\//.test(svcBaseUrl.trim()) &&
                    svcFetchState === "idle" ? (
                    <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
                      填写接口地址后自动获取模型列表。
                    </div>
                  ) : svcFetchState === "done" && svcAvail.length === 0 ? (
                    <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
                      未获取到模型，可在右侧手动添加。
                    </div>
                  ) : svcAvailFiltered.length === 0 ? (
                    <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
                      没有匹配的模型
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {svcAvailFiltered.map((id) => {
                        const checked = svcSelected.includes(id);
                        return (
                          <button
                            key={id}
                            type="button"
                            title={id}
                            onClick={() => toggleModel(id)}
                            className="hover:bg-muted/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start"
                          >
                            <ModelBox checked={checked} />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs">
                              {id}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* 右栏：模型设置（已选） */}
              <div className="bg-muted/50 flex h-full min-h-60 flex-col rounded-2xl p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">模型设置</span>
                  <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px] tabular-nums">
                    {svcSelected.length}
                  </span>
                </div>
                <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
                  {svcSelected.length === 0 ? (
                    <div className="text-muted-foreground flex h-full items-center justify-center px-2 text-center text-xs">
                      尚未选择模型。请在模型列表中勾选。
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {svcSelected.map((id) => (
                        <div key={id}>
                          <div className="hover:bg-muted/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5">
                            <button
                              type="button"
                              title={id}
                              onClick={() => toggleModel(id)}
                              className="flex min-w-0 flex-1 items-center gap-2 text-start"
                            >
                              <ModelBox checked />
                              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                {id}
                              </span>
                            </button>
                            <button
                              type="button"
                              title="编辑属性"
                              onClick={() => openAttrEditor(id)}
                              className={cn(
                                "shrink-0",
                                attrEditId === id
                                  ? "text-foreground"
                                  : "text-muted-foreground hover:text-foreground",
                              )}
                            >
                              <PencilIcon className="size-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="mt-2 border-t pt-2">
                  <span className="text-muted-foreground text-xs">自定义</span>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Input
                      value={svcCustomInput}
                      onChange={(e) => setSvcCustomInput(e.target.value)}
                      placeholder="输入模型 ID，如 my-model-v2"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-8 bg-background/60 text-xs"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCustomModel();
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 text-xs"
                      disabled={!svcCustomInput.trim()}
                      onClick={addCustomModel}
                    >
                      <PlusIcon className="size-3.5" />
                      添加自定义模型
                    </Button>
                  </div>
                  <p className="text-muted-foreground mt-1.5 text-[11px]">
                    添加目录尚未发布的模型 ID。
                  </p>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 模型属性编辑二级弹窗（替代旧的行内展开）：盖在 AI 服务弹窗之上 */}
      <Dialog
        open={attrEditId !== null && attrDraft !== null}
        onOpenChange={(open) => {
          if (!open) cancelAttrEditor();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-6 text-base font-semibold">
            <span className="shrink-0">模型属性</span>
            {attrEditId && (
              <Badge variant="outline" title={attrEditId} className="max-w-[360px]">
                <span className="min-w-0 truncate">{attrEditId}</span>
              </Badge>
            )}
          </DialogTitle>
          {attrEditId !== null && attrDraft && (
            <AttrEditor
              draft={attrDraft}
              busy={busy}
              showThinking={!!thinkingProvider}
              thinkingAuto={thinkingEditAuto}
              thinkingOverride={thinkingOverrideEdit}
              thinkingAutoSummary={thinkingLevelsSummary(
                thinkingEditInfo,
                attrDraft.reasoning,
              )}
              defaultedAttrs={thinkingEditInfo?.defaultedAttrs ?? []}
              onRequestThinkingOverride={() => setThinkingOverrideEdit(true)}
              onRestoreAutoThinking={restoreAutoThinking}
              onChange={(patch) =>
                setAttrDraft((prev) => (prev ? { ...prev, ...patch } : prev))
              }
              onConfirm={() => void confirmAttrEditor()}
              onCancel={cancelAttrEditor}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
