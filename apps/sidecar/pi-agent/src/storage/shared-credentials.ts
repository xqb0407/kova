/**
 * 共享凭据文件注入（ACP / 无宿主本地模式）：
 * 桌面端把凭据/自定义 provider/模型条目导出到 ~/.kova/credentials.json
 * （桌面是唯一写入者，整文件原子重建）；本进程启动时把镜像对齐进本地
 * SQLite，让模型目录与桌面端同源。
 *
 * 对齐是「全量镜像」语义而非纯 upsert：本地三张表里镜像没有的行会被删除
 * （桌面端的删除必须传播，否则被删的 key 在 ACP 里仍然可用）。镜像内
 * provider 的模型行走 models_replace 整包替换，行级删除天然传播。
 *
 * 优先级天然正确：pi-ai 的 stored credential > 环境变量——注入后桌面配置
 * 优先，env 兜底。文件缺失（桌面端未装/首启）与损坏都按 no-op 处理，回退
 * 现状 env 路径。host 模式（桌面生产）不走这里。
 */
import {
  defaultCredentialFilePath,
  readCredentialFile,
  type DecodedCredentialFile,
  type SharedModelRow,
} from "pi-protocol/credential-file";
import {
  credentialDelete,
  credentialList,
  credentialSet,
  customProviderDelete,
  customProvidersList,
  customProviderSetEnabled,
  customProviderUpsert,
  modelsAll,
  modelsDeleteProvider,
  modelsReplace,
  type ModelReplaceItem,
} from "./hostdb";
import { logErr } from "../log";

/** 启动时注入：读取共享文件 → 本地三张表对齐成镜像。幂等，可重复调用。 */
export async function injectSharedCredentials(
  path: string = defaultCredentialFilePath(),
): Promise<void> {
  let decoded: DecodedCredentialFile | null = null;
  try {
    decoded = readCredentialFile(path);
  } catch (err) {
    logErr("[shared-credentials] 文件损坏，忽略（回退环境变量凭据）：", err instanceof Error ? err.message : String(err));
    return;
  }
  if (!decoded) return;

  try {
    // 凭据：镜像没有的本地行删除（桌面端删除必须传播）
    const fileProviders = new Set(Object.keys(decoded.credentials).filter((p) => {
      const key = decoded!.credentials[p];
      return typeof key === "string" && key.length > 0;
    }));
    for (const provider of await credentialList()) {
      if (!fileProviders.has(provider)) await credentialDelete(provider);
    }
    for (const provider of fileProviders) {
      await credentialSet(provider, decoded.credentials[provider]);
    }

    // 自定义 provider：同上，镜像没有的删除
    const fileCpIds = new Set(
      decoded.customProviders.filter((r) => r?.id && r?.baseUrl).map((r) => r.id),
    );
    for (const row of await customProvidersList()) {
      if (!fileCpIds.has(row.id)) await customProviderDelete(row.id);
    }
    for (const row of decoded.customProviders) {
      if (!row?.id || !row?.baseUrl) continue;
      await customProviderUpsert({
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl,
        models: row.models,
        api: row.api || "openai-chat",
        autoDiscover: row.autoDiscover,
        headers: row.headers,
      });
      // upsert 不写 enabled 列（与桌面 handler 同语义）；禁用态单独落
      if (row.enabled === false) await customProviderSetEnabled(row.id, false);
    }

    // models：按 provider 分组整包替换（models_replace 是整包语义，行级删除
    // 天然传播）；镜像里没有的 provider 整体删除
    const byProvider = new Map<string, SharedModelRow[]>();
    for (const row of decoded.models) {
      if (!row?.provider || !row?.modelId) continue;
      const bucket = byProvider.get(row.provider);
      if (bucket) bucket.push(row);
      else byProvider.set(row.provider, [row]);
    }
    const fileModelProviders = new Set(byProvider.keys());
    for (const provider of new Set((await modelsAll()).map((m) => m.provider))) {
      if (!fileModelProviders.has(provider)) await modelsDeleteProvider(provider);
    }
    for (const [provider, rows] of byProvider) {
      const items: ModelReplaceItem[] = rows.map((m) => ({
        modelId: m.modelId,
        enabled: m.enabled,
        name: m.name ?? null,
        reasoning: m.reasoning ?? null,
        contextWindow: m.contextWindow ?? null,
        maxTokens: m.maxTokens ?? null,
        input: m.input ?? null,
        cost: m.cost ?? null,
        promptCache: m.promptCache ?? null,
      }));
      await modelsReplace(provider, items);
    }
  } catch (err) {
    logErr("[shared-credentials] 注入失败（本地存储写入错误）：", err instanceof Error ? err.message : String(err));
    return;
  }

  if (decoded.credentialErrors.length > 0) {
    logErr(
      "[shared-credentials] 部分凭据解密失败（KOVA_CREDENTIAL_SECRET 与写入端不一致？），已跳过：",
      decoded.credentialErrors.join("; "),
    );
  }
  logErr(
    "[shared-credentials] 已对齐桌面端共享配置（providers:",
    Object.keys(decoded.credentials).length,
    "/ custom:",
    decoded.customProviders.length,
    "/ models:",
    decoded.models.length,
    ")",
  );
}
