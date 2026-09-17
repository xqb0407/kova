"use client";

/**
 * 通用 Markdown 文本编辑 dialog：编辑（CodeMirror）/ 预览（Streamdown）两个页签。
 * 个性化设置的人设、自定义指令、自定义回复风格共用（next/dynamic 按需加载，重依赖
 * CodeMirror/Streamdown 不进设置页首屏包）。保存只回调 onSave，走调用方的
 * 防抖自动保存链路。打开时回填当前值；编辑途中不随外部值重置（重命名 dialog 同款守卫）。
 * extraContent 可在标题下方附加控件（风格名称输入），与正文一并保存由调用方组装；
 * onRestore 在左下加「恢复默认」动作（内置风格弹窗用，删除覆盖记录即恢复）。
 */
import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { MarkdownEditor } from "@/components/code/cm-markdown-editor";

const MarkdownEditDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** 当前值，打开时回填 */
  value: string;
  /** 保存新内容（调用方的防抖自动保存） */
  onSave: (next: string) => void;
  /** 输入上限：超限静默截断；缺省不限制（身份文件类字段存全局 md 文件，
   *  内容上限由 sidecar 注入预算控制，弹窗不截断外部写入的长内容） */
  maxLength?: number;
  placeholder?: string;
  /** 打开时落在哪个页签（记忆文件浏览默认预览，其余场景缺省编辑） */
  initialTab?: "edit" | "preview";
  /** 标题与页签之间的附加区（自定义风格弹窗在此放「风格名称」输入；不受 maxLength 约束） */
  extraContent?: ReactNode;
  /** 左下「恢复」动作（内置风格弹窗在此恢复默认文案；点击即关闭弹窗） */
  onRestore?: () => void;
  restoreLabel?: string;
}> = ({ open, onOpenChange, title, value, onSave, maxLength, placeholder, initialTab, extraContent, onRestore, restoreLabel }) => {
  const [text, setText] = useState(value);
  const [tab, setTab] = useState("edit");
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!open) return;
    setText(valueRef.current);
    setTab(initialTab ?? "edit");
  }, [open, initialTab]);

  const cap = (s: string) => (maxLength === undefined ? s : s.slice(0, maxLength));

  const save = () => {
    onSave(cap(text));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {extraContent}
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(String(v))}
          className="min-w-0"
        >
          <TabsList className="h-8 rounded-full p-[3px]">
            <TabsTrigger
              value="edit"
              className="rounded-full px-3 py-0 text-xs"
            >
              编辑
            </TabsTrigger>
            <TabsTrigger
              value="preview"
              className="rounded-full px-3 py-0 text-xs"
            >
              预览
            </TabsTrigger>
          </TabsList>
          <TabsContent value="edit">
            <div className="bg-muted/60 h-80 overflow-hidden rounded-lg border">
              <MarkdownEditor
                className="h-full"
                value={text}
                height="100%"
                placeholder={placeholder}
                onChange={(next) => setText(cap(next))}
              />
            </div>
          </TabsContent>
          <TabsContent value="preview">
            <div className="bg-muted/60 h-80 overflow-y-auto rounded-lg border p-3">
              {text.trim() ? (
                <MarkdownText text={text} />
              ) : (
                <p className="text-muted-foreground text-sm">暂无内容</p>
              )}
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter className="items-center sm:justify-between">
          <div className="order-first flex items-center gap-3">
            {onRestore && (
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground px-2"
                onClick={() => {
                  onRestore();
                  onOpenChange(false);
                }}
              >
                {restoreLabel ?? "恢复默认"}
              </Button>
            )}
            <span className="text-muted-foreground text-xs tabular-nums">
              {maxLength === undefined ? `${text.length} 字` : `${text.length} / ${maxLength}`}
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={save}>保存</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default MarkdownEditDialog;
