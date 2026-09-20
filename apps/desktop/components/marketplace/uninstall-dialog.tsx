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

/** 卸载确认：点名插件身份，说明会同时移除其全部组件并停用相关开关 */
export const UninstallDialog: FC<{
  entry: PluginEntry | null;
  onClose: () => void;
  onConfirm: (entry: PluginEntry) => void;
}> = ({ entry, onClose, onConfirm }) => (
  <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>卸载插件</DialogTitle>
        <DialogDescription>
          将卸载{" "}
          <span className="text-foreground font-medium">{entry?.name ?? ""}</span>{" "}
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
          onClick={() => entry && onConfirm(entry)}
        >
          卸载
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
