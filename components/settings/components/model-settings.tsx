"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
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
import { cn } from "@/lib/utils";
import {
  piRequest,
  type PiCredentialSummary,
  type PiCustomApiKind,
  type PiCustomProviderSummary,
  type PiModelSummary,
  type PiProviderSummary,
} from "@/lib/pi-bridge";
import { isTauri } from "@/lib/tauri";
import { setSelectedModel, useSelectedModel } from "@/lib/model-settings";
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

const fmtContextWindow = (n: number): string => {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
};

/** 弹窗表单字段：小标签 + 控件 */
const Field: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <label className="flex flex-col gap-1.5">
    <span className="text-muted-foreground text-xs">{label}</span>
    {children}
  </label>
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
  const selected = useSelectedModel();

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
      models: string[];
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
          models: input.models.map((id) => ({ id })),
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
    setSvcOpen(true);
  }, []);

  /** 打开"编辑 AI 服务"弹窗（仅自定义端点支持编辑），并回填已保存的 Key */
  const openEditService = useCallback((cp: PiCustomProviderSummary) => {
    const ids = cp.models.map((m) => m.id);
    setSvcProvider("custom");
    setSvcEditing(cp.providerId);
    setSvcProvSearch("");
    setSvcName(cp.name);
    setSvcBaseUrl(cp.baseUrl);
    setSvcApiKey(cp.apiKey ?? "");
    setSvcApi(cp.api);
    setSvcAvail(ids);
    setSvcSelected(ids);
    setSvcFetchState("idle");
    setSvcFetchError(null);
    setSvcModelSearch("");
    setSvcCustomInput("");
    setSvcTestState("idle");
    setSvcTestError(null);
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
  }, [svcProvider, svcBaseUrl, svcApiKey, svcApi]);

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
      await piRequest({ type: "test_provider", baseUrl, apiKey: svcApiKey.trim(), api: svcApi, model });
      setSvcTestState("ok");
    } catch (err) {
      setSvcTestState("error");
      setSvcTestError(err instanceof Error ? err.message : String(err));
    }
  }, [svcProvider, svcBaseUrl, svcApiKey, svcApi, svcSelected]);

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
          apiKey: cp.apiKey ?? "",
          api: cp.api,
          model,
        });
        setTestOkId(cp.providerId);
        setTimeout(
          () => setTestOkId((v) => (v === cp.providerId ? null : v)),
          1500,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
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
          models: svcSelected,
        });
        closeServiceDialog();
      } catch {
        // saveCustomProvider 内已 setError
      }
    } else {
      // 内置厂商：保存凭据（已有凭据时密钥可留空）+ 模型过滤（全选 = 清除过滤）
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
        const allIds = svcBuiltinCatalog.map((m) => m.id);
        const isAll =
          allIds.length > 0 && allIds.every((id) => svcSelected.includes(id));
        await piRequest({
          type: "set_provider_filter",
          provider: svcProvider,
          models: isAll ? [] : svcSelected,
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
    credentials,
    svcBuiltinCatalog,
    saveCustomProvider,
    closeServiceDialog,
    load,
  ]);

  const groups = useMemo(() => {
    if (!models) return [];
    const query = search.trim().toLowerCase();
    const filtered = models.filter(
      (m) =>
        !query ||
        m.name.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query) ||
        m.providerName.toLowerCase().includes(query),
    );
    const byProvider = new Map<string, typeof filtered>();
    for (const m of filtered) {
      const bucket = byProvider.get(m.providerName);
      if (bucket) bucket.push(m);
      else byProvider.set(m.providerName, [m]);
    }
    return [...byProvider.entries()];
  }, [models, search]);

  const hasAuthedModel = models?.some((m) => m.authed) ?? false;

  const svcProvOptions = useMemo(() => {
    const all = [
      { id: "custom", name: "自定义端点" },
      ...providers.map((p) => ({ id: p.id, name: p.name })),
    ];
    const q = svcProvSearch.trim().toLowerCase();
    return q
      ? all.filter(
          (o) =>
            o.name.toLowerCase().includes(q) ||
            o.id.toLowerCase().includes(q),
        )
      : all;
  }, [providers, svcProvSearch]);

  const svcAvailFiltered = useMemo(() => {
    const q = svcModelSearch.trim().toLowerCase();
    return q
      ? svcAvail.filter((id) => id.toLowerCase().includes(q))
      : svcAvail;
  }, [svcAvail, svcModelSearch]);

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
                              disabled={!m.authed}
                              title={
                                m.authed ? undefined : "未配置该厂商账户的凭据"
                              }
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
                                !m.authed &&
                                  "text-muted-foreground/60 cursor-not-allowed",
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

          {customProviders.length === 0 ? (
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
            目录: 内置快照 · {models.length} 个模型 · 更新于{" "}
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
        <DialogContent
          showCloseButton={false}
          className="flex h-[80dvh]  flex-col sm:max-w-4xl"
        >
          <div className="flex items-center justify-between gap-4">
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
                      placeholder={svcEditing ? "留空保留原 Key" : "sk-..."}
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
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="openai-chat">
                          OpenAI Chat Completions
                        </SelectItem>
                        <SelectItem value="openai-responses">
                          OpenAI Responses
                        </SelectItem>
                        <SelectItem value="anthropic-messages">
                          Anthropic Messages
                        </SelectItem>
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
                <div className="relative mt-2">
                  <SearchIcon className="text-muted-foreground absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
                  <Input
                    value={svcModelSearch}
                    onChange={(e) => setSvcModelSearch(e.target.value)}
                    placeholder="搜索模型 ID..."
                    className="h-8 bg-background/60 ps-7 text-xs"
                  />
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
                        <button
                          key={id}
                          type="button"
                          title={id}
                          onClick={() => toggleModel(id)}
                          className="hover:bg-muted/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start"
                        >
                          <ModelBox checked />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                            {id}
                          </span>
                        </button>
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
    </div>
  );
};
