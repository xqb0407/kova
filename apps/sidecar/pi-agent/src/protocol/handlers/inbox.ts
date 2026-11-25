/**
 * Agent Inbox 协议命令（docs/agent-inbox.md §6）：
 * list_inbox / inbox_item / inbox_action / inbox_update / inbox_external_sync。
 * 治理动作的语义在 inbox/index.ts；这里只做线协议参数校验与应答。
 */
import {
  inboxActionSchema,
  inboxExternalSyncRequestSchema,
  type InboxAction,
  type InboxFilter,
  type InboxUpdatePatch,
} from "pi-protocol";
import {
  InboxError,
  applyInboxAction,
  getInboxDetail,
  listInboxPayload,
  reconcileInboxSources,
  syncExternalInboxItems,
  updateInboxPayload,
  updateInboxPayloadAll,
} from "../../inbox/index";
import { getInboxCounts, getInboxItem } from "../../inbox/store";
import { send } from "../stream";
import type { CommandHandler } from "../command";

/** InboxError 带结构化 code；其余错误交还 handleLine 的通用出口 */
function sendInboxError(reqId: string, error: unknown): void {
  if (!(error instanceof InboxError)) throw error;
  send({
    id: reqId,
    type: "error",
    errorText: error.message,
    error: {
      code: error.code,
      source: "runtime",
      retryable: false,
    },
  });
}

function parseFilter(raw: unknown): InboxFilter | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return raw as InboxFilter;
}

export const handlers: Record<string, CommandHandler> = {
  list_inbox: async (reqId, msg) => {
    try {
      // 重启后先做一次源对账，避免审批/提问/目标暂停项永久挂在待关注
      await reconcileInboxSources();
      const limit = typeof msg.limit === "number" ? msg.limit : undefined;
      const cursor = typeof msg.cursor === "string" ? msg.cursor : undefined;
      const result = listInboxPayload(parseFilter(msg.filter), limit, cursor);
      send({ id: reqId, type: "inbox", ...result });
    } catch (error) {
      sendInboxError(reqId, error);
    }
  },

  inbox_item: async (reqId, msg) => {
    try {
      const itemId = String(msg.itemId ?? "");
      const item = getInboxItem(itemId);
      if (!item) {
        throw new InboxError("INBOX_ITEM_NOT_FOUND", `inbox: item not found: ${itemId}`);
      }
      const detail = await getInboxDetail(item);
      send({
        id: reqId,
        type: "inbox_item",
        item,
        ...(detail.detail ? { detail: detail.detail } : {}),
        ...(detail.stale ? { stale: true } : {}),
      });
    } catch (error) {
      sendInboxError(reqId, error);
    }
  },

  inbox_action: async (reqId, msg) => {
    try {
      const itemId = String(msg.itemId ?? "");
      const parsedAction = inboxActionSchema.safeParse(msg.action);
      if (!parsedAction.success) {
        throw new InboxError(
          "INBOX_ACTION_NOT_ALLOWED",
          `inbox: invalid action: ${String(msg.action)}`,
        );
      }
      const action = parsedAction.data as InboxAction;
      const item = await applyInboxAction(itemId, action, msg.payload);
      send({
        id: reqId,
        type: "inbox_action_done",
        itemId,
        action,
        item,
        counts: getInboxCounts(),
      });
    } catch (error) {
      sendInboxError(reqId, error);
    }
  },

  inbox_update: async (reqId, msg) => {
    try {
      const patch = (msg.patch && typeof msg.patch === "object"
        ? msg.patch
        : {}) as InboxUpdatePatch;
      // all=true：跨分页批量更新（「全部已读」）。旧的桌面端仍会带 itemIds，
      // 新端只带 filter；旧 sidecar 不认 all 时按 itemIds 处理，行为降级但不报错
      if (msg.all === true) {
        const result = updateInboxPayloadAll(parseFilter(msg.filter), patch);
        send({ id: reqId, type: "inbox_updated", ...result });
        return;
      }
      const itemIds = Array.isArray(msg.itemIds)
        ? msg.itemIds
            .filter((id): id is string => typeof id === "string" && Boolean(id))
            .slice(0, 100)
        : [];
      if (itemIds.length === 0) {
        throw new InboxError("INBOX_ACTION_NOT_ALLOWED", "inbox: itemIds is required");
      }
      const result = updateInboxPayload(itemIds, patch);
      send({ id: reqId, type: "inbox_updated", ...result });
    } catch (error) {
      sendInboxError(reqId, error);
    }
  },

  /**
   * 宿主推送外部来源全量快照（GitHub/GitLab/Jira/Linear）。
   * complete=false 表示分页未拉全：只 upsert，不结算本次缺失的条目。
   */
  inbox_external_sync: async (reqId, msg) => {
    try {
      const parsed = inboxExternalSyncRequestSchema.safeParse(msg);
      if (!parsed.success) {
        throw new InboxError(
          "INBOX_INVALID_EXTERNAL_SYNC",
          `inbox: invalid external sync: ${parsed.error.issues[0]?.message ?? "bad payload"}`,
        );
      }
      const result = syncExternalInboxItems({
        provider: parsed.data.provider,
        connectorId: parsed.data.connectorId,
        items: parsed.data.items,
        complete: parsed.data.complete !== false,
      });
      send({
        id: reqId,
        type: "inbox_external_sync_done",
        provider: parsed.data.provider,
        ...result,
      });
    } catch (error) {
      sendInboxError(reqId, error);
    }
  },
};
