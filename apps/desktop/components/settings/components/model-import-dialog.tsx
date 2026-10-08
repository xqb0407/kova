"use client";

/**
 * 从本机其它工具导入模型服务的预览弹窗（设置 → 模型 →「从其他工具导入」，
 * 引导页模型那步的次要入口也用它）。
 *
 * 交互分三层，逐层收窄，用户任何一步都能看出"到底会发生什么"：
 *   1. 勾选导入哪几条候选（来源分组，默认全选）
 *   2. 逐条决定要不要把 API Key 一并搬进 Kova 钥匙串（默认勾上，掩码显示）
 *   3. 与 Kova 已有服务同名的行，默认动作是"跳过"，可逐条改为"覆盖"
 *
 * 明文密钥只在本次扫描结果的 state 里存在，构造入参用完即随弹窗关闭丢弃，
 * 不写 localStorage、不进任何持久化层。
 */
import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ProviderIcon } from "@/components/custom-ui/provider-icon";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import {
  importOneProvider,
  refreshAfterImport,
  scanProviderImports,
  type ProviderImportScanResult,
} from "@/lib/model/import-providers";
import type { PiImportSource, PiImportedProvider } from "@/lib/pi/pi-bridge";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ImportIcon,
  KeyRoundIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";

/** 来源展示名与分组顺序（与 sidecar 的固定顺序一致） */
const SOURCE_META: { id: PiImportSource; label: string }[] = [
  { id: "opencode", label: "opencode" },
  { id: "codex", label: "Codex" },
  { id: "zcode", label: "ZCode" },
  { id: "ccswitch", label: "CC-Switch" },
];

/** 候选的行 key：来源 + 来源内标识，跨来源不会撞 */
const rowKey = (c: PiImportedProvider) => `${c.source}:${c.sourceKey}`;

/** 掩码：与 sidecar maskApiKey 同一形状（头 4 + **** + 尾 4），只用于展示 */
const maskKey = (key: string): string => {
  if (key.length <= 10) return `${key.slice(0, 2)}****`;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
};

/** 同名冲突的两个动作。Base UI 的 Select 只在传 items 时才把 value 映射成
 *  文案，否则触发器上显示的是原始 value（会露出 "skip" 这种英文） */
const CONFLICT_ACTIONS = {
  skip: "跳过",
  replace: "覆盖已有的",
} as const;

const CONFLICT_ITEMS = (Object.entries(CONFLICT_ACTIONS) as [keyof typeof CONFLICT_ACTIONS, string][])
  .map(([value, label]) => ({ value, label }));

/** 同名判定：Kova 里的自定义服务名对用户是唯一的，冲突就以名字比。
 *  比 id 没意义——源工具的 id 体系跟 Kova 的 custom-<slug> 完全不同 */
const findExisting = (
  name: string,
  existing: { name: string; providerId: string }[],
) => existing.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());

