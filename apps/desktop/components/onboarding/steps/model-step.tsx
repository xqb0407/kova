"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import {
  piRequest,
  type PiCredentialSummary,
  type PiModelSummary,
  type PiProviderSummary,
} from "@/lib/pi/pi-bridge";
import { refreshPiModels, usePiModels } from "@/lib/pi/pi-models";
import { setSelectedModel, useSelectedModel } from "@/lib/model/model-settings";
import { useOnboarding } from "../onboarding-flow";
import { Notice, StepFooter, StepHeading } from "./step-parts";
import { CheckIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";

/**
 * 模型配置：选服务商 → 填 API Key → 挑一个模型。
 *
 * 写凭据走 set_credential（落 Keychain/hostdb），选模型走 setSelectedModel
 * （写 SQLite 的 pi.model 并同步 sidecar 运行态），与设置页模型配置同一套通道。
 * 每一步都可回退：填完 key 之后改主意换服务商，已经存下的 key 留着无害。
 */

type Phase = "provider" | "key" | "model";

export const ModelStep: FC = () => {
  const { next, back, patch } = useOnboarding();
  const models = usePiModels();
  const selected = useSelectedModel();

  const [phase, setPhase] = useState<Phase>("provider");
  const [providers, setProviders] = useState<PiProviderSummary[] | null>(null);
  const [authed, setAuthed] = useState<Set<string>>(new Set());
  const [provider, setProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 服务商清单 + 已配凭据：sidecar 起来后拉一次
  useEffect(() => {
    let alive = true;
    piRequest<{
      type: "models";
      models: PiModelSummary[];
      providers: PiProviderSummary[];
    }>({ type: "list_models" })
      .then((res) => {
        if (alive) setProviders(res.providers);
      })
      .catch(() => {
        if (alive) setProviders([]);
      });
    piRequest<{ type: "credentials"; credentials: PiCredentialSummary[] }>({
      type: "list_credentials",
    })
      .then((res) => {
        if (alive) setAuthed(new Set(res.credentials.map((c) => c.providerId)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const providerName = useMemo(
    () => providers?.find((p) => p.id === provider)?.name ?? provider,
    [providers, provider],
  );

  /** 该服务商下已配凭据的模型；目录未按 authed 过滤时退回全部 */
  const candidates = useMemo(
    () => models.filter((m) => m.provider === provider && m.authed !== false),
    [models, provider],
  );

  const pickProvider = useCallback(
    (id: string, hasKey: boolean) => {
      setProvider(id);
      setApiKey("");
      setError(null);
      setPhase(hasKey ? "model" : "key");
    },
    [],
  );

  const saveKey = useCallback(async () => {
    const key = apiKey.trim();
    if (!provider || !key || busy) return;
    setBusy(true);
    setError(null);
    try {
      await piRequest({
        type: "set_credential",
        provider,
        apiKey: key,
      });
      setApiKey("");
      setAuthed((prev) => new Set(prev).add(provider));
      refreshPiModels();
      setPhase("model");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [apiKey, busy, provider]);

  const pickModel = useCallback(
    async (m: PiModelSummary) => {
      if (!provider || busy) return;
      setBusy(true);
      setError(null);
      await setSelectedModel({ provider, modelId: m.id });
      patch("model", { done: true, summary: m.name || m.id });
      setBusy(false);
      next();
    },
    [busy, next, patch, provider],
  );

  // 已有选中的模型：直接展示为「当前使用」，允许一键沿用
  return (
    <div className="flex flex-col">
      <StepHeading
        title={phase === "model" ? `挑选模型 · ${providerName ?? ""}` : "连接模型服务"}
        desc={
          phase === "key"
            ? "填入该服务商的 API Key，只保存在你本机的凭据库里，不会上传到任何地方。"
            : phase === "model"
              ? "这一步只决定新会话默认用哪个模型，随时能在输入框旁切换。"
              : "Kova 通过你自己的模型服务商工作。先选一家，填上 Key 就能开聊。"
        }
      />

      {!isTauri() ? (
        <Notice>当前不是桌面环境，模型配置请在 Kova 客户端里完成。</Notice>
      ) : phase === "provider" ? (
        providers === null ? (
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-2xl" />
            ))}
          </div>
        ) : providers.length === 0 ? (
          <Notice>没有读到可用的模型服务商。可以先跳过，之后到「设置 → 模型配置」里添加。</Notice>
        ) : (
          <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1">
            {providers.map((p) => {
              const hasKey = authed.has(p.id) || p.authed;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickProvider(p.id, hasKey)}
                  className={cn(
                    "hover:bg-muted/70 flex h-16 items-center justify-between gap-2 rounded-2xl border px-4 text-left transition-colors",
                    selected?.provider === p.id && "border-primary/40 bg-muted/60",
                  )}
                >
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {hasKey && (
                    <Badge variant="secondary" className="shrink-0 gap-1">
                      <CheckIcon className="size-3" />
                      已配置
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        )
      ) : phase === "key" ? (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input
              type="password"
              autoFocus
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveKey();
              }}
              placeholder={`粘贴 ${providerName ?? ""} 的 API Key`}
            />
            <Button disabled={!apiKey.trim() || busy} onClick={() => void saveKey()}>
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : <KeyRoundIcon className="size-4" />}
              保存
            </Button>
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <p className="text-muted-foreground text-xs">
            还没拿到 Key？先跳过，用别家服务商或之后在「设置 → 模型配置」里补上都行。
          </p>
        </div>
      ) : candidates.length === 0 ? (
        <Notice>
          暂时没有可用模型（可能目录还在加载，或该服务商没有匹配项）。可以先跳过。
        </Notice>
      ) : (
        <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1">
          {candidates.map((m) => {
            const active = selected?.provider === m.provider && selected?.modelId === m.id;
            return (
              <button
                key={m.id}
                type="button"
                disabled={busy}
                onClick={() => void pickModel(m)}
                className={cn(
                  "hover:bg-muted/70 flex h-14 items-center justify-between gap-2 rounded-2xl border px-4 text-left transition-colors disabled:opacity-50",
                  active && "border-primary/40 bg-muted/60",
                )}
              >
                <span className="truncate text-sm font-medium">{m.name || m.id}</span>
                {active && <CheckIcon className="text-primary size-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      {error && phase !== "key" && <p className="text-destructive mt-3 text-xs">{error}</p>}

      <StepFooter
        onBack={phase === "provider" ? back : () => setPhase("provider")}
        onSkip={() => {
          patch("model", { done: false, summary: null });
          next();
        }}
        hint={
          phase === "key"
            ? "Enter 键直接保存"
            : phase === "provider"
              ? "也可以在「设置 → 模型配置」里添加自定义服务商"
              : undefined
        }
      >
        <Button onClick={next}>下一步</Button>
      </StepFooter>
    </div>
  );
};
