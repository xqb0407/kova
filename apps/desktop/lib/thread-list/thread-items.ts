"use client";

import { useRef } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { AssistantState } from "@assistant-ui/store";

/** 会话项切片（`s.threads.threadItems` 的元素类型） */
export type ThreadListItemState =
  AssistantState["threads"]["threadItems"][number];

const EMPTY: readonly ThreadListItemState[] = [];

/**
 * 内容稳定的会话项列表切片。
 *
 * `s.threads.threadItems` 的外层数组引用在每次读取都可能重建（库侧按渲染
 * 派生），而 useAuiState 对切片做 Object.is 比较：直接把这个数组交给它，
 * 每次 store 发布都会被判定为"变了"——侧栏的分组/排序 memo
 * （useThreadListGroups，185 项建 Map + 排序 + 分桶）就在每次发布时整体重算、
 * 可见行全部重渲。切会话要经过数次发布（载入、快照回程、mainThreadId 推进），
 * 累积成"切过去慢一截、列表像在重新加载"的观感。
 *
 * 这里只让 primitive 指纹参与订阅：逐元素引用比较，内容相同就复用上一次的
 * 数组引用；内容真变才 +1 版本号触发一次重渲。元素对象本身跨发布稳定
 * （实测），所以逐元素比较等价于"内容相等"。
 *
 * 注：这也是卡死事件（Maximum update depth exceeded）的防线之一——"每次读取
 * 都换引用"的切片在 store「每次提交都 notify」的泵下会把读者拖进同步嵌套
 * 自环；凡是要整个数组的读者都应经这里取，不要直接 useAuiState 返回数组。
 */
export function useThreadItems(): readonly ThreadListItemState[] {
  const cacheRef = useRef<readonly ThreadListItemState[]>(EMPTY);
  const versionRef = useRef(0);

  useAuiState((s) => {
    const next = s.threads.threadItems;
    const prev = cacheRef.current;
    if (
      next === prev ||
      (next.length === prev.length && next.every((item, i) => item === prev[i]))
    ) {
      return versionRef.current;
    }
    cacheRef.current = next;
    versionRef.current += 1;
    return versionRef.current;
  });

  return cacheRef.current;
}

/**
 * 骨架屏判定：只在"还没有任何数据"时出骨架。
 *
 * `threads.isLoading` 在后台整表 reload（跨端同步、定时任务结算、通知点击
 * 前的补一次列表）时同样置真；直接用它切骨架会把已经渲染好的列表整块换成
 * 骨架——观感上就是"列表在重新加载"。有数据时保留旧列表（stale-while-
 * revalidate），新数据到了原地替换。
 */
export const threadListSkeletonCondition = (s: AssistantState): boolean =>
  s.threads.isLoading && s.threads.threadIds.length === 0;

/** 同上的 hook 形态（组件里需要布尔值而非选择器时用） */
export function useThreadListSkeleton(): boolean {
  return useAuiState(threadListSkeletonCondition);
}
