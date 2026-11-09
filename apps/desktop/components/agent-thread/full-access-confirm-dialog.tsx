"use client";

/**
 * 「完全访问」确认弹窗：凡是把会话切到 auto 审批档的入口都先过这一张。
 *
 * 完全访问把确认环节整个拿掉——agent 可以直接改工作区外的文件、执行任意命令、
 * 访问网络。而它在权限下拉里只是五项之一，单击即生效，试探菜单时很容易顺手选中；
 * 所以这里把范围与风险摊开，二次确认后才真正下发 set_mode。取消则什么都不发，
 * 当前档位保持不变。
 *
 * 用应用自己的确认弹窗语言：AlertDialog + destructive 确认按钮 + 红色警示图标，
 * 文案按本项目「问不问/干什么」的档位口径写，不照搬外部产品的授权页。
 * 入口（mode-picker、goal-strip）只负责打开；确认后要发什么请求由调用方决定，
 * 本组件不持有业务状态。
 */
import type { FC } from "react";
import { TriangleAlertIcon } from "lucide-react";
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
import { useT } from "@/lib/i18n";

/** 这一档实际放开的三类能力（与 sidecar auto 档的工具面一致）。
 *  只存 key：模块常量不能在建表时翻译，否则语言被烧死在求值时刻。 */
const SCOPE_ITEMS = [
  {
    labelKey: "chat.fullAccess.scopeFilesLabel",
    detailKey: "chat.fullAccess.scopeFilesDetail",
  },
  {
    labelKey: "chat.fullAccess.scopeCommandsLabel",
    detailKey: "chat.fullAccess.scopeCommandsDetail",
  },
  {
    labelKey: "chat.fullAccess.scopeNetworkLabel",
    detailKey: "chat.fullAccess.scopeNetworkDetail",
  },
] as const;

export const FullAccessConfirmDialog: FC<{
  open: boolean;
  /** 确认请求在途：禁用两个按钮，避免连点重复下发 */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ open, busy = false, onCancel, onConfirm }) => {
  const t = useT();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader className="gap-2">
          <AlertDialogTitle className="flex items-center gap-2">
            <TriangleAlertIcon className="text-red-600 dark:text-red-400 size-4 shrink-0" />
            {t("chat.fullAccess.title")}
          </AlertDialogTitle>
          <AlertDialogDescription className="leading-relaxed">
            {t("chat.fullAccess.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="bg-muted/40 flex flex-col gap-2 rounded-xl p-3.5 text-xs leading-relaxed">
          {SCOPE_ITEMS.map(({ labelKey, detailKey }) => (
            <li key={labelKey} className="flex gap-2">
              <span className="bg-foreground/40 mt-1.5 size-1 shrink-0 rounded-full" />
              <span className="text-muted-foreground">
                <span className="text-foreground font-medium">{t(labelKey)}</span>
                {" —— "}
                {t(detailKey)}
              </span>
            </li>
          ))}
        </ul>

        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("chat.fullAccess.warning")}
        </p>

        <AlertDialogFooter>
          <AlertDialogCancel size="default" disabled={busy} onClick={onCancel}>
            {t("common.action.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction size="default" disabled={busy} onClick={onConfirm}>
            {t("chat.fullAccess.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
