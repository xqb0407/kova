/**
 * 浏览器自动化窗口标记：agent 动作执行期间为「自动化中」，动作结束后保留
 * 3s grace，覆盖点击后由微任务/短定时器延迟触发的 alert/confirm。
 *
 * 用途：
 * - 权限策略在自动化期间直接拒绝敏感权限，不让页面卡 20s 等一个没人看的弹窗；
 * - 阶段 4 的 guest preload 在自动化期间放回 Chromium 原生 Dialog，
 *   让 CDP 的 Page.javascriptDialogOpening / handleJavaScriptDialog 接管。
 */
const AUTOMATION_GRACE_MS = 3_000;

let depth = 0;
let graceUntil = 0;

export function beginBrowserAutomation(): () => void {
  depth += 1;
  // 新一轮动作取消上一轮的 grace，避免“动作早已结束”被误判为自动化。
  graceUntil = 0;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    if (depth === 0) graceUntil = Date.now() + AUTOMATION_GRACE_MS;
  };
}

export function isBrowserAutomationActive(): boolean {
  return depth > 0 || Date.now() < graceUntil;
}

/** 仅测试用：隔离模块级状态。 */
export function resetBrowserAutomationForTest(): void {
  depth = 0;
  graceUntil = 0;
}
