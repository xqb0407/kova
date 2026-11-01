"use client";

/**
 * 划词「辅助会话」入口的编排：
 *   选区 → sidecar 创建隐藏子会话 → 右侧面板打开 side-chat tab
 *   → 选区写入 pending quote → 副屏挂载后预填 composer（不自动发送）。
 *
 * 同一父会话 + 同一段选区在请求在飞期间只创建一次（防双击/重复点击），
 * 不同选区各自开新副屏。
 */

import { toast } from "@/components/ui/toast";
import { getPanelTabs, openSideChatTab } from "@/lib/panels/panel-tabs";
import {
  piRequest,
  type PiResponse,
  type PiSessionSummary,
} from "@/lib/pi/pi-bridge";
import { createSideChatSession } from "@/lib/pi/pi-thread-adapter";
import {
  setPendingSideChatQuote,
  type PendingSideChatQuote,
} from "./pending-quote";

const inFlight = new Map<string, Promise<void>>();

export type StartAuxiliarySessionInput = {
  parentSessionId: string;
  /** 选区引用；固定入口（面板 + 菜单）新建时缺省——无引用的空白副屏 */
  quote?: PendingSideChatQuote;
  /** 固定入口置位：跳过「追加到激活副屏」，永远新建（ZCode SSC25——
   *  划词入口 SSC27 的追加优先只属于划词这一条入口） */
  forceNew?: boolean;
};

/** 当前激活副屏的子会话 id（激活 tab 必须是 side-chat 类型；工具 tab 不算）。
 *  追加语义与 ZCode 对齐：有激活副屏 → 引用并入它的 composer；没有 → 新建。 */
function getActiveSideChatChildSessionId(): string | null {
  const state = getPanelTabs();
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  return active?.type === "side-chat" ? (active.childSessionId ?? null) : null;
}

export function startAuxiliarySession(
  input: StartAuxiliarySessionInput,
): Promise<void> {
  // 追加优先（ZCode SSC27）：当前激活 tab 是辅助会话 → 引用并入它的 composer
  //（草稿与既有引用保留），激活 tab 并展开面板，不新建；连着划多段文字
  // 攒进同一个副屏。没有激活副屏 → 走新建。固定入口（forceNew）绕过本分支。
  const activeChildId = input.forceNew ? null : getActiveSideChatChildSessionId();
  if (activeChildId) {
    if (input.quote) setPendingSideChatQuote(activeChildId, input.quote);
    const tabId = openSideChatTab({
      parentSessionId: input.parentSessionId,
      childSessionId: activeChildId,
    });
    if (!tabId) {
      toast.message({
        title: "无法打开辅助会话",
        description: "当前没有可用的面板会话，请先打开一个任务",
      });
      return Promise.resolve();
    }
    window.dispatchEvent(new Event("agent-panel:open"));
    return Promise.resolve();
  }

  // 新建路径：同一父会话 + 同一段选区在请求在飞期间只创建一次（防双击）
  const key = `${input.parentSessionId}\u0000${input.quote?.text ?? "<new>"}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    try {
      const childSessionId = await createSideChatSession(input.parentSessionId);
      if (input.quote) setPendingSideChatQuote(childSessionId, input.quote);
      const tabId = openSideChatTab({
        parentSessionId: input.parentSessionId,
        childSessionId,
      });
      if (!tabId) {
        toast.message({
          title: "无法打开辅助会话",
          description: "当前没有可用的面板会话，请先打开一个任务",
        });
        return;
      }
      // 面板可能处于收起状态：复用面板类命令的展开事件
      window.dispatchEvent(new Event("agent-panel:open"));
    } catch (error) {
      toast.message({
        title: "创建辅助会话失败",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}

/** 固定入口（面板 + 菜单/空态）新建：无选区引用的空白副屏。
 *  forceNew——固定入口永远新建（ZCode SSC25），追加优先只属于划词入口。 */
export function openNewAuxiliarySession(parentSessionId: string): Promise<void> {
  return startAuxiliarySession({ parentSessionId, forceNew: true });
}

/** 找回：标签被关掉的辅助会话重新打开成面板标签（面板 + 菜单的列表项） */
export async function reopenAuxiliarySession(
  parentSessionId: string,
  childSessionId: string,
): Promise<void> {
  const tabId = openSideChatTab({ parentSessionId, childSessionId });
  if (!tabId) {
    toast.message({
      title: "无法打开辅助会话",
      description: "当前没有可用的面板会话，请先打开一个任务",
    });
    return;
  }
  window.dispatchEvent(new Event("agent-panel:open"));
}

/**
 * 当前父会话的辅助会话（找回列表；最近更新在前）。
 * 只算「用过」的：发出过至少一条消息（messageCount > 0）——建了没发的空壳
 * 没有可找回的内容，不进列表（sidecar 的 includeSide 仍返回全部，偏好
 * 镜像刷新依赖它，过滤只发生在找回这一层）。
 */
export async function listAuxiliarySessions(
  parentSessionId: string,
): Promise<PiSessionSummary[]> {
  const res = await piRequest<
    Extract<PiResponse, { type: "sessions" }>
  >({ type: "list_sessions", includeSide: true });
  return res.sessions
    .filter(
      (s) =>
        s.kind === "side_chat" &&
        s.parentSessionId === parentSessionId &&
        s.messageCount > 0,
    )
    .sort((a, b) => (a.modified < b.modified ? 1 : -1));
}
