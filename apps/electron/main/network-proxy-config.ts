/**
 * 读取设置页持久化的网络代理配置（kv pi.networkProxy）。
 *
 * sidecar spawn 在主进程；配置由渲染层经 kv_set 写入同一个 state.db，这里同步
 * 读即可。db 未就绪/值损坏一律回落默认（跟随系统），不能因为代理配置阻断启动。
 */
import {
  DEFAULT_NETWORK_PROXY_CONFIG,
  NETWORK_PROXY_KV_KEY,
  parseNetworkProxyConfig,
  type NetworkProxyConfig,
} from "pi-protocol";
import { kvGet } from "./store";

export function readNetworkProxyConfig(): NetworkProxyConfig {
  try {
    return parseNetworkProxyConfig(kvGet(NETWORK_PROXY_KV_KEY));
  } catch {
    return DEFAULT_NETWORK_PROXY_CONFIG;
  }
}
