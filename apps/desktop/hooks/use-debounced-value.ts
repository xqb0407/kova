"use client";

import { useEffect, useState } from "react";

/**
 * 防抖值（通用）：输入框受控值经它派生一份延迟值——输入框即时回显不受影响，
 * 重活（列表过滤/搜索请求/预览计算）只吃延迟值，连续击键折叠为最后一次。
 * 与 useDebouncedCallback 的分工：那是「事件 → 回调」（自动保存），
 * 这是「值 → 值」（搜索过滤等纯派生场景，无需调用方再包 useEffect）。
 * 标准排程式：value/delay 任一变化即重置计时器，卸载时清除（防卸载后 setState）。
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
