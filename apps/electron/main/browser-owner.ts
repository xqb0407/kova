/**
 * 浏览器 guest 的属主绑定规则（纯函数，便于测试）。
 *
 * `<webview>` 的 webContents 在没有显式 owner 时允许多次重绑（StrictMode、
 * dom-ready + did-attach 双事件），但一旦有属主，就**不允许**把同一个 guest
 * 转给另一个会话：切换会话必须销毁旧 webview、绑定新的 guest。否则新会话的
 * browser_* 工具会直接驱动上一会话的页面，出现跨会话串控。
 */
export function resolveGuestOwner(
  current: string | null,
  requested: string | null,
): string | null {
  if (requested === null) return current;
  if (current !== null && current !== requested) {
    throw new Error(
      `browser_bind_guest: guest already belongs to another conversation ` +
        `(owner=${current}, requested=${requested})`,
    );
  }
  return requested;
}