export const ModelImportDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kova 已有的自定义服务（用于同名冲突判定），由调用方从 model-settings 传入 */
  existingProviders: { name: string; providerId: string }[];
  /** 导入成功后通知调用方刷新自己的清单 */
  onImported?: () => void;
  /**
   * 预置扫描结果，**只给 app/dev-preview 用**。扫描走 sidecar，纯浏览器环境连不上，
   * 这个口子让列表布局能在前端单独被看到和校对；生产路径永远不传——没传就是真扫。
   */
  previewScan?: ProviderImportScanResult;
}> = ({ open, onOpenChange, existingProviders, onImported, previewScan }) => {
  const [scan, setScan] = useState<ProviderImportScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  /** 勾选要导入的行 */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** 逐条决定带不带密钥；默认全 true */
  const [withKey, setWithKey] = useState<Set<string>>(new Set());
  /** 冲突行的动作：skip = 跳过，replace = 覆盖既有服务 */
  const [conflictAction, setConflictAction] = useState<Record<string, "skip" | "replace">>({});
  /** 按名称/地址过滤（候选常有二三十条，翻找不现实） */
  const [query, setQuery] = useState("");
  /** 折叠的来源分组；默认全展开，用户自己收起关心的来源 */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const result = await scanProviderImports();
      setScan(result);
      // 服务与密钥都默认全选：导入这个功能的本质是一键搬家，把配置搬过来
      // 却不搬密钥，服务照样连不上，等于只搬了一半。密钥的取舍摆在明面上
      // （密钥行 + 每行的钥匙按钮），要少搬就点一下，不必默认替用户做主
      setPicked(new Set(result.candidates.map(rowKey)));
      setWithKey(new Set(result.candidates.filter((c) => c.apiKey).map(rowKey)));
      setResults({});
    } catch (err) {
      setScan(null);
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, []);

  // 每次打开都重扫：用户在别的工具里改了配置后，重开就该看到最新的。
  // dev-preview 传了预置结果就用它，不去打 sidecar
  useEffect(() => {
    if (!open) return;
    setResults({});
    if (previewScan) {
      setScan(previewScan);
      setPicked(new Set(previewScan.candidates.map(rowKey)));
      setWithKey(new Set(previewScan.candidates.filter((c) => c.apiKey).map(rowKey)));
      return;
    }
    setScan(null);
    void runScan();
  }, [open, runScan, previewScan]);

  const resetAndClose = useCallback(() => {
    // 明文密钥随 state 一起丢弃
    setScan(null);
    setPicked(new Set());
    setWithKey(new Set());
    setConflictAction({});
    setResults({});
    setQuery("");
    onOpenChange(false);
  }, [onOpenChange]);

  /** 候选按来源分组，组内保持 sidecar 给的顺序；名称/地址过滤后再生成分组，
   *  这样"组内计数"与勾选状态始终对应当前真正列出来的那些条 */
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = (scan?.candidates ?? []).filter(
      (c) => !q || c.name.toLowerCase().includes(q) || c.baseUrl.toLowerCase().includes(q),
    );
    const map = new Map<PiImportSource, PiImportedProvider[]>();
    for (const c of matched) {
      const list = map.get(c.source) ?? [];
      list.push(c);
      map.set(c.source, list);
    }
    return SOURCE_META.map((meta) => ({ ...meta, items: map.get(meta.id) ?? [] })).filter(
      (g) => g.items.length > 0,
    );
  }, [scan, query]);

