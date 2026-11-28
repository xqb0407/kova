"use client";

/**
 * 【dev-preview】antd message 的自定义样式 demo。
 * 浅色底 + 同色 2px 描边 + 实心状态图标 + 胶囊圆角，通常被叫作
 * “pill / soft badge message”，本质仍是 antd 的 message 自定义 style。
 */
import { Check, X } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import toastRHT, { Toaster as HotToaster } from "react-hot-toast";

import { EASE_OUT } from "@/lib/motion/ease";
import { cn } from "@/lib/utils";

type PillStatus = "success" | "error" | "warning" | "info";

const TOASTER_ID = "dev-preview-pill";

const PILL_STYLES: Record<PillStatus, { pill: string; icon: string }> = {
  success: {
    pill: "border-[#95de64] bg-[#f6ffed] text-[#237804] shadow-[4px_4px_0_#d9f7be] dark:border-[#274916] dark:bg-[#162312] dark:text-[#8fd460] dark:shadow-[4px_4px_0_#274916]",
    icon: "bg-[#237804] text-white dark:bg-[#49aa19] dark:text-white",
  },
  error: {
    pill: "border-[#ffccc7] bg-[#fff2f0] text-[#cf1322] shadow-[4px_4px_0_#ffccc7] dark:border-[#58181c] dark:bg-[#2a1215] dark:text-[#ff7875] dark:shadow-[4px_4px_0_#58181c]",
    icon: "bg-[#cf1322] text-white dark:bg-[#d32029] dark:text-white",
  },
  warning: {
    pill: "border-[#ffe58f] bg-[#fffbe6] text-[#d48806] shadow-[4px_4px_0_#fff1b8] dark:border-[#594214] dark:bg-[#2b2111] dark:text-[#f3cc62] dark:shadow-[4px_4px_0_#594214]",
    icon: "bg-[#d48806] text-white dark:bg-[#d89614] dark:text-white",
  },
  info: {
    pill: "border-[#91caff] bg-[#e6f4ff] text-[#0958d9] shadow-[4px_4px_0_#bae0ff] dark:border-[#15325b] dark:bg-[#111a2c] dark:text-[#65a9f3] dark:shadow-[4px_4px_0_#15325b]",
    icon: "bg-[#0958d9] text-white dark:bg-[#1668dc] dark:text-white",
  },
};

function PillIcon({
  status,
  size = "sm",
}: {
  status: PillStatus;
  size?: "sm" | "md";
}) {
  const box = size === "md" ? "h-6 w-6" : "h-5 w-5";
  const glyph = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3";
  const textSize = size === "md" ? "text-ui" : "text-[11px]";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        box,
        PILL_STYLES[status].icon,
      )}
      aria-hidden
    >
      {status === "success" ? (
        <Check className={glyph} strokeWidth={4} />
      ) : status === "error" ? (
        <X className={glyph} strokeWidth={4} />
      ) : (
        <span className={cn("font-bold leading-none", textSize)}>
          {status === "warning" ? "!" : "i"}
        </span>
      )}
    </span>
  );
}

