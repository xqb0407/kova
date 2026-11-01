"use client";

/**
 * 辅助会话作用域：副屏视图把它罩在嵌套 runtime 外层。
 * 划词工具栏据此隐藏「辅助会话」入口（副屏不能再派生辅助会话）。
 */

import { createContext, useContext, type ReactNode } from "react";

export type SideChatScopeValue = {
  parentSessionId: string;
  childSessionId: string;
};

const SideChatScopeContext = createContext<SideChatScopeValue | null>(null);

export function SideChatScopeProvider({
  value,
  children,
}: {
  value: SideChatScopeValue;
  children: ReactNode;
}) {
  return (
    <SideChatScopeContext.Provider value={value}>
      {children}
    </SideChatScopeContext.Provider>
  );
}

export function useSideChatScope(): SideChatScopeValue | null {
  return useContext(SideChatScopeContext);
}
