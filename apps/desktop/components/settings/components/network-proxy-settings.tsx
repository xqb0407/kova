"use client";

import { useEffect, useState, type FC } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";
import { useT } from "@/lib/i18n";
import {
  DEFAULT_NETWORK_PROXY_CONFIG,
  NETWORK_PROXY_KV_KEY,
  normalizeNetworkProxyUrl,
  parseNetworkProxyConfig,
  serializeNetworkProxyConfig,
  type NetworkProxyConfig,
  type NetworkProxyMode,
  type NetworkProxyTestResult,
} from "pi-protocol";

/**
 * 网络代理设置页：sidecar 模型/联网请求的出网方式。
 *
 * 事实源是 Electron 主进程读取的 kv `pi.networkProxy`——代理 env 必须在 sidecar
 * spawn 前确定，所以保存后需要重启 Kova 才能让新 sidecar 继承；页面提供显式的
 * 「立即重启」入口。本地/局域网地址由主进程固定写入 NO_PROXY。
 *
 * 页面使用草稿态：模式/地址/绕过列表改动只留在组件内，点「保存」才落库；离开
 * 页面未保存的草稿会丢弃。
 */
export const NetworkProxySettings: FC = () => {
  const t = useT();
  const desktop = isDesktop();
  const [saved, setSaved] = useState<NetworkProxyConfig>(
    DEFAULT_NETWORK_PROXY_CONFIG,
  );
  const [draft, setDraft] = useState<NetworkProxyConfig>(
    DEFAULT_NETWORK_PROXY_CONFIG,
  );
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NetworkProxyTestResult | null>(
    null,
  );
  const [urlError, setUrlError] = useState<string | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  /** undefined = 检测中；null = 系统未配置/不可用；string = 系统代理地址 */
  const [systemProxy, setSystemProxy] = useState<string | null | undefined>(
    undefined,
  );

  const dirty =
    loaded &&
    (draft.mode !== saved.mode ||
      draft.url !== saved.url ||
      draft.noProxy !== saved.noProxy);

  const detectSystemProxy = () => {
    if (!desktop) return;
    setSystemProxy(undefined);
    void invoke<string | null>("bridge_system_proxy")
      .then((value) => setSystemProxy(value ?? null))
      .catch(() => setSystemProxy(null));
  };

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void invoke<string | null>("kv_get", { key: NETWORK_PROXY_KV_KEY })
      .then((raw) => {
        if (!alive) return;
        const parsed = parseNetworkProxyConfig(raw);
        setSaved(parsed);
        setDraft(parsed);
      })
      .catch(() => {
        /* kv 不可用：保持默认（跟随系统） */
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    detectSystemProxy();
    return () => {
      alive = false;
    };
  }, [desktop]);

  const patch = (next: Partial<NetworkProxyConfig>) => {
    setDraft((current) => ({ ...current, ...next }));
    setUrlError(null);
    setTestResult(null);
  };

  const save = async () => {
    if (saving || !dirty) return;
    let next = { ...draft };
    if (next.mode === "custom") {
      const normalized = normalizeNetworkProxyUrl(next.url);
      if (!normalized) {
        setUrlError(t("settings.networkProxy.urlInvalid"));
        return;
      }
      next = { ...next, url: normalized };
    } else if (next.url) {
      // 非手动模式仍保留上次地址方便切回；但清掉非法/带凭据的值，避免明文落库
      next = { ...next, url: normalizeNetworkProxyUrl(next.url) ?? "" };
    }
    setSaving(true);
    try {
      await invoke("kv_set", {
        key: NETWORK_PROXY_KV_KEY,
        value: serializeNetworkProxyConfig(next),
      });
      setSaved(next);
      setDraft(next);
      setUrlError(null);
      setTestResult(null);
    } catch {
      toast.error(t("settings.networkProxy.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (testing || saving) return;
    let url: string | undefined;
    if (draft.mode === "custom") {
      const normalized = normalizeNetworkProxyUrl(draft.url);
      if (!normalized) {
        setUrlError(t("settings.networkProxy.urlInvalid"));
        return;
      }
      url = normalized;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke<NetworkProxyTestResult>("bridge_test_proxy", {
        ...(url ? { url } : {}),
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        proxy: null,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: 0,
      });
    } finally {
      setTesting(false);
    }
  };

  const restartApp = () => {
    if (dirty || saving) return;
    void invoke("bridge_relaunch_app").catch(() => {
      toast.error(t("settings.networkProxy.restartFailed"));
    });
  };

  if (!desktop) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        {t("settings.networkProxy.desktopOnly")}
      </div>
    );
  }

  const systemProxyText =
    systemProxy === undefined
      ? t("settings.networkProxy.checking")
      : (systemProxy ?? t("settings.networkProxy.systemDirect"));

  const testText = testing
    ? t("settings.networkProxy.testing")
    : testResult
      ? testResult.proxy === null
        ? t("settings.networkProxy.testDirect")
        : testResult.ok
          ? t("settings.networkProxy.testOk", {
              status: testResult.statusCode ?? "-",
              ms: testResult.latencyMs,
            })
          : testResult.statusCode
            ? t("settings.networkProxy.testFailStatus", {
                status: testResult.statusCode,
              })
            : t("settings.networkProxy.testFail", {
                error: testResult.error ?? t("settings.networkProxy.unknownError"),
              })
      : null;

  const statusText = !loaded
    ? t("settings.networkProxy.loading")
    : dirty
      ? t("settings.networkProxy.unsaved")
      : t("settings.networkProxy.savedRestart");

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("settings.networkProxy.title")}
          </h1>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {t("settings.networkProxy.mode")}
          </h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.networkProxy.modeRow")}
              desc={t("settings.networkProxy.modeDesc")}
            >
              <Select
                value={draft.mode}
                disabled={!loaded || saving || testing}
                onValueChange={(v) =>
                  v && patch({ mode: v as NetworkProxyMode })
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-44 border bg-background"
                >
                  <SelectValue>
                    {(value: NetworkProxyMode | null) =>
                      value === "direct"
                        ? t("settings.networkProxy.modeDirect")
                        : value === "custom"
                          ? t("settings.networkProxy.modeCustom")
                          : t("settings.networkProxy.modeSystem")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">
                    {t("settings.networkProxy.modeSystem")}
                  </SelectItem>
                  <SelectItem value="custom">
                    {t("settings.networkProxy.modeCustom")}
                  </SelectItem>
                  <SelectItem value="direct">
                    {t("settings.networkProxy.modeDirect")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            {draft.mode === "system" && (
              <SettingRow
                label={t("settings.networkProxy.systemProxy")}
                desc={t("settings.networkProxy.systemProxyDesc")}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="text-muted-foreground max-w-52 truncate text-ui"
                    title={systemProxy ?? undefined}
                  >
                    {systemProxyText}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={systemProxy === undefined}
                    onClick={detectSystemProxy}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    {t("settings.networkProxy.redetect")}
                  </Button>
                </div>
              </SettingRow>
            )}
          </div>
        </section>

        {draft.mode === "custom" && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">
              {t("settings.networkProxy.manualTitle")}
            </h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <div className="flex flex-col gap-1 px-3 py-2">
                <div className="text-sm font-medium">
                  {t("settings.networkProxy.url")}
                </div>
                <div className="text-muted-foreground text-ui leading-5">
                  {t("settings.networkProxy.urlDesc")}
                </div>
                <Input
                  className="border-border bg-background mt-1 h-9 w-full font-mono text-sm"
                  value={draft.url}
                  placeholder={t("settings.networkProxy.urlPlaceholder")}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={saving || testing}
                  onChange={(e) => patch({ url: e.target.value })}
                />
                {urlError && (
                  <p className="text-destructive text-[12px] leading-4 break-all">
                    {urlError}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1 px-3 py-2">
                <div className="text-sm font-medium">
                  {t("settings.networkProxy.bypass")}
                </div>
                <div className="text-muted-foreground text-ui leading-5">
                  {t("settings.networkProxy.bypassDesc")}
                </div>
                <Textarea
                  className="border-border bg-background mt-1 min-h-24 w-full resize-y font-mono text-sm"
                  value={draft.noProxy}
                  placeholder={"localhost\n127.0.0.1\n.example.internal"}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={saving || testing}
                  onChange={(e) => patch({ noProxy: e.target.value })}
                />
              </div>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {t("settings.networkProxy.status")}
          </h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.networkProxy.statusRow")}
              desc={statusText}
            >
              <div className="flex items-center gap-2">
                {draft.mode !== "direct" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!loaded || testing || saving}
                    onClick={() => void testConnection()}
                  >
                    {testing
                      ? t("settings.networkProxy.testing")
                      : t("settings.networkProxy.test")}
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!loaded || !dirty || saving || testing}
                  onClick={() => void save()}
                >
                  {saving
                    ? t("settings.networkProxy.saving")
                    : t("settings.networkProxy.save")}
                </Button>
              </div>
            </SettingRow>

            {testText && (
              <div
                className={
                  testResult && !testResult.ok
                    ? "text-destructive px-3 pb-2 text-ui leading-5 break-all"
                    : "text-muted-foreground px-3 pb-2 text-ui leading-5 break-all"
                }
              >
                {testText}
              </div>
            )}

            <SettingRow
              label={t("settings.networkProxy.restartTitle")}
              desc={t("settings.networkProxy.restartNote")}
            >
              <Button
                variant="outline"
                size="sm"
                disabled={dirty || saving || testing}
                onClick={() => setRestartOpen(true)}
              >
                {t("settings.networkProxy.restartNow")}
              </Button>
            </SettingRow>
          </div>
        </section>
      </div>

      <AlertDialog open={restartOpen} onOpenChange={setRestartOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.networkProxy.restartConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.networkProxy.restartConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.action.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRestartOpen(false);
                restartApp();
              }}
            >
              {t("settings.networkProxy.restartConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
