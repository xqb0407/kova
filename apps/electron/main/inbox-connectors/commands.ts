/**
 * 收件箱来源 IPC 命令（渲染层 invoke）。
 * token 只从渲染层进、绝不回传；所有响应都过 config-store 的公开快照。
 */
import type {
  InboxConnectorSaveInput,
  InboxConnectorTestInput,
} from "pi-protocol";
import { ConnectorError } from "./errors";
import { fetchInboxExternalDetail } from "./detail";
import {
  deleteInboxConnector,
  listInboxConnectors,
  saveInboxConnector,
  syncInboxConnector,
  testInboxConnector,
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
}
