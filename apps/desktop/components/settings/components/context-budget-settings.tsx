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
export const ContextBudgetSettings: FC = () => {
  const capabilities = useCapabilitiesSnapshot();
  const toolBudget = capabilities.enabled[TOOL_BUDGET_ID] === true;
  const loopGuard = capabilities.enabled[LOOP_GUARD_ID] === true;

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
      toast.error(`外置阈值需为 ${LIMIT_KB_MIN}–${LIMIT_KB_MAX} 之间的整数`);
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
      toast.error(`提醒次数需为 ${THRESHOLD_MIN}–${THRESHOLD_MAX} 之间的整数`);
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
          title: "部分会话将在下一轮生效",
          description: "有会话正在运行，本次开关对它们在下一次请求时生效。",
        });
      }
    } catch {
      toast.error("保存失败，请重试");
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold">上下文预算</h2>
      <p className="text-muted-foreground text-sm">
        控制对话上下文里放什么、放多少。两道闸都即时生效，会话进行中也可以切换。
      </p>
      <div className="bg-muted/50 mt-1 flex flex-col rounded-2xl p-2">
        <SettingRow
          label="大输出外置"
          desc="超过阈值（默认 32KB，可在高级设置中调整）的工具输出会存为会话文件，对话中只保留可回查的文件路径；AI 按需检索，长会话更省上下文。关闭后不再外置（仍受各工具自身的输出上限约束）。"
        >
          <Switch
            checked={toolBudget}
            onCheckedChange={(v) => {
              void save(() => setToolBudgetEnabled(v));
            }}
          />
        </SettingRow>
        <SettingRow
          label="重复失败提醒（实验性）"
          desc="AI 连续重复同一个失败的调用时，向它注入一次纠偏提醒。实验性功能：提醒文案与触发阈值可能随使用反馈调整。"
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
            className="text-muted-foreground hover:text-foreground text-xs font-medium"
          >
            {advancedOpen ? "收起高级设置" : "高级设置"}
          </button>
          {advancedOpen && (
            <div className="mt-1 flex flex-col">
              <SettingRow
                label="外置阈值"
                desc={`超过该大小的工具输出才会存为文件；留空使用默认（32KB），可设 ${LIMIT_KB_MIN}–${LIMIT_KB_MAX} KB。`}
              >
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={LIMIT_KB_MIN}
                    max={LIMIT_KB_MAX}
                    inputMode="numeric"
                    value={limitKb}
                    placeholder="默认 32"
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
                  <span className="text-muted-foreground text-xs">KB</span>
                </div>
              </SettingRow>
              <SettingRow
                label="提醒触发次数"
                desc={`同一工具调用连续失败几次后注入纠偏提醒；留空使用默认（3 次），可设 ${THRESHOLD_MIN}–${THRESHOLD_MAX} 次。`}
              >
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={THRESHOLD_MIN}
                    max={THRESHOLD_MAX}
                    inputMode="numeric"
                    value={failureThreshold}
                    placeholder="默认 3"
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
                  <span className="text-muted-foreground text-xs">次</span>
                </div>
              </SettingRow>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
