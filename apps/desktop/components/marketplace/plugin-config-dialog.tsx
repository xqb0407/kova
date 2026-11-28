"use client";

/**
 * 插件装后配置弹窗（「在 Kova 里完成配置」）。
 *
 * 装完自动弹（必需字段未满足时，见 marketplace-view 的 op result 分支）与
 * 卡片/设置页手动唤起共用。入参是轻量 target（pluginId + 展示名）：schema
 * 与三态由 get_plugin_config 现取，调用方不必持有 PluginEntry。
 * secret 值只在保存帧里出现一次，永不回显（与 provider key / MCP secretEnv
 * 同款处理，编辑弹窗不回填值）；stale 态（插件升级后绑定 configHash 失配）
 * 呈「一键重新绑定」，不重输值。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import { KeyRoundIcon, Loader2Icon, RefreshCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import type { PiPluginConfigField, PiPluginConfigState } from "@/lib/pi/pi-bridge";
import {
  getPluginConfig,
  rebindPluginConfig,
  savePluginConfig,
} from "@/lib/plugins/plugins";
import { toast } from "@/components/ui/toast";

/** 轻量唤起目标：详情/卡片传 PluginEntry 的投影，设置页从 MCP 行拼同形状 */
export type PluginConfigTarget = {
  pluginId: string;
  name: string;
  displayName?: string;
};

export const PluginConfigDialog: FC<{
  target: PluginConfigTarget | null;
  onClose: () => void;
}> = ({ target, onClose }) => {
  const t = useT();
  const workspace = useProjectWorkspaceDir();
  const [schema, setSchema] = useState<PiPluginConfigField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<PiPluginConfigState | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = target !== null;

  // 打开时现取 schema + 掩码视图（secret 只回「是否已设置」，值永不回传）
  useEffect(() => {
    if (!target) {
      setSchema([]);
      setValues({});
      setSecrets({});
      setState(undefined);
      setBusy(false);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const res = await getPluginConfig(target.pluginId, workspace);
        setSchema(res.schema ?? []);
        setValues(res.values ?? {});
        setSecrets(res.secrets ?? {});
        setState(res.state);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [target, workspace]);

  /** 必填缺口（客户端预检，服务端 set_plugin_config 是最终校验） */
  const missingRequired = useMemo(() => {
    return schema
      .filter((f) => {
        if (!f.required) return false;
        if (f.type === "secret") return !secrets[f.key] && !(values[f.key] ?? "").trim();
        return !(values[f.key] ?? "").trim() && !f.default;
      })
      .map((f) => f.key);
  }, [schema, values, secrets]);

  if (!target) return null;
  const stale = state?.state === "stale";
  const displayName = target.displayName ?? target.name;

  const save = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      // 只提交有值字段：secret 留空 = 保持既有值（轮换时才重填）
      const payload: Record<string, string> = {};
      for (const f of schema) {
        const v = values[f.key];
        if (typeof v === "string" && v.trim()) payload[f.key] = v.trim();
      }
      const res = await savePluginConfig(target.pluginId, payload, workspace);
      setSchema(res.schema ?? []);
      setValues((prev) => ({ ...prev, ...(res.values ?? {}) }));
      setSecrets(res.secrets ?? {});
      setState(res.state);
      // 只有真正就绪才关窗；stale（如停用期间保存/绑定异常）留在弹窗里，
      // 让「一键重新绑定」接手，避免「已保存」toast 与「待重绑」徽章打架
      if (res.state?.state !== "configured") return;
      toast.success({
        title: t("marketplace.pluginConfig.savedTitle", { name: displayName }),
        description: t("marketplace.pluginConfig.savedDesc"),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const rebind = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await rebindPluginConfig(target.pluginId, workspace);
      setState(res.state);
      setSecrets(res.secrets ?? {});
      if (res.state?.state === "configured") {
        toast.success({
          title: t("marketplace.pluginConfig.reboundTitle"),
          description: t("marketplace.pluginConfig.reboundDesc"),
        });
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-6rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <div className="px-6 pt-6 pb-4">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
            {t("marketplace.pluginConfig.title")}
            {stale && (
              <Badge
                variant="outline"
                className="border-amber-500/40 text-amber-700 dark:text-amber-400 font-normal"
              >
                {t("marketplace.pluginConfig.staleBadge")}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="mt-1">
            {stale
              ? t("marketplace.pluginConfig.staleDesc", { name: displayName })
              : t("marketplace.pluginConfig.desc", { name: displayName })}
          </DialogDescription>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-4">
          {stale && (
            <div className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
              <p className="text-muted-foreground text-ui leading-5">
                {t("marketplace.pluginConfig.staleNote")}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1"
                disabled={busy}
                onClick={() => void rebind()}
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCcwIcon className="size-3.5" />
                )}
                {t("marketplace.pluginConfig.rebind")}
              </Button>
            </div>
          )}
          {schema.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-ui font-medium">
                {f.title}
                {f.required && <span className="text-destructive">*</span>}
                {f.type === "secret" && (
                  <KeyRoundIcon className="text-muted-foreground size-3.5" />
                )}
                <span className="text-muted-foreground/70 min-w-0 truncate font-mono text-3xs font-normal">
                  {f.env ?? f.header}
                </span>
              </label>
              {f.type === "enum" ? (
                <Select
                  value={values[f.key] ?? f.default ?? ""}
                  onValueChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v ?? "" }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("marketplace.pluginConfig.selectPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(f.options ?? []).map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={f.type === "secret" ? "password" : "text"}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={
                    f.type === "secret"
                      ? secrets[f.key]
                        ? t("marketplace.pluginConfig.secretSet")
                        : t("marketplace.pluginConfig.secretUnset")
                      : (f.default ?? t("marketplace.pluginConfig.placeholder"))
                  }
                  autoComplete="off"
                />
              )}
              {f.description && (
                <p className="text-muted-foreground text-xs leading-5">{f.description}</p>
              )}
            </div>
          ))}
          {schema.length === 0 && !busy && !error && (
            <p className="text-muted-foreground text-ui leading-5">
              {t("marketplace.pluginConfig.empty")}
            </p>
          )}
          {missingRequired.length > 0 && (
            <p className="text-muted-foreground text-ui leading-5">
              {t("marketplace.pluginConfig.missingHint", {
                keys: schema
                  .filter((f) => missingRequired.includes(f.key))
                  .map((f) => f.title)
                  .join("、"),
              })}
            </p>
          )}
          {error ? <p className="text-destructive text-ui leading-5">{error}</p> : null}
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("marketplace.pluginConfig.skip")}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy || schema.length === 0 || missingRequired.length > 0}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {t("marketplace.pluginConfig.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
