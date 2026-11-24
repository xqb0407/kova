"use client";

import {
  useEffect,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
} from "pi-protocol";

/**
 * 网络代理设置页：sidecar 模型/联网请求的出网方式。
 *
 * 事实源是 Electron 主进程读取的 kv `pi.networkProxy`——代理 env 必须在 sidecar
 * spawn 前确定，所以设置保存后需要重启应用才能让新 sidecar 继承；页面提供显式的
 * 「重启 Kova」按钮。sidecar 自己不经手这个配置。
 *
 * 本地/局域网地址由主进程固定写入 NO_PROXY，这里不暴露开关。
 */
export const NetworkProxySettings: FC = () => {
  const t = useT();
  const desktop = isDesktop();
  const [config, setConfig] = useState<NetworkProxyConfig>(
    DEFAULT_NETWORK_PROXY_CONFIG,
  );
  const [urlDraft, setUrlDraft] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  /** undefined = 检测中；null = 系统未配置/不可用；string = 系统代理地址 */
  const [systemProxy, setSystemProxy] = useState<string | null | undefined>(
    undefined,
  );

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
        setConfig(parsed);
        setUrlDraft(parsed.url);
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

  const save = async (next: NetworkProxyConfig): Promise<boolean> => {
    const previous = config;
    setConfig(next);
    if (!desktop) return true;
    setSaving(true);
    try {
      await invoke("kv_set", {
        key: NETWORK_PROXY_KV_KEY,
        value: serializeNetworkProxyConfig(next),
      });
      return true;
    } catch {
      setConfig(previous);
      toast.error(t("settings.networkProxy.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const changeMode = (mode: NetworkProxyMode) => {
    setUrlError(null);
    // custom 但还没填合法地址：只切本地视图，等地址提交时再落库，
    // 避免把非法 custom 写进 kv（主进程会回落 system，显示与真值脱节）
    if (mode === "custom" && !normalizeNetworkProxyUrl(urlDraft)) {
      setConfig({ ...config, mode });
      return;
    }
    void save({ ...config, mode });
  };

  const commitUrl = () => {
    const normalized = normalizeNetworkProxyUrl(urlDraft);
    if (!normalized) {
      setUrlError(t("settings.networkProxy.urlInvalid"));
      return;
    }
    setUrlError(null);
    setUrlDraft(normalized);
    if (normalized !== config.url) {
      void save({ ...config, url: normalized });
    }
  };

  const commitOnEnter = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // IME 组合中：回车是确认候选词，不是提交
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter") e.currentTarget.blur();
  };

  const restartApp = async () => {
    if (saving) return;
    // 自定义地址可能还在输入框里没失焦：先校验并落库，失败就不重启
    if (config.mode === "custom") {
      const normalized = normalizeNetworkProxyUrl(urlDraft);
      if (!normalized) {
        setUrlError(t("settings.networkProxy.urlInvalid"));
        return;
      }
      if (normalized !== config.url) {
        const ok = await save({ ...config, url: normalized });
        if (!ok) return;
      }
    }
    await invoke("bridge_relaunch_app").catch(() => {
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

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("settings.networkProxy.title")}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            {t("settings.networkProxy.desc")}
          </p>
        </div>

        <section className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
          <SettingRow
            label={t("settings.networkProxy.mode")}
            desc={t("settings.networkProxy.modeDesc")}
          >
            <Select
              value={config.mode}
              disabled={!loaded || saving}
              onValueChange={(v) => v && changeMode(v as NetworkProxyMode)}
            >
              <SelectTrigger size="sm" className="border bg-background w-48">
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
                <SelectItem value="direct">
                  {t("settings.networkProxy.modeDirect")}
                </SelectItem>
                <SelectItem value="custom">
                  {t("settings.networkProxy.modeCustom")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          {config.mode === "custom" && (
            <SettingRow
              label={t("settings.networkProxy.url")}
              desc={t("settings.networkProxy.urlDesc")}
            >
              <div className="flex flex-col items-end gap-1">
                <Input
                  className="h-8 w-64 text-sm"
                  value={urlDraft}
                  placeholder={t("settings.networkProxy.urlPlaceholder")}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={saving}
                  onChange={(e) => {
                    setUrlDraft(e.target.value);
                    setUrlError(null);
                  }}
                  onBlur={commitUrl}
                  onKeyDown={commitOnEnter}
                />
                {urlError && (
                  <p className="text-destructive text-[12px] leading-4">
                    {urlError}
                  </p>
                )}
              </div>
            </SettingRow>
          )}

          {config.mode === "system" && (
            <SettingRow
              label={t("settings.networkProxy.systemProxy")}
              desc={t("settings.networkProxy.systemProxyDesc")}
            >
              <div className="flex items-center gap-2">
                <span
                  className="text-muted-foreground max-w-52 truncate text-[13px]"
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
        </section>

        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-[13px] leading-5">
            {t("settings.networkProxy.restartNote")}
          </p>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => void restartApp()}
            >
              {t("settings.networkProxy.restartNow")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
