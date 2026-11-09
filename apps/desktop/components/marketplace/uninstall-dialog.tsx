"use client";

import type { FC } from "react";
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
import type { PluginEntry } from "@/lib/plugins/plugins";
import { useT } from "@/lib/i18n";

/** 卸载确认：支持单个与批量。点名插件身份，说明会同时移除其全部组件与开关。
 *  AlertDialog 关闭态（entries = null）children 仍会挂载，文案一律按空列表安全求值 */
export const UninstallDialog: FC<{
  entries: PluginEntry[] | null;
  onClose: () => void;
  onConfirm: (entries: PluginEntry[]) => void;
}> = ({ entries, onClose, onConfirm }) => {
  const t = useT();
  const list = entries ?? [];
  const batch = list.length > 1;
  const names =
    batch
      ? list.slice(0, 4).map((e) => e.name).join(t("marketplace.uninstall.nameSeparator")) +
        (list.length > 4
          ? t("marketplace.uninstall.andMore", { count: list.length })
          : "")
      : (list[0]?.name ?? "");
  return (
    <AlertDialog
      open={list.length > 0}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-md">
            {batch
              ? t("marketplace.uninstall.batchTitle", { count: list.length })
              : t("marketplace.uninstall.title")}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm">
            {t("marketplace.uninstall.descPrefix")}
            <span className="text-foreground font-medium">{names}</span>
            {t("marketplace.uninstall.descSuffix")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" onClick={onClose}>
            {t("marketplace.common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            size="sm"
            disabled={list.length === 0}
            onClick={() => onConfirm(list)}
          >
            {batch
              ? t("marketplace.uninstall.confirmBatch")
              : t("marketplace.common.uninstall")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
