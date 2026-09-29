"use client";

import { useCallback, useState, type FC, type ReactNode } from "react";
import { Loader2Icon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import type { PluginEntry } from "@/lib/plugins/plugins";
import {
  enableUiDesignPlugin,
  installUiDesignPlugin,
  probeUiDesignGate,
} from "@/lib/pi/design-mode-gate";

/**
 * 设计模式门禁（useEnsureUiDesignPlugin）：切换 design 档前确保 ui-design 插件
 * 已装已启用——已装禁用 → 询问启用；未装 → 询问安装（等结果帧再放行）；市场
 * 里找不到来源 → 指引去插件市场页手动安装；sidecar 不可达 → 放行（degraded
 * 语义：UI 切换照常，提示词由下一次连接收敛）。
 * 用法（顶栏切换器与设置页同款）：
 *   const { ensure, dialog } = useEnsureUiDesignPlugin();
 *   if (await ensure()) void setAppMode("design");
 *   ... 渲染 {dialog}
 */

type GateDialog =
  | { phase: "enable"; entry: PluginEntry }
  | { phase: "install"; marketplaceId: string }
  | { phase: "no-source" };

export function useEnsureUiDesignPlugin(): {
  ensure: () => Promise<boolean>;
  dialog: ReactNode;
} {
  const [asking, setAsking] = useState<GateDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolver, setResolver] = useState<((v: boolean) => void) | null>(null);

  const settle = useCallback(
    (value: boolean) => {
      setBusy(false);
      setAsking(null);
      resolver?.(value);
      setResolver(null);
    },
    [resolver],
  );

  const ensure = useCallback(async (): Promise<boolean> => {
    const state = await probeUiDesignGate();
    switch (state.kind) {
      case "ready":
      case "unreachable":
        return true;
      case "disabled":
        return new Promise<boolean>((resolve) => {
          setResolver(() => resolve);
          setAsking({ phase: "enable", entry: state.entry });
        });
      case "missing":
        if (!state.installMarketplaceId) {
          return new Promise<boolean>((resolve) => {
            setResolver(() => resolve);
            setAsking({ phase: "no-source" });
          });
        }
        return new Promise<boolean>((resolve) => {
          setResolver(() => resolve);
          setAsking({ phase: "install", marketplaceId: state.installMarketplaceId! });
        });
    }
  }, []);

  const confirm = useCallback(async () => {
    if (!asking || busy) return;
    setBusy(true);
    try {
      if (asking.phase === "enable") {
        await enableUiDesignPlugin(asking.entry);
        settle(true);
      } else if (asking.phase === "install") {
        const result = await installUiDesignPlugin(asking.marketplaceId);
        if (result.ok) {
          settle(true);
        } else {
          toast.error({
            title: "UI 设计插件安装失败",
            description: result.errorText,
          });
          settle(false);
        }
      } else {
        settle(false);
      }
    } catch (err) {
      toast.error({
        title: "UI 设计插件操作失败",
        description: err instanceof Error ? err.message : String(err),
      });
      settle(false);
    }
  }, [asking, busy, settle]);

  const dialog = (
    <Dialog open={asking !== null} onOpenChange={(open) => !open && !busy && settle(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {asking?.phase === "enable"
              ? "启用 UI 设计插件"
              : asking?.phase === "install"
                ? "安装 UI 设计插件"
                : "需要 UI 设计插件"}
          </DialogTitle>
          <DialogDescription>
            {asking?.phase === "enable" ? (
              <>
                设计模式依赖「UI 设计」插件（设计稿面板 + MCP 工具 + 平台规范技能），
                当前已被禁用。启用后即可切换到设计模式。
              </>
            ) : asking?.phase === "install" ? (
              <>
                设计模式依赖「UI 设计」插件（设计稿面板 + MCP 工具 + 平台规范技能），
                当前尚未安装。将从插件市场安装并切换到设计模式。
              </>
            ) : (
              <>
                设计模式依赖「UI 设计」插件（设计稿面板 + MCP 工具 + 平台规范技能）。
                已添加的插件市场里没有该插件，请到「插件市场」页添加来源并安装后重试。
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {asking?.phase === "no-source" ? (
            <Button size="sm" onClick={() => settle(false)}>
              知道了
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => settle(false)}>
                取消
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void confirm()}>
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                {asking?.phase === "enable"
                  ? "启用并继续"
                  : busy
                    ? "安装中…"
                    : "安装并继续"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { ensure, dialog };
}
