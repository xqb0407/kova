"use client";

/** 【临时验证页】toast 视觉：/dev-preview/toast */
import { toast } from "@/components/ui/toast";

export default function Page() {
  return (
    <div className="bg-background flex min-h-screen flex-col items-start gap-3 p-8">
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 text-sm"
        onClick={() => toast.success("已复制到剪贴板")}
      >
        success
      </button>
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 text-sm"
        onClick={() =>
          toast.error(
            '连接失败: HTTP 429 - {"error":{"code":null,"message":"ZCode: exceed quota limit","param":null,"type":"rate_limit_error"}}',
          )
        }
      >
        429
      </button>
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 text-sm"
        onClick={() => {
          toast.add({
            title: "已归档项目「kova-plugins」",
            description: "可在 设置 → 项目 中查看、恢复或彻底删除",
            status: "info",
            action: { label: "撤销", onClick: () => toast.success("已恢复项目") },
          });
          toast.add({
            title: "已归档项目「kova-tools」",
            description: "可在 设置 → 项目 中查看、恢复或彻底删除",
            status: "info",
            action: { label: "撤销", onClick: () => toast.success("已恢复项目") },
          });
        }}
      >
        two notices
      </button>
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 text-sm"
        onClick={() => {
          const id = toast.success({ title: "短命 toast", duration: 120 });
          window.setTimeout(() => toast.update(id, { title: "不应复活" }), 200);
        }}
      >
        resurrect
      </button>
    </div>
  );
}
