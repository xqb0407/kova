"use client";

/**
 * 【校对页】弹窗内嵌 Select：/dev-preview/select-in-dialog
 *
 * 复现「Dialog（默认 modal）里点开 Select 后条目选不中」的机制问题：
 * 与技能/MCP 市场详情弹窗同构——DialogContent + portaled Select，
 * 条目选中后回显到页面文本上，用来验证 onValueChange 是否触达。
 * 支持关闭/重开弹窗，模拟「选完工作区关掉再开就选不了」的反馈路径。
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

const ITEMS = [
  { value: "/Users/a/project-one", label: "project-one" },
  { value: "/Users/a/project-two", label: "project-two" },
];

export default function SelectInDialogPreview() {
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <p data-testid="picked-result">
        {picked ? `picked: ${picked}` : "picked: (none)"}
      </p>
      <div className="flex gap-2">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button type="button" onClick={() => setOpen(true)}>
                打开弹窗
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>选择工作区</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2 rounded-xl border px-3 py-2.5">
              <Select
                value={picked ?? undefined}
                items={ITEMS}
                onValueChange={(value) => {
                  if (value) setPicked(value);
                }}
              >
                <SelectTrigger className="h-8 w-full max-w-72">
                  <SelectValue placeholder="选择工作区…" />
                </SelectTrigger>
                <SelectContent>
                  {ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          重开弹窗
        </Button>
      </div>
    </div>
  );
}
