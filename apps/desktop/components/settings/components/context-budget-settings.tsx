"use client";

import { useEffect, useRef, useState, type FC } from "react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import {
  LOOP_GUARD_ID,
  TOOL_BUDGET_ID,
  initCapabilitiesConfig,
  setLoopGuardEnabled,
  setLoopGuardThreshold,
  setToolBudgetEnabled,
  setToolBudgetMaxInlineBytes,
  useCapabilitiesSnapshot,
  type CapabilitiesSaveResult,
} from "@/lib/settings/capabilities-config";
import { useT } from "@/lib/i18n";

const LIMIT_KB_MIN = 8;
const LIMIT_KB_MAX = 256;
const THRESHOLD_MIN = 2;
const THRESHOLD_MAX = 10;

/**
 * 上下文预算区块（设置 → 智能体 → 智能体配置）——控制"对话里放什么、放多少"。
 *
 * 与「电脑控制」的边界：那组开关决定 AI 能碰本机的什么（授权），这组只调整
 * 上下文的管理方式，不扩大能力边界：
 * - 大输出外置（tool-budget）：超限工具输出存为会话文件，对话里只留可回查路径。
 *   默认开启；写盘失败会降级为头尾预览，不阻断工具调用。
 * - 重复失败提醒（loop-guard，实验性）：同一调用连续失败时注入一次纠偏提醒。
 *   默认关闭；开启即 steer（shadow 只写日志，作为用户开关不可感知）。
 *
 * 事实源在 sidecar（SQLite kv pi.capabilities），即改即生效；这里只做镜像。
 * set_capabilities 是全量覆盖，镜像层负责合并（见 lib/settings/capabilities-config）。
 * 高级设置（默认折叠）暴露两个最常调的阈值；留空 = 清除自定义、回落 sidecar 默认，
 * 其余参数（perTool 等）仍走协议层，避免把内部细节全摊给用户。
 */
/** sidecar 注册表生命周期 → 展示文案/状态点（未知值原样显示） */
const LIFECYCLE_META: Record<string, { labelKey: string; dot: string }> = {
  new: { labelKey: "settings.contextBudget.lifecycleNew", dot: "bg-muted-foreground/50" },
  installing: { labelKey: "settings.contextBudget.lifecycleInstalling", dot: "bg-amber-500" },
  ready: { labelKey: "settings.contextBudget.lifecycleReady", dot: "bg-emerald-500" },
  failed: { labelKey: "settings.contextBudget.lifecycleFailed", dot: "bg-destructive" },
};