function PillMessage({
  status,
  visible,
  id,
  children,
}: {
  status: PillStatus;
  visible: boolean;
  id?: string;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      role={status === "error" ? "alert" : "status"}
      aria-live={status === "error" ? "assertive" : "polite"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
      animate={
        visible
          ? reduce
            ? { opacity: 1 }
            : { opacity: 1, y: 0 }
          : reduce
            ? { opacity: 0 }
            : { opacity: 0, y: -6 }
      }
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className={cn(
        "pointer-events-auto flex w-fit max-w-[min(560px,calc(100vw-2rem))] items-center gap-2 rounded-xl border-2 px-4 py-2 text-sm font-semibold",
        PILL_STYLES[status].pill,
        !visible && "pointer-events-none",
      )}
    >
      <PillIcon status={status} />
      <span className="min-w-0 break-words">{children}</span>
      {id ? (
        <button
          type="button"
          onClick={() => toastRHT.dismiss(id, TOASTER_ID)}
          aria-label="Close"
          className="-mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg opacity-60 transition-colors hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </motion.div>
  );
}

function showPill(status: PillStatus, text: string) {
  toastRHT.custom(
    (toast) => (
      <PillMessage status={status} visible={toast.visible} id={toast.id}>
        {text}
      </PillMessage>
    ),
    {
      toasterId: TOASTER_ID,
      duration: 3200,
      removeDelay: 260,
    },
  );
}

function NoticeMessage({
  status,
  visible,
  id,
  title,
  description,
}: {
  status: PillStatus;
  visible: boolean;
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
}) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      role={status === "error" ? "alert" : "status"}
      aria-live={status === "error" ? "assertive" : "polite"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
      animate={
        visible
          ? reduce
            ? { opacity: 1 }
            : { opacity: 1, y: 0 }
          : reduce
            ? { opacity: 0 }
            : { opacity: 0, y: -6 }
      }
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className={cn(
        "pointer-events-auto flex w-[360px] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-xl border-2 p-4",
        PILL_STYLES[status].pill,
        !visible && "pointer-events-none",
      )}
    >
      <PillIcon status={status} size="md" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5 font-semibold break-words">{title}</p>
        {description ? (
          <p className="mt-1 text-xs leading-4 break-words opacity-75">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => {
          if (id) toastRHT.dismiss(id, TOASTER_ID);
        }}
        aria-label="Close"
        className="-mt-0.5 -mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg opacity-60 transition-colors hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

function showNotice(
  status: PillStatus,
  title: string,
  description?: string,
) {
  toastRHT.custom(
    (toast) => (
      <NoticeMessage
        status={status}
        visible={toast.visible}
        id={toast.id}
        title={title}
        description={description}
      />
    ),
    {
      toasterId: TOASTER_ID,
      duration: 4200,
      removeDelay: 260,
    },
  );
}

const BUTTON =
  "rounded-md border border-border bg-background px-3 py-1.5 text-sm transition-colors hover:bg-muted";

export default function Page() {
  const [dark, setDark] = useState(false);

  return (
    <div
      className={cn(
        "bg-background text-foreground min-h-screen px-8 pt-[320px] pb-8",
        dark && "dark",
      )}
    >
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-4">
        <div>
          <h1 className="text-lg font-semibold">
            antd message / notification · custom style
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            message 是单行胶囊样式；notification 带标题、描述和关闭按钮，共用同一套
            浅色底 + 2px 同色描边 + 4px 硬阴影 + 16px 圆角。
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON}
            onClick={() =>
              showPill("success", "This is a message with object styles")
            }
          >
            success
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() =>
              showPill("error", "This is a message with function styles")
            }
          >
            error
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => showPill("warning", "这是一条警告消息")}
          >
            warning
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => showPill("info", "这是一条信息消息")}
          >
            info
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              showPill("success", "已归档项目「kova-plugins」");
              showPill("error", "连接失败：HTTP 429");
              showPill("warning", "无法解析会话目录");
              showPill("info", "发现新版本 1.2.0");
            }}
          >
            连续四条
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() =>
              showNotice(
                "success",
                "已归档项目「kova-plugins」",
                "可在 设置 → 项目 中查看、恢复或彻底删除",
              )
            }
          >
            notice
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => toastRHT.removeAll(TOASTER_ID)}
          >
            清空
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => setDark((value) => !value)}
          >
            {dark ? "亮色预览" : "暗色预览"}
          </button>
        </div>

        <div className="mt-2 flex w-full flex-col gap-3 rounded-xl border border-dashed border-border p-6">
          <p className="text-xs font-medium text-muted-foreground">静态预览</p>
          <div className="flex flex-wrap items-center gap-3">
            <PillMessage status="success" visible>
              This is a message with object styles
            </PillMessage>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PillMessage status="error" visible>
              This is a message with function styles
            </PillMessage>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PillMessage status="warning" visible>
              这是一条警告消息
            </PillMessage>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PillMessage status="info" visible>
              这是一条信息消息
            </PillMessage>
          </div>
        </div>

        <div className="mt-2 flex w-full flex-col gap-3 rounded-xl border border-dashed border-border p-6">
          <p className="text-xs font-medium text-muted-foreground">
            静态预览 · notification
          </p>
          <NoticeMessage
            status="success"
            visible
            title="已归档项目「kova-plugins」"
            description="可在 设置 → 项目 中查看、恢复或彻底删除"
          />
          <NoticeMessage
            status="error"
            visible
            title="连接失败：HTTP 429"
            description="ZCode: exceed quota limit"
          />
          <NoticeMessage
            status="warning"
            visible
            title="无法解析会话目录"
            description="目录不存在或没有读取权限"
          />
          <NoticeMessage
            status="info"
            visible
            title="发现新版本 1.2.0"
            description="当前 1.1.24，可一键更新（装完自动重启）"
          />
        </div>
      </div>

      <HotToaster
        toasterId={TOASTER_ID}
        position="top-center"
        reverseOrder
        gutter={16}
        containerStyle={{ top: 24 }}
      />
    </div>
  );
}
