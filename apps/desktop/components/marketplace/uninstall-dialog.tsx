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

/** 卸载确认：支持单个与批量。点名插件身份，说明会同时移除其全部组件与开关。
 *  AlertDialog 关闭态（entries = null）children 仍会挂载，文案一律按空列表安全求值 */
export const UninstallDialog: FC<{
  entries: PluginEntry[] | null;
  onClose: () => void;
  onConfirm: (entries: PluginEntry[]) => void;
}> = ({ entries, onClose, onConfirm }) => {
  const list = entries ?? [];
  const batch = list.length > 1;
  const names =
    batch
      ? list.slice(0, 4).map((e) => e.name).join("、") +
        (list.length > 4 ? ` 等 ${list.length} 个` : "")
      : (list[0]?.name ?? "");
  return (
    <AlertDialog
      open={list.length > 0}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-md">{batch ? `卸载 ${list.length} 个插件` : "卸载插件"}</AlertDialogTitle>
          <AlertDialogDescription className="text-sm">
            将卸载 <span className="text-foreground font-medium">{names}</span>{" "}
            及其包含的全部技能、MCP 服务器、子智能体与钩子。来源市场不受影响，
            之后可以随时重新安装。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" onClick={onClose}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            size="sm"
            disabled={list.length === 0}
            onClick={() => onConfirm(list)}
          >
            {batch ? "全部卸载" : "卸载"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