export const ContextBudgetSettings: FC = () => {
  const t = useT();
  const capabilities = useCapabilitiesSnapshot();
  const toolBudget = capabilities.enabled[TOOL_BUDGET_ID] === true;
  const loopGuard = capabilities.enabled[LOOP_GUARD_ID] === true;
  const lifecycle = capabilities.lifecycle
    ? (LIFECYCLE_META[capabilities.lifecycle] ?? {
        labelKey: capabilities.lifecycle,
        dot: "bg-muted-foreground/50",
      })
    : null;

  // 模块加载那次水合可能早于 sidecar 就绪（失败不 latch）：挂载时补一次。
  // 拔开关时镜像仍会先 GET 真值，所以这里失败只是显示层晚一拍。
  useEffect(() => {
    void initCapabilitiesConfig();
  }, []);

  // 高级参数输入：空串 = 使用 sidecar 默认；快照变化（水合/保存回填）时同步显示
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [limitKb, setLimitKb] = useState("");
  const [failureThreshold, setFailureThreshold] = useState("");
  // 用户正在编辑的输入不被快照回填覆盖；未编辑的输入也不触发无意义写入
  const limitDirty = useRef(false);
  const thresholdDirty = useRef(false);
  const currentLimitKb = () => {
    const value = capabilities.settings.params[TOOL_BUDGET_ID]?.maxInlineBytes;
    return typeof value === "number" ? String(Math.round(value / 1024)) : "";
  };
  const currentThreshold = () => {
    const value = capabilities.settings.params[LOOP_GUARD_ID]?.threshold;
    return typeof value === "number" ? String(value) : "";
  };
  useEffect(() => {
    if (!limitDirty.current) setLimitKb(currentLimitKb());
    if (!thresholdDirty.current) setFailureThreshold(currentThreshold());
    // 快照参数变化时重新对齐输入框；dirty 中的输入保留用户正在打的字
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities.settings.params]);

  const commitLimitKb = () => {
    if (!limitDirty.current) return;
    const raw = limitKb.trim();
    limitDirty.current = false;
    if (!raw) {
      // 本来就是默认值：不发无意义的全量写
      if (currentLimitKb() === "") return;
      void save(() => setToolBudgetMaxInlineBytes(null));
      return;
    }
    const kb = Number(raw);
    if (
      !Number.isInteger(kb) ||
      kb < LIMIT_KB_MIN ||
      kb > LIMIT_KB_MAX
    ) {
      toast.error(t("settings.contextBudget.limitError", { min: LIMIT_KB_MIN, max: LIMIT_KB_MAX }));
      setLimitKb(currentLimitKb());
      return;
    }
    // 与当前生效值相同：不重写（也避免把协议层设置的非整 KB 值归一化）
    if (kb * 1024 === Number(capabilities.settings.params[TOOL_BUDGET_ID]?.maxInlineBytes)) {
      return;
    }
    void save(() => setToolBudgetMaxInlineBytes(kb * 1024));
  };

  const commitThreshold = () => {
    if (!thresholdDirty.current) return;
    const raw = failureThreshold.trim();
    thresholdDirty.current = false;
    if (!raw) {
      if (currentThreshold() === "") return;
      void save(() => setLoopGuardThreshold(null));
      return;
    }
    const value = Number(raw);
    if (
      !Number.isInteger(value) ||
      value < THRESHOLD_MIN ||
      value > THRESHOLD_MAX
    ) {
      toast.error(t("settings.contextBudget.thresholdError", { min: THRESHOLD_MIN, max: THRESHOLD_MAX }));
      setFailureThreshold(currentThreshold());
      return;
    }
    if (value === Number(capabilities.settings.params[LOOP_GUARD_ID]?.threshold)) {
      return;
    }
    void save(() => setLoopGuardThreshold(value));
  };

  const save = async (action: () => Promise<CapabilitiesSaveResult>) => {
    try {
      const { reloadFailures } = await action();
      if (reloadFailures.length > 0) {
        toast.warning({
          title: t("settings.contextBudget.savePartialTitle"),
          description: t("settings.contextBudget.savePartialDesc"),
        });
      }
    } catch {
      toast.error(t("settings.agentConfig.saveFailed"));
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold">{t("settings.contextBudget.title")}</h2>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {t("settings.contextBudget.desc")}
      </p>
      {lifecycle && (
        <div className="text-muted-foreground flex items-center gap-1.5 text-[13px] leading-5">
          <span className={`size-1.5 rounded-full ${lifecycle.dot}`} />
          {t("settings.contextBudget.lifecycle", { label: t(lifecycle.labelKey) })}
        </div>
      )}
      {capabilities.failures.length > 0 && (
        <div className="border-destructive/30 bg-destructive/5 flex flex-col gap-1 rounded-xl border p-3">
          <div className="text-destructive text-[13px] leading-5 font-medium">
            {t("settings.contextBudget.failures", { count: capabilities.failures.length })}
          </div>
          {capabilities.failures.map((failure) => (
            <div
              key={failure.id}
              className="text-muted-foreground text-[13px] leading-5 break-words"
            >
              <span className="text-foreground font-mono">{failure.id}</span>：
              {failure.message}
            </div>
          ))}
        </div>
      )}
      <div className="bg-muted/50 mt-1 flex flex-col rounded-2xl p-2">
        <SettingRow
          label={t("settings.contextBudget.toolBudget")}
          desc={t("settings.contextBudget.toolBudgetDesc")}
        >
          <Switch
            checked={toolBudget}
            onCheckedChange={(v) => {
              void save(() => setToolBudgetEnabled(v));
            }}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.contextBudget.loopGuard")}
          desc={t("settings.contextBudget.loopGuardDesc")}
        >
          <Switch
            checked={loopGuard}
            onCheckedChange={(v) => {
              void save(() => setLoopGuardEnabled(v));
            }}
          />
        </SettingRow>
        <div className="border-border/60 mt-1 border-t px-3 pt-2 pb-1">
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="text-muted-foreground hover:text-foreground text-[13px] leading-5 font-medium"
          >
            {advancedOpen ? t("settings.contextBudget.collapseAdvanced") : t("settings.contextBudget.advanced")}
          </button>
          {advancedOpen && (
            <div className="mt-1 flex flex-col">
              <SettingRow
                label={t("settings.contextBudget.limit")}
                desc={t("settings.contextBudget.limitDesc", { min: LIMIT_KB_MIN, max: LIMIT_KB_MAX })}
              >
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={LIMIT_KB_MIN}
                    max={LIMIT_KB_MAX}
                    inputMode="numeric"
                    value={limitKb}
                    placeholder={t("settings.contextBudget.limitPlaceholder")}
                    onChange={(e) => {
                      limitDirty.current = true;
                      setLimitKb(e.target.value);
                    }}
                    onBlur={commitLimitKb}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className="h-8 w-20 text-[13px] tabular-nums"
                  />
                  <span className="text-muted-foreground text-[13px] leading-5">KB</span>
                </div>
              </SettingRow>
              <SettingRow
                label={t("settings.contextBudget.threshold")}
                desc={t("settings.contextBudget.thresholdDesc", { min: THRESHOLD_MIN, max: THRESHOLD_MAX })}
              >
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={THRESHOLD_MIN}
                    max={THRESHOLD_MAX}
                    inputMode="numeric"
                    value={failureThreshold}
                    placeholder={t("settings.contextBudget.thresholdPlaceholder")}
                    onChange={(e) => {
                      thresholdDirty.current = true;
                      setFailureThreshold(e.target.value);
                    }}
                    onBlur={commitThreshold}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className="h-8 w-20 text-[13px] tabular-nums"
                  />
                  <span className="text-muted-foreground text-[13px] leading-5">{t("settings.contextBudget.timesUnit")}</span>
                </div>
              </SettingRow>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
