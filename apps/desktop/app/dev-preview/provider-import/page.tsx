"use client";

/**
 * 【校对页】从其他工具导入模型服务 —— 弹窗列表的版式校对。
 *
 * 扫描走 sidecar，浏览器里连不上，所以这里用 previewScan 灌一份**全虚构**的
 * 夹具（四个来源、多条候选、含同名冲突与停用行），专门看列表在真实规模下的
 * 密度、分组折叠、勾选后的二级/三级展开。夹具不得写成本机配置的快照
 * （URL/名称/密钥一律用 example 域与占位符）。
 *
 * 夹具不覆盖「一个都没扫到」的空态文案——那种情况代码路径与列表版式无关。
 */

import { useState } from "react";
import { ModelImportDialog } from "@/components/settings/components/model-import-dialog";
import type { ProviderImportScanResult } from "@/lib/model/import-providers";

const mk = (
  source: ProviderImportScanResult["candidates"][number]["source"],
  sourceKey: string,
  name: string,
  baseUrl: string,
  models: string[],
  opts: { apiKey?: string; api?: "openai-chat" | "openai-responses" | "anthropic-messages"; disabled?: boolean } = {},
) => ({
  source,
  sourceKey,
  sourceLabel: "preview",
  name,
  baseUrl,
  api: opts.api ?? "openai-chat",
  ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
  models: models.map((id, i) => ({ id, name: i === 0 ? id : undefined })),
  disabled: opts.disabled ?? false,
});

const SCAN: ProviderImportScanResult = {
  candidates: [
    mk("opencode", "go", "示例网关 Go", "https://gateway-a.example.com/v1", ["demo-chat", "demo-pro", "demo-lite", "demo-coder"], { apiKey: "sk-redacted-demo" }),
    mk("opencode", "x", "示例网关 X", "https://gateway-b.example.com/v1", ["demo-flash", "demo-pro", "demo-lite"], { apiKey: "sk-redacted-demo" }),
    mk("opencode", "xianyu", "示例内网网关", "https://gw.example.internal:8443/v1", ["demo-chat", "demo-coder"], { apiKey: "sk-redacted-demo", disabled: true }),
    mk("codex", "custom", "示例内网网关", "https://gw.example.internal:8443/v1", ["demo-chat"], { apiKey: "sk-redacted-demo", api: "openai-responses" }),
    mk("zcode", "a1b2c3d4", "示例云", "https://api.example-cloud.cn/v1", ["demo-flash", "demo-pro"], { apiKey: "sk-redacted-demo" }),
    mk("zcode", "b2c3d4e5", "示例编码计划", "https://coding.example-cloud.cn/v1", ["demo-plus", "demo-chat", "demo-coder"], { apiKey: "sk-redacted-demo" }),
    mk("zcode", "c3d4e5f6", "本地推理", "http://127.0.0.1:1234/v1", ["demo-coder"], {}),
    // CC-Switch：claude 分支（含与现有服务同名冲突、无 key 行）
    mk("ccswitch", "claude:d4e5f6a7", "示例云", "https://coding.example-cloud.cn/apps/anthropic", ["demo-plus", "demo-chat"], { apiKey: "sk-redacted-demo", api: "anthropic-messages" }),
    mk("ccswitch", "claude:e5f6a7b8", "示例中转甲", "https://relay-a.example.com", [], { api: "anthropic-messages" }),
    mk("ccswitch", "claude:f6a7b8c9", "示例中转乙", "https://relay-b.example.com", ["demo-chat"], { apiKey: "sk-redacted-demo", api: "anthropic-messages" }),
    // CC-Switch：codex 分支
    mk("ccswitch", "codex:a7b8c9d0", "示例内网网关", "https://gw.example.internal:8443/v1", ["demo-chat"], { apiKey: "sk-redacted-demo", api: "openai-responses" }),
    mk("ccswitch", "codex:b8c9d0e1", "示例云", "https://api.example-cloud.cn/v1", ["demo-flash"], { apiKey: "sk-redacted-demo", api: "openai-responses" }),
    mk("ccswitch", "codex:c9d0e1f2", "示例海外网关", "https://gw.example.org/v1", ["demo-sol"], { api: "openai-responses" }),
    // CC-Switch：opencode 分支
    mk("ccswitch", "opencode:o1", "示例网关 Go", "https://gateway-a.example.com/v1", ["demo-chat", "demo-coder", "demo-pro"], { apiKey: "sk-redacted-demo" }),
    mk("ccswitch", "opencode:o3", "示例网关 X", "https://gateway-b.example.com/v1", ["demo-flash", "demo-pro"], { apiKey: "sk-redacted-demo" }),
  ],
  sources: [
    { source: "opencode", paths: ["~/.config/opencode/opencode.json"], foundPath: "x", count: 3, error: null },
    { source: "codex", paths: ["~/.codex/config.toml"], foundPath: "x", count: 1, error: null },
    { source: "zcode", paths: ["~/.zcode/v2/provider_config.json"], foundPath: "x", count: 3, error: null },
    { source: "ccswitch", paths: ["~/.cc-switch/cc-switch.db"], foundPath: "x", count: 8, error: null },
  ],
};

export default function ProviderImportPreview() {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex min-h-dvh flex-col items-center gap-4 p-8">
      <p className="text-muted-foreground text-sm">
        导入弹窗版式校对（{SCAN.candidates.length} 条候选，其中 3 条与 Kova 现有服务同名）
      </p>
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 text-sm"
        onClick={() => setOpen(true)}
      >
        打开弹窗
      </button>
      <ModelImportDialog
        open={open}
        onOpenChange={setOpen}
        existingProviders={[
          { name: "示例云", providerId: "custom-demo-cloud" },
          { name: "示例网关 Go", providerId: "custom-demo-gw" },
          { name: "示例内网网关", providerId: "custom-demo-internal" },
        ]}
        previewScan={SCAN}
      />
    </div>
  );
}