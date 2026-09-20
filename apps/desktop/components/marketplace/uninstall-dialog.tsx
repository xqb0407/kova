"use client";

import type { FC } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { PluginEntry } from "@/lib/plugins";

/** 卸载确认：支持单个与批量。点名插件身份，说明会同时移除其全部组件与开关。
 *  Dialog 关闭态（entries = null）children 仍会挂载，文案一律按空列表安全求值 */
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
    <Dialog open={list.length > 0} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{batch ? `卸载 ${list.length} 个插件` : "卸载插件"}</DialogTitle>
          <DialogDescription>
            将卸载 <span className="text-foreground font-medium">{names}</span>{" "}
            及其包含的全部技能、MCP 服务器、子智能体与钩子。来源市场不受影响，
            之后可以随时重新安装。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={list.length === 0}
            onClick={() => onConfirm(list)}
          >
            {batch ? "全部卸载" : "卸载"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
