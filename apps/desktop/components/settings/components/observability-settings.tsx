"use client";

import { useState, type FC } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Loader2Icon, PlugZapIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import {
  saveObservabilityConfig,
  useObservabilityConfig,
} from "@/lib/settings/observability-config";
import { piRequest, type PiObservabilityTestResult } from "@/lib/pi/pi-bridge";
import { useT } from "@/lib/i18n";

/**
 * 追踪配置区（设置 → 系统 → 关于）：Agent 调用轨迹的 OTLP 导出配置。
 * 轨迹本体（本地 traces 文件 + 面板查看）始终可用，不依赖这里的开关；
 * 这里只管「是否外发、发到哪、怎么鉴权、发多少」。
 * 事实源在 sidecar（SQLite kv），otlp-exporter 实时门控；这里只做镜像，
 * 乐观更新失败回滚并提示。「测试连接」经 sidecar 发一条探针 span
 * （渲染进程 fetch 会被 CORS 拦）。
 */

const LANGFUSE_PRESET = "https://cloud.langfuse.com/api/public/otel/v1/traces";

/** headers 对象 ↔ 多行文本（每行 `Key: Value`，解析失败的行静默丢弃） */
const headersToText = (headers: Record<string, string>): string =>
  Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

const textToHeaders = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
};

export const ObservabilitySection: FC = () => {
  const t = useT();
  const config = useObservabilityConfig();
  const reduce = useReducedMotion();
  const [probing, setProbing] = useState(false);
  // headers 编辑用本地缓冲（多行文本），失焦/保存时才解析回对象
  const [headersText, setHeadersText] = useState<string | null>(null);

  const update = (patch: Partial<typeof config>) => {
    saveObservabilityConfig({ ...config, ...patch }).catch(() =>
      toast.error(t("settings.observability.saveFailed")),
    );
  };

  const probe = async () => {
    setProbing(true);
    try {
      const res = await piRequest<{
        type: "observability_tested";
        result: PiObservabilityTestResult;
      }>({
        type: "test_observability",
        settings: { ...config, headers: textToHeaders(headersText ?? headersToText(config.headers)) },
      }, 15000);
      const r = res.result;
      if (r.ok) toast.success(t("settings.observability.testOk", { status: r.status ?? "-" }));
      else toast.error(t("settings.observability.testFail", { error: r.errorText ?? t("settings.observability.unknownError") }));
    } catch {
      toast.error(t("settings.observability.testUnavailable"));
    } finally {
      setProbing(false);
    }
  };

  const headersValue = headersText ?? headersToText(config.headers);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t("settings.observability.title")}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.observability.desc")}
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.observability.exportEnable")}
              desc={config.enabled ? t("settings.observability.exportEnableOn") : t("settings.observability.exportEnableOff")}
            >
              <Switch
                checked={config.enabled}
                onCheckedChange={(v) => update({ enabled: v })}
              />
            </SettingRow>
            {/* 开启导出才展开的配置区（折叠模式与 cron-editor 一致：
                height 弹簧 + opacity，reduce motion 时退化为纯 opacity） */}
            <AnimatePresence initial={false}>
              {config.enabled && (
                <motion.div
                  key="export-config"
                  initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={
                    reduce
                      ? { duration: 0.15 }
                      : {
                          height: { type: "spring", stiffness: 380, damping: 34, mass: 0.7 },
                          opacity: { duration: 0.22, ease: "easeOut" },
                        }
                  }
                  className="overflow-hidden"
                >
                  <div className="flex flex-col gap-1">
                    <SettingRow label={t("settings.observability.endpoint")} desc={t("settings.observability.endpointDesc")}>
                      <div className="flex w-full max-w-md items-center gap-2">
                        <Input
                          value={config.endpoint}
                          placeholder={LANGFUSE_PRESET}
                          onChange={(e) => update({ endpoint: e.target.value })}
                          className="h-8 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => update({ endpoint: LANGFUSE_PRESET })}
                          className="text-muted-foreground hover:text-foreground shrink-0 text-[13px] leading-5 whitespace-nowrap"
                        >
                          {t("settings.observability.langfuseCloud")}
                        </button>
                      </div>
                    </SettingRow>
                    <SettingRow
                      label={t("settings.observability.headers")}
                      desc={t("settings.observability.headersDesc")}
                    >
                      <textarea
                        value={headersValue}
                        onChange={(e) => setHeadersText(e.target.value)}
                        onBlur={() => {
                          if (headersText === null) return;
                          update({ headers: textToHeaders(headersText) });
                          setHeadersText(null);
                        }}
                        rows={3}
                        spellCheck={false}
                        placeholder={"Authorization: Basic cGstbGlm…"}
                        className="border-border bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full max-w-md rounded-lg border px-2 py-1.5 font-mono text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2"
                      />
                    </SettingRow>
                    <SettingRow label={t("settings.observability.sampleRate")} desc={t("settings.observability.sampleRateDesc")}>
                      <div className="flex w-full max-w-md items-center gap-3">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.1}
                          value={config.sampleRate}
                          onChange={(e) => update({ sampleRate: Number(e.target.value) })}
                          className="accent-foreground w-40"
                        />
                        <span className="text-muted-foreground w-10 text-right text-[13px] leading-5 tabular-nums">
                          {Math.round(config.sampleRate * 100)}%
                        </span>
                      </div>
                    </SettingRow>
                    <SettingRow
                      label={t("settings.observability.redact")}
                      desc={t("settings.observability.redactDesc")}
                    >
                      <Switch
                        checked={config.redactContent}
                        onCheckedChange={(v) => update({ redactContent: v })}
                      />
                    </SettingRow>
                    <div className="flex items-center gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => void probe()}
                        disabled={probing}
                        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] leading-5 font-medium disabled:opacity-60"
                      >
                        {probing ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <PlugZapIcon className="size-3.5" />
                        )}
                        {t("settings.observability.test")}
                      </button>
                      <span className="text-muted-foreground text-[13px] leading-5">
                        {t("settings.observability.testDesc")}
                      </span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>
  );
};