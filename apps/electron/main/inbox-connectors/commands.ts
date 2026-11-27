/**
 * 收件箱来源 IPC 命令（渲染层 invoke）。
 * token 只从渲染层进、绝不回传；所有响应都过 config-store 的公开快照。
 */
import type {
  InboxConnectorPrefsInput,
  InboxConnectorSaveInput,
  InboxConnectorTestInput,
} from "pi-protocol";
import { ConnectorError } from "./errors";
import {
  fetchInboxExternalDetail,
  fetchInboxPullRequestChecks,
  fetchInboxPullRequestDiff,
  postInboxExternalComment,
  runInboxPullRequestAction,
} from "./detail";
import {
  deleteInboxConnector,
  listInboxConnectors,
  saveInboxConnector,
  syncInboxConnector,
  testInboxConnector,
  updateInboxConnectorPrefs,
} from "./manager";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectorError("config", `${name} 不能为空`);
  }
  return value;
}

export function setupInboxConnectorCommands(
  register: (name: string, fn: (args: any) => unknown) => void,
): void {
  register("inbox_connectors_list", () => listInboxConnectors());

  register("inbox_connectors_save", (args) => {
    const input = args?.input as InboxConnectorSaveInput | undefined;
    if (!input || typeof input !== "object") {
      throw new ConnectorError("config", "缺少连接器配置");
    }
    return saveInboxConnector(input);
  });

  register("inbox_connectors_delete", (args) =>
    deleteInboxConnector(requireString(args?.id, "id")),
  );

  register("inbox_connectors_test", async (args) => {
    const input = args?.input as InboxConnectorTestInput | undefined;
    if (!input || typeof input !== "object") {
      throw new ConnectorError("config", "缺少测试配置");
    }
    return testInboxConnector(input);
  });

  register("inbox_connectors_sync", (args) =>
    syncInboxConnector(requireString(args?.id, "id")),
  );

  /** 选中外部条目时按需拉取正文/评论（不落收件箱 journal）。 */
  register("inbox_connector_detail", (args) =>
    fetchInboxExternalDetail(args?.input),
  );

  /** PR/MR 只读评审面：diff / checks 独立按需拉取并缓存。 */
  register("inbox_connector_pr_diff", (args) =>
    fetchInboxPullRequestDiff(args?.input),
  );
  register("inbox_connector_pr_checks", (args) =>
    fetchInboxPullRequestChecks(args?.input),
  );

  /** 外部系统写操作：评论/回复、PR 动作；成功后主进程负责失效详情缓存。 */
  register("inbox_connector_comment", (args) =>
    postInboxExternalComment(args?.input),
  );
  register("inbox_connector_pr_action", (args) =>
    runInboxPullRequestAction(args?.input),
  );

  /** 通知偏好：静音/分类开关，只改偏好不动连接配置。 */
  register("inbox_connectors_update_prefs", (args) => {
    const input = args?.input as InboxConnectorPrefsInput | undefined;
    if (!input || typeof input !== "object") {
      throw new ConnectorError("config", "缺少通知偏好配置");
    }
    return updateInboxConnectorPrefs(input);
  });
}
