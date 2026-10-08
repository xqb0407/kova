"use client";

/**
 * 【校对页】从其他工具导入模型服务 —— 弹窗列表的版式校对。
 *
 * 扫描走 sidecar，浏览器里连不上，所以这里用 previewScan 灌一份**照本机真实
 * 扫描结果**造的夹具（四个来源、CC-Switch 二十条、含同名冲突与停用行），
 * 专门看列表在真实规模下的密度、分组折叠、勾选后的二级/三级展开。
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
    mk("opencode", "go", "OpenCode Go", "https://opencode.ai/zen/go/v1", ["glm-5.2", "kimi-k3", "deepseek-v4-pro", "glm-5.1", "grok-4.5"], { apiKey: "sk-V5hgb0CqYFpP4TD52sIGQ4UX77DL" }),
    mk("opencode", "x", "token.sensenova.cn", "https://token.sensenova.cn/v1", ["deepseek-v4-flash", "glm-5.2", "sensenova-6.7-flash-lite"], { apiKey: "sk-FkNyaiGKCIKvwyqfj1SNiUORElbS9" }),
    mk("opencode", "xianyu", "aigw-gzgy2.cucloud.cn", "https://aigw-gzgy2.cucloud.cn:8443/v1", ["glm-5.1", "kimi-k2.6"], { apiKey: "sk-sp-jVkKTz6ry5VtmsZPHMOVkfIHl", disabled: true }),
    mk("codex", "custom", "aigw-gzgy2.cucloud.cn", "https://aigw-gzgy2.cucloud.cn:8443/v1", ["glm-5.1"], { apiKey: "sk-sp-jVkKTz6ry5VtmsZPHMOVkfIHl", api: "openai-responses" }),
    mk("zcode", "dbe90d86", "DeepSeek", "https://api.deepseek.com/v1", ["deepseek-v4-flash", "deepseek-v4-pro"], { apiKey: "sk-96e7f07d2ef8463a8680f5ca001a90" }),
    mk("zcode", "8a733d87", "阿里云 CodingPlan", "https://coding.dashscope.aliyuncs.com/v1", ["qwen3.7-plus", "glm-5", "kimi-k2.5"], { apiKey: "sk-sp-ade58ead4a684f4f85687056f" }),
    mk("zcode", "f0c3fcb2", "llmstudio", "http://127.0.0.1:1234/v1", ["qwen3-coder"], {}),
    // CC-Switch：claude 分支（本机真实存在的两个 Anthropic 中转）
    mk("ccswitch", "claude:8fe2c23e", "阿里", "https://coding.dashscope.aliyuncs.com/apps/anthropic", ["glm-5", "qwen3.7-plus"], { apiKey: "sk-sp-ade58ead4a684f4f85687056ff", api: "anthropic-messages" }),
    mk("ccswitch", "claude:9b603667", "日日新", "https://token.sensenova.cn", [], { api: "anthropic-messages" }),
    mk("ccswitch", "claude:b8e92942", "献鱼", "https://aigw-gzgy2.cucloud.cn:8443", ["glm-5.1"], { apiKey: "sk-sp-jVkKTz6ry5VtmsZPHMOVkfIHl9d", api: "anthropic-messages" }),
    // CC-Switch：codex 分支
    mk("ccswitch", "codex:e31ef3c2", "aigw-gzgy2.cucloud.cn", "https://aigw-gzgy2.cucloud.cn:8443/v1", ["glm-5.1"], { apiKey: "sk-sp-jVkKTz6ry5VtmsZPHMOVkfIHl9d", api: "openai-responses" }),
    mk("ccswitch", "codex:114cdbfc", "商汤", "https://token.sensenova.cn/v1", ["deepseek-v4-flash"], { apiKey: "sk-96e7f07d2ef8463a8680f5ca001a90", api: "openai-responses" }),
    mk("ccswitch", "codex:cabb752a", "codex.hiyo.top", "https://codex.hiyo.top/v1", ["gpt-5.6-sol"], { api: "openai-responses" }),
    // CC-Switch：opencode 分支
    mk("ccswitch", "opencode:o1", "OpenCode Go", "https://opencode.ai/zen/go/v1", ["glm-5.2", "kimi-k2.7-code", "deepseek-v4-pro"], { apiKey: "sk-V5hgb0CqYFpP4TD52sIGQ4UX77DL" }),
    mk("ccswitch", "opencode:o3", "token.sensenova.cn", "https://token.sensenova.cn/v1", ["deepseek-v4-flash", "glm-5.2"], { apiKey: "sk-FkNyaiGKCIKvwyqfj1SNiUORElbS9" }),
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
          { name: "DeepSeek", providerId: "custom-deepseek" },
          { name: "阿里", providerId: "custom-ali" },
          { name: "商汤", providerId: "custom-shangtang" },
        ]}
        previewScan={SCAN}
      />
    </div>
  );
}