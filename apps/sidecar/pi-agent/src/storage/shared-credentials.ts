/**
 * 共享凭据文件注入（ACP / 无宿主本地模式）：
 * 桌面端把凭据/自定义 provider/模型条目导出到 ~/.kova/credentials.json
 * （桌面是唯一写入者，整文件原子重建）；本进程启动时把镜像 upsert 进本地
 * SQLite，让模型目录与桌面端同源。
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
  credentialSet,
  customProviderSetEnabled,
  customProviderUpsert,
  modelsReplace,
  type ModelReplaceItem,
} from "./hostdb";
import { logErr } from "../log";

/** 启动时注入：读取共享文件 → upsert 本地三张表。幂等，可重复调用。 */
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
    for (const [provider, key] of Object.entries(decoded.credentials)) {
      if (!provider || !key) continue;
      await credentialSet(provider, key);
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
    // models 按 provider 分组整包替换（models_replace 是整包语义，缺行 = 删除）
    const byProvider = new Map<string, SharedModelRow[]>();
    for (const row of decoded.models) {
      if (!row?.provider || !row?.modelId) continue;
      const bucket = byProvider.get(row.provider);
      if (bucket) bucket.push(row);
      else byProvider.set(row.provider, [row]);
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
    "[shared-credentials] 已注入桌面端共享配置（providers:",
    Object.keys(decoded.credentials).length,
    "/ custom:",
    decoded.customProviders.length,
    "/ models:",
    decoded.models.length,
    ")",
  );
}
