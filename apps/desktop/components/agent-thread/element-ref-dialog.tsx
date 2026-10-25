"use client";

import { useEffect, useState, type FC } from "react";
import { CopyIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import {
  OPEN_ELEMENT_REF_EVENT,
  getElementRef,
  type ElementRefPayload,
} from "@/lib/element-refs";

/** 复制文本（clipboard API + execCommand 兜底，与地址栏复制同款） */
function copyText(text: string, what: string): void {
  const done = () => toast.add({ title: `已复制${what}`, type: "success" });
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) done();
    } catch {
      /* 静默失败 */
    }
  };
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

/**
 * 元素引用详情 Dialog 宿主（挂在 composer 树里）：
 * 监听芯片派发的 kova:element-ref-open 事件，从 lib/element-refs 取载荷，
 * 展示截图 / 选择器 / 文本 / HTML（选择器与 HTML 可一键复制）。
 */
export const ElementRefDialogHost: FC = () => {
  const [payload, setPayload] = useState<ElementRefPayload | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const key = String((e as CustomEvent<unknown>).detail ?? "");
      if (!key) return;
      const found = getElementRef(key);
      if (!found) return;
      setPayload(found);
      setOpen(true);
    };
    window.addEventListener(OPEN_ELEMENT_REF_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ELEMENT_REF_EVENT, onOpen);
  }, []);

  const rect = payload?.rect ?? null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {payload ? `${payload.tag}${payload.id ? `#${payload.id}` : ""}` : "元素"}{" "}
            <span className="text-muted-foreground font-normal">
              {rect ? `${Math.round(rect.width)} × ${Math.round(rect.height)}` : ""}
            </span>
          </DialogTitle>
          <DialogDescription className="truncate">
            {payload?.title ? `${payload.title} · ` : ""}
            {payload?.url ?? ""}
          </DialogDescription>
        </DialogHeader>

        {payload ? (
          <div className="flex min-w-0 flex-col gap-3 text-sm">
            {payload.shot ? (
              <img
                src={payload.shot}
                alt="元素截图"
                className="ring-border/60 max-h-64 w-auto max-w-full self-start rounded-md ring-1"
              />
            ) : (
              <div className="text-muted-foreground/60 text-xs">
                （该元素过大或截图失败，未附截图）
              </div>
            )}

            {payload.classes.length > 0 ? (
              <div className="text-muted-foreground flex min-w-0 flex-wrap gap-1 text-xs">
                {payload.classes.map((c) => (
                  <span key={c} className="bg-muted rounded px-1.5 py-0.5 font-mono">
                    .{c}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">选择器</span>
                <button
                  type="button"
                  onClick={() => copyText(payload.selector, "选择器")}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted ml-auto inline-flex h-5 items-center gap-1 rounded px-1.5 text-xs"
                >
                  <CopyIcon className="size-3.5" />
                  复制
                </button>
              </div>
              <code className="bg-muted/50 max-h-24 overflow-auto rounded-md px-2 py-1 font-mono text-xs break-all">
                {payload.selector || "(无)"}
              </code>
            </div>

            {payload.text ? (
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-muted-foreground text-xs">文本</span>
                <div className="bg-muted/30 max-h-24 overflow-auto rounded-md px-2 py-1 text-xs whitespace-pre-wrap">
                  {payload.text}
                </div>
              </div>
            ) : null}

            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">HTML</span>
                <button
                  type="button"
                  onClick={() => copyText(payload.html, "HTML")}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted ml-auto inline-flex h-5 items-center gap-1 rounded px-1.5 text-xs"
                >
                  <CopyIcon className="size-3.5" />
                  复制
                </button>
              </div>
              <pre className="bg-muted/50 max-h-64 overflow-auto rounded-md px-2 py-1 font-mono text-xs leading-4 whitespace-pre-wrap break-all">
                {payload.html || "(空)"}
              </pre>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
