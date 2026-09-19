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
} from "@/lib/observability-config";
import { piRequest, type PiObservabilityTestResult } from "@/lib/pi-bridge";

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
  const config = useObservabilityConfig();
  const reduce = useReducedMotion();
  const [probing, setProbing] = useState(false);
  // headers 编辑用本地缓冲（多行文本），失焦/保存时才解析回对象
  const [headersText, setHeadersText] = useState<string | null>(null);

  const update = (patch: Partial<typeof config>) => {
    saveObservabilityConfig({ ...config, ...patch }).catch(() =>
      toast.error("保存失败，请重试"),
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
      if (r.ok) toast.success(`连接成功（HTTP ${r.status}）`);
      else toast.error(`连接失败：${r.errorText ?? "未知错误"}`);
    } catch {
      toast.error("测试失败：sidecar 不可用");
    } finally {
      setProbing(false);
    }
  };

  const headersValue = headersText ?? headersToText(config.headers);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">调用轨迹导出（OTLP）</h2>
          <p className="text-muted-foreground text-sm">
            每次 agent 运行的调用轨迹（LLM 调用、工具、重试时间线）
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="导出到外部平台"
              desc={config.enabled ? "开启后可配置下方端点与鉴权。" : "关闭时轨迹只留本地，不上传任何数据。"}
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
                    <SettingRow label="OTLP 端点" desc="完整的 traces 摄取 URL。">
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
                          className="text-muted-foreground hover:text-foreground shrink-0 text-xs whitespace-nowrap"
                        >
                          Langfuse 云端
                        </button>
                      </div>
                    </SettingRow>
                    <SettingRow
                      label="请求头"
                      desc="每行一条「Key: Value」。Langfuse 填 Authorization: Basic（公钥:私钥 的 base64）。"
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
                        className="border-border bg-background placeholder:text-muted-foreground/50 focus-visible:ring-ring w-full max-w-md rounded-lg border px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2"
                      />
                    </SettingRow>
                    <SettingRow label="采样率" desc="按「次运行」粒度抽样上传；1 = 全量。">
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
                        <span className="text-muted-foreground w-10 text-right text-xs tabular-nums">
                          {Math.round(config.sampleRate * 100)}%
                        </span>
                      </div>
                    </SettingRow>
                    <SettingRow
                      label="内容脱敏"
                      desc="开启（推荐）只上传元数据：耗时、token、模型与工具名，不含 prompt 与工具正文。"
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
                        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium disabled:opacity-60"
                      >
                        {probing ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <PlugZapIcon className="size-3.5" />
                        )}
                        测试连接
                      </button>
                      <span className="text-muted-foreground/60 text-xs">
                        向端点发一条探针 span 验证可达性与鉴权（10s 超时）。
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