/** 当前可见（未被过滤掉）的候选数 —— 「全选/全不选」只作用于这些，
   *  跟用户眼前的列表一致；被过滤隐藏的条目保持原勾选状态不变 */
  const visibleCount = useMemo(
    () => grouped.reduce((n, g) => n + g.items.length, 0),
    [grouped],
  );
  const visiblePicked = useMemo(() => {
    let n = 0;
    for (const g of grouped) {
      for (const c of g.items) if (picked.has(rowKey(c))) n += 1;
    }
    return n;
  }, [grouped, picked]);
  const hiddenCount = (scan?.candidates.length ?? 0) - visibleCount;

  /** 带密钥的候选数与其中已勾数 —— 密钥行上「将导入 N 个密钥」的数字 */
  const keyCount = useMemo(
    () => (scan?.candidates ?? []).filter((c) => c.apiKey).length,
    [scan],
  );
  const keyPicked = useMemo(() => {
    let n = 0;
    for (const g of grouped) {
      for (const c of g.items) if (c.apiKey && withKey.has(rowKey(c))) n += 1;
    }
    return n;
  }, [grouped, withKey]);

  /** 一键全带/全不带密钥（只动有密钥的条目；过滤态下同样只作用于可见的那些） */
  const setAllVisibleKeys = useCallback(
    (on: boolean) => {
      setWithKey((prev) => {
        const next = new Set(prev);
        for (const g of grouped) {
          for (const c of g.items) {
            if (!c.apiKey) continue;
            if (on) next.add(rowKey(c));
            else next.delete(rowKey(c));
          }
        }
        return next;
      });
    },
    [grouped],
  );

  /** 组内已勾选数：驱动组头勾选框的全选/半选/全不选三态 */
  const groupPicked = useCallback(
    (group: { items: PiImportedProvider[] }) => {
      let n = 0;
      for (const c of group.items) if (picked.has(rowKey(c))) n += 1;
      return n;
    },
    [picked],
  );

  const setAllVisible = useCallback(
    (on: boolean) => {
      setPicked((prev) => {
        const next = new Set(prev);
        for (const g of grouped) {
          for (const c of g.items) {
            if (on) next.add(rowKey(c));
            else next.delete(rowKey(c));
          }
        }
        return next;
      });
    },
    [grouped],
  );

  /**
   * 真正会执行的行：勾上、且（无冲突 或 选了覆盖）。
   * 走全量 scan 而非 grouped —— 过滤只该影响"看得见哪些"，不该悄悄改变
   * "会导入哪些"：搜完再点导入，用户预期是把选中的都导进去，而不是把
   * 看不见的那批静默丢掉。计数与工具条因此始终说的是同一件事。
   */
  const effective = useMemo(() => {
    if (!scan) return [];
    return scan.candidates.filter((c) => {
      const key = rowKey(c);
      if (!picked.has(key)) return false;
      const existing = findExisting(c.name, existingProviders);
      if (existing) return conflictAction[key] === "replace";
      return true;
    });
  }, [scan, picked, conflictAction, existingProviders]);

  /** 勾上但会因同名被跳过的行数；全被跳过时按钮要给得出原因而不是干瘪地禁用 */
  const skipCount = useMemo(() => {
    let n = 0;
    for (const group of grouped) {
      for (const c of group.items) {
        if (!picked.has(rowKey(c))) continue;
        if (findExisting(c.name, existingProviders)) n += 1;
      }
    }
    return n;
  }, [grouped, picked, existingProviders]);

  const importAll = useCallback(async () => {
    if (importing || effective.length === 0) return;
    setImporting(true);
    setResults({});
    // 逐条串行：每条都是独立的 add_custom_provider，串行能让进度如实反映，
    // 也避免同时写 credentials/models 表
    const failures: string[] = [];
    for (const c of effective) {
      const key = rowKey(c);
      const existing = findExisting(c.name, existingProviders);
      const result = await importOneProvider({
        candidate: c,
        withApiKey: withKey.has(key),
        ...(existing && conflictAction[key] === "replace"
          ? { providerId: existing.providerId }
          : {}),
      });
      if (result.ok) {
        setResults((prev) => ({ ...prev, [key]: "" }));
      } else {
        failures.push(`${c.name}：${result.error}`);
        setResults((prev) => ({ ...prev, [key]: result.error }));
      }
    }
    setImporting(false);
    refreshAfterImport();
    onImported?.();
    const okCount = effective.length - failures.length;
    if (failures.length === 0) {
      toast.success(`已导入 ${okCount} 个服务`);
      resetAndClose();
    } else {
      // 部分失败：留在弹窗里让用户看到每条的错误，而不是一把关掉
      toast.error(`${okCount} 个成功，${failures.length} 个失败`);
    }
  }, [effective, importing, withKey, conflictAction, existingProviders, onImported, resetAndClose]);

  const hasCandidates = (scan?.candidates.length ?? 0) > 0;
  // 已装但解析失败 / 什么都没扫到，两种"空"的原因不同，文案也不同
  const foundButEmpty = (scan?.sources ?? []).filter((s) => s.foundPath && s.count === 0);
  const erroredSources = (scan?.sources ?? []).filter((s) => s.error);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !importing) resetAndClose(); }}>
      {/* 固定头尾 + 中间列表独立滚动：候选常有二三十条，若整窗滚动，
          「导入 N 个」按钮会随列表滚出视野，勾选到一半就找不到下一步 */}
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 space-y-1.5 p-6 pb-4 pe-14">
          <DialogTitle>从其他工具导入模型服务</DialogTitle>
          <DialogDescription>
            读取本机 opencode / Codex / ZCode / CC-Switch 的配置，把里面的模型服务（端点、密钥、模型列表）
            搬进 Kova。只读那些工具的配置，不会改写它们。
          </DialogDescription>
        </DialogHeader>

        {/* 唯一的滚动容器：min-h-0 是 flex 子项能真正收缩的前提。
            pb-4 让最后一行与底栏之间留白，不至于贴着"导入"按钮像是被裁掉 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        {scanning ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : scanError ? (
          <p className="text-destructive text-xs" role="alert">{scanError}</p>
        ) : !hasCandidates ? (
          <div className="text-muted-foreground flex flex-col gap-2 text-xs">
            <p>
              没扫到可导入的模型服务。Kova 会在下面这几个位置找：
            </p>
            <ul className="bg-muted/50 flex flex-col gap-1 rounded-xl p-2.5 font-mono text-[11px]">
              {(scan?.sources ?? []).map((s) => (
                <li key={s.source}>
                  {SOURCE_META.find((m) => m.id === s.source)?.label ?? s.source}
                  ：{s.paths.join(" 或 ")}
                </li>
              ))}
            </ul>
            {erroredSources.length > 0 && (
              <ul className="text-destructive flex flex-col gap-0.5">
                {erroredSources.map((s) => (
                  <li key={s.source}>
                    {SOURCE_META.find((m) => m.id === s.source)?.label ?? s.source} 配置读取失败：
                    {s.error}
                  </li>
                ))}
              </ul>
            )}
            {foundButEmpty.length > 0 && (
              <p>
                {foundButEmpty
                  .map((s) => SOURCE_META.find((m) => m.id === s.source)?.label ?? s.source)
                  .join("、")}
                的配置里没有可导入的服务（需要配了 baseUrl 的 provider）。
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {/* 选中态工具条：默认是全选，用户第一反应往往是"取消大部分"，
                把「全不选」摆在明面上，别指望他找到组头那个小方块 */}
            <div className="flex items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="按名称或地址过滤"
                className="h-8 flex-1 text-sm"
              />
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-8 shrink-0 text-xs"
                disabled={visibleCount === 0 || visiblePicked === 0}
                onClick={() => setAllVisible(false)}
              >
                全不选
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-8 shrink-0 text-xs"
                disabled={visibleCount === 0 || visiblePicked === visibleCount}
                onClick={() => setAllVisible(true)}
              >
                全选
              </Button>
            </div>
            <div className="text-muted-foreground flex items-center justify-between text-[11px]">
              <span>
                已选 {picked.size} / {scan?.candidates.length ?? 0} 个
                {hiddenCount > 0 && `（当前只显示 ${visibleCount} 个）`}
              </span>
              {picked.size > 0 && (
                <button
                  type="button"
                  className="hover:text-foreground transition-colors"
                  onClick={() =>
                    setPicked(new Set(grouped.flatMap((g) => g.items.map(rowKey))))
                  }
                >
                  清空选择
                </button>
              )}
            </div>
            {grouped.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-xs">
                没有匹配「{query}」的服务
              </p>
            ) : keyCount > 0 ? (
              /* 密钥行：默认全带，但摆出确切数量与一键全不带，
                 免得"默认搬走二三十个密钥"变成看不见的既成事实 */
              <div className="bg-muted/40 flex items-center gap-2 rounded-lg px-2 py-1.5">
                <KeyRoundIcon className="text-muted-foreground size-3.5 shrink-0" />
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
                  将导入 <span className="text-foreground font-medium tabular-nums">{keyPicked}</span> /{" "}
                  {keyCount} 个密钥到 Kova 钥匙串
                  {keyPicked === 0 && "（不带密钥也能导入，之后在设置里补）"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-6 shrink-0 text-[11px]"
                  disabled={keyPicked === 0}
                  onClick={() => setAllVisibleKeys(false)}
                >
                  全不带
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-6 shrink-0 text-[11px]"
                  disabled={keyPicked === keyCount}
                  onClick={() => setAllVisibleKeys(true)}
                >
                  全带
                </Button>
              </div>
            ) : null}
            {grouped.length > 0 && (
              grouped.map((group) => (
                <div key={group.id} className="flex flex-col gap-1">
                  {/* 组头兼全选：来源分组 + 一键勾/取消这一组 */}
                  <div className="flex items-center gap-2 py-0.5">
                    {/* 部分勾选时叠一根短横：Base UI 的 Checkbox 只认 boolean，
                                半选态得自己画，否则"勾了一半"和"没勾"长得一样 */}
                    <span className="relative flex size-4 shrink-0 items-center justify-center">
                      <Checkbox
                        checked={groupPicked(group) === group.items.length}
                        onCheckedChange={(on) =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            for (const c of group.items) {
                              if (on) next.add(rowKey(c));
                              else next.delete(rowKey(c));
                            }
                            return next;
                          })
                        }
                        aria-label={`全选 ${group.label}`}
                      />
                      {groupPicked(group) > 0 &&
                        groupPicked(group) < group.items.length && (
                          <span className="bg-background pointer-events-none absolute inset-0 flex items-center justify-center">
                            <span className="bg-foreground h-0.5 w-2 rounded-full" />
                          </span>
                        )}
                    </span>
                    <button
                      type="button"
                      className="hover:text-foreground text-muted-foreground flex items-center gap-1 text-xs font-medium transition-colors"
                      onClick={() =>
                        setCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))
                      }
                    >
                      {collapsed[group.id] ? (
                        <ChevronRightIcon className="size-3" />
                      ) : (
                        <ChevronDownIcon className="size-3" />
                      )}
                      {group.label}
                    </button>
                    <span className="text-muted-foreground text-[11px]">
                      {group.items.length} 个
                    </span>
                  </div>

                  {!collapsed[group.id] && (
                    <div className="bg-muted/40 flex flex-col gap-px rounded-lg p-1">
                      {group.items.map((c) => {
                        const key = rowKey(c);
                        const existing = findExisting(c.name, existingProviders);
                        const failure = results[key];
                        const done = key in results && !failure;
                        const isPicked = picked.has(key);
                        return (
                          <div key={key} className="rounded-md">
                            {/* 单行：勾选 + 名称 + 端点 + 模型数。端点与接口格式
                                收进同一行右侧，不再为每条单开两三行 */}
                            <div
                              className={cn(
                                "hover:bg-muted/70 flex h-8 items-center gap-2 rounded-md px-2 transition-colors",
                                isPicked && "bg-muted/60",
                              )}
                            >
                              <Checkbox
                                checked={isPicked}
                                onCheckedChange={(on) =>
                                  setPicked((prev) => {
                                    const next = new Set(prev);
                                    if (on) next.add(key);
                                    else next.delete(key);
                                    return next;
                                  })
                                }
                                aria-label={`导入 ${c.name}`}
                              />
                              {/* 服务行放服务的图标（与 model-settings 的服务行同口径）：
                                  候选行还没定用哪个模型，按 modelId 认厂家反而不稳定 */}
                              <ProviderIcon
                                provider={c.name}
                                providerName={c.name}
                                className="size-3.5 shrink-0"
                              />
                              <span className="w-44 shrink-0 truncate text-sm font-medium">
                                {c.name}
                              </span>
                              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
                                {c.baseUrl}
                              </span>
                              {c.models.length > 0 && (
                                <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                                  {c.models.length} 模型
                                </span>
                              )}
                              {/* 密钥开关收进行内：默认不带，勾上才搬。按钮态随勾选变化，
                                  否则一排灰色钥匙看不出"点它会导入密钥" */}
                              {c.apiKey && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setWithKey((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(key)) next.delete(key);
                                      else next.add(key);
                                      return next;
                                    })
                                  }
                                  title={
                                    withKey.has(key)
                                      ? `将导入密钥 ${maskKey(c.apiKey)}`
                                      : `默认不带密钥；点击导入 ${maskKey(c.apiKey)}`
                                  }
                                  aria-pressed={withKey.has(key)}
                                  className={cn(
                                    "flex size-6 shrink-0 items-center justify-center rounded-md ring-1 transition-colors",
                                    withKey.has(key)
                                      ? "bg-primary/15 text-primary ring-primary/40"
                                      : "text-muted-foreground/50 ring-border hover:bg-muted hover:text-muted-foreground",
                                  )}
                                >
                                  <KeyRoundIcon className="size-3.5" />
                                </button>
                              )}
                              {c.disabled && (
                                <Badge variant="outline" className="shrink-0 text-[10px]">
                                  停用
                                </Badge>
                              )}
                              {existing && (
                                <CircleAlertIcon
                                  className="text-muted-foreground size-3.5 shrink-0"
                                  aria-label="Kova 已有同名服务"
                                />
                              )}
                              {done && (
                                <CheckIcon className="text-primary size-3.5 shrink-0" />
                              )}
                            </div>

                            {/* 只剩冲突需要展开：跳过还是覆盖是二选一，没法塞进单行；
                                未勾选的行不该为不打算做的事占版面 */}
                            {isPicked && existing && (
                              <div className="flex items-center gap-2 pb-1 pl-8 pr-2">
                                <span className="text-muted-foreground text-[11px]">
                                  Kova 里已有同名服务
                                </span>
                                <Select
                                  items={CONFLICT_ITEMS}
                                  value={conflictAction[key] ?? "skip"}
                                  onValueChange={(v) =>
                                    setConflictAction((prev) => ({
                                      ...prev,
                                      [key]: v as "skip" | "replace",
                                    }))
                                  }
                                >
                                  <SelectTrigger size="sm" className="h-6 w-28 text-[11px]">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="skip">跳过</SelectItem>
                                    <SelectItem value="replace">覆盖已有的</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            {failure && (
                              <p className="text-destructive pb-1 pl-8 pr-2 text-[11px]">
                                {failure}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
        </div>

        {/* 底部操作条常驻：列表再长也看得见当前会导入几个 */}
        <DialogFooter className="shrink-0 border-t p-4">
          <Button variant="outline" onClick={resetAndClose} disabled={importing}>
            取消
          </Button>
          {!scanning && hasCandidates && (
            <Button variant="ghost" onClick={() => void runScan()} disabled={importing}>
              <RefreshCwIcon className="size-4" />
              重新扫描
            </Button>
          )}
          <Button
            onClick={() => void importAll()}
            disabled={importing || effective.length === 0}
          >
            {importing ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <ImportIcon className="size-4" />
            )}
            {importing
              ? "导入中…"
              : effective.length > 0
                ? `导入 ${effective.length} 个`
                : skipCount > 0
                  ? "所选均与现有服务同名，保持跳过"
                  : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};