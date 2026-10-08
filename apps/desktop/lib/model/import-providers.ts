"use client";

import { piRequest, type PiCustomApiKind, type PiImportedProvider, type PiImportSourceStatus } from "@/lib/pi/pi-bridge";
import { refreshPiModels } from "@/lib/pi/pi-models";

/**
 * 从本机其它工具（opencode / Codex / ZCode）导入模型服务配置的渲染进程侧封装。
 *
 * 分工：sidecar 只做"扫描 + 解析"（scan_provider_imports，纯只读），写入一律
 * 复用既有的 add_custom_provider —— 它已经处理好 id 生成、目录注册、凭据写入、
 * 停用语义，导入不该另开一条写入通道。
 *
 * 明文密钥的生命周期（重要）：candidates 里的 apiKey 是明文，随扫描结果一次性
 * 进入组件 state，仅用于构造 add_custom_provider 的入参。它不进 localStorage、
 * 不进任何持久化层，弹窗关闭即随 state 丢弃。
 */

export type ProviderImportScanResult = {
  candidates: PiImportedProvider[];
  sources: PiImportSourceStatus[];
};

/** 扫本机其它工具的配置。解析失败按来源收敛成 sources[].error，不整体抛错 */
export async function scanProviderImports(): Promise<ProviderImportScanResult> {
  const res = await piRequest<{
    type: "provider_import_candidates";
    candidates: PiImportedProvider[];
    sources: PiImportSourceStatus[];
  }>({ type: "scan_provider_imports" });
  return { candidates: res.candidates, sources: res.sources };
}

/** 一条候选导入后的结果：成功给出 Kova 里的 providerId */
export type ImportOneResult = { ok: true; providerId: string } | { ok: false; error: string };

/**
 * 导入一条候选。providerId 有值 = 覆盖 Kova 里的既有服务（同名冲突时用户选
 * "覆盖"才传），缺省 = 新建。
 *
 * apiKey 传空串表示"不碰密钥"——add_custom_provider 的空串语义是保留原有
 * 凭据，所以覆盖一个已有 key 的服务时，用户不勾"带密钥"就不会把它抹掉。
 *
 * withApiKey=false 时强制传空串：源文件里明明有 key、但用户没勾，就不能顺手带过去。
 */
export async function importOneProvider(input: {
  candidate: PiImportedProvider;
  withApiKey: boolean;
  /** 覆盖目标；缺省新建 */
  providerId?: string;
}): Promise<ImportOneResult> {
  const { candidate, withApiKey, providerId } = input;
  try {
    const res = await piRequest<{ type: "custom_provider"; provider: string }>({
      type: "add_custom_provider",
      ...(providerId ? { providerId } : {}),
      name: candidate.name,
      baseUrl: candidate.baseUrl,
      apiKey: withApiKey ? (candidate.apiKey ?? "") : "",
      api: candidate.api satisfies PiCustomApiKind,
      // contextWindow 只在来源真记了才有（cc-switch 的 modelCatalog）；
      // 缺省不传 = add_custom_provider 存 null → Kova 侧回落内置目录种子
      models: candidate.models.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      })),
    });
    // 沿用来源侧的停用意图：add_custom_provider 建完即启用，来源侧标了停用的
    // 服务（如 opencode 的 disabled_providers）要再 toggle 一次，否则会以启用
    // 状态进模型目录 —— 那正是用户当初在源工具里关掉它的原因
    if (candidate.disabled) {
      await piRequest({ type: "toggle_custom_provider", provider: res.provider, enabled: false });
    }
    return { ok: true, providerId: res.provider };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 导入成功后刷新模型目录，让选择器与设置页立刻看到新服务 */
export function refreshAfterImport() {
  refreshPiModels();
}