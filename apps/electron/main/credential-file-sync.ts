/**
 * 桌面端 → 共享凭据文件同步（~/.kova/credentials.json）：
 * sidecar（ACP / 无宿主本地模式）没有钥匙串，解不开 state.db 的 aes:v1:
 * 凭据——桌面端把 credentials/custom_providers/models 三张表导出成镜像，
 * 凭据值用机器派生密钥再加密（kenc:v1:），同用户其他进程可解。
 *
 * 桌面是唯一写入者：store 启动时整文件重建一次，之后三个相关域的任何写
 * handler（见 data.ts）触发增量重建；原子写保证读者永远看到完整文件。
 * 失败只记日志：镜像缺失/过旧时 sidecar 回退环境变量凭据，不影响桌面功能。
 */
import {
  credentialFileSecret,
  defaultCredentialFilePath,
  writeCredentialFile,
} from "pi-protocol/credential-file";
import { modelsQuery } from "./data";
import type { Db, Row } from "./db";
import { decrypt } from "./secret";
import { logWarn } from "./logging";

/** 全量重建共享凭据文件。同步实现（驱动是同步的）；失败不抛。 */
export function syncCredentialFile(db: Db): void {
  try {
    // credentials：桌面密文解出明文，交给共享模块用机器派生密钥重新加密。
    // 解不开的条目（旧 Rust enc:v1: 密文等）跳过——镜像宁缺毋错。
    const credRows = db.prepare("SELECT provider, api_key FROM credentials").all() as Row[];
    const credentials: Record<string, string> = {};
    for (const row of credRows) {
      const dec = decrypt(String(row.api_key));
      if (!dec.ok) {
        logWarn(`[credential-file] ${String(row.provider)} 凭据解密失败，跳过镜像`);
        continue;
      }
      credentials[String(row.provider)] = dec.value;
    }

    const cpRows = db
      .prepare(
        "SELECT id, name, base_url, models, api, enabled, auto_discover, headers FROM custom_providers",
      )
      .all() as Row[];
    const customProviders = cpRows.map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      baseUrl: String(r.base_url ?? ""),
      models: String(r.models ?? "[]"),
      api: String(r.api ?? "openai-chat"),
      enabled: Number(r.enabled) === 1,
      autoDiscover: Number(r.auto_discover) === 1,
      headers: String(r.headers ?? "{}"),
    }));

    // modelsQuery 的输出即 SharedModelRow 形状（input/cost/promptCache 已解析）
    const models = modelsQuery(db);

    writeCredentialFile(
      defaultCredentialFilePath(),
      { credentials, customProviders, models },
      credentialFileSecret(),
    );
  } catch (err) {
    logWarn(
      `[credential-file] 共享凭据文件同步失败（sidecar 将回退环境变量凭据）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
