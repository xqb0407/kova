"use client";

/**
 * 重命名任务 dialog（共享）：标题 + 单个 input + 底部取消/确认。
 * 顶栏 More 菜单与侧边栏会话列表的「重命名」都走这里。
 * 确认只由点击触发——不监听回车（输入法回车用于确认候选词，见 composer 的 IME 守卫同理）。
 */
import { useEffect, useRef, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export const RenameTaskDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前标题，打开时回填 */
  currentTitle: string;
  /** 提交改名；reject 时弹窗内显示失败信息（乐观更新由 runtime 自行回滚） */
  onRename: (title: string) => Promise<void>;
}> = ({ open, onOpenChange, currentTitle, onRename }) => {
  const [value, setValue] = useState(currentTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 打开时回填最新标题；不随 currentTitle 变化重置，避免编辑途中被异步标题更新覆盖
  const titleRef = useRef(currentTitle);
  titleRef.current = currentTitle;

  useEffect(() => {
    if (!open) return;
    setValue(titleRef.current);
    setError(null);
    setBusy(false);
  }, [open]);

  const trimmed = value.trim();

  const submit = async () => {
    if (busy || !trimmed) return;
    if (trimmed === titleRef.current) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(`重命名失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>重命名任务</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          placeholder="输入任务名称"
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
        />
        {error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button disabled={!trimmed || busy} onClick={() => void submit()}>
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
