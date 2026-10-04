import { createContext, useContext, type ReactNode } from "react";
import type { RemoteConfig } from "@/lib/mobile/secure-store";

/**
 * 已配对的网关配置。根布局持有 config state（换配置 = 重建整条运行时），
 * 设置抽屉里的「重新配对」要能把它清回配对屏——但抽屉在别的路由文件里，
 * 靠这个 context 递一个 unpair 过去，避免把 setConfig 一路透传。
 */
type RemoteConfigValue = {
  config: RemoteConfig;
  /** 清掉本地凭据并退回配对屏 */
  unpair: () => void;
};

const RemoteConfigContext = createContext<RemoteConfigValue | null>(null);

export function RemoteConfigProvider({
  value,
  children,
}: {
  value: RemoteConfigValue;
  children: ReactNode;
}) {
  return (
    <RemoteConfigContext.Provider value={value}>
      {children}
    </RemoteConfigContext.Provider>
  );
}

export function useRemoteConfig(): RemoteConfigValue {
  const value = useContext(RemoteConfigContext);
  if (!value) throw new Error("useRemoteConfig 必须在 RemoteConfigProvider 内使用");
  return value;
}