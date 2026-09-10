/** stderr 日志（stdout 走协议流，日志一律走 stderr 避免污染） */
export const logErr = (...args: unknown[]) =>
  console.error("[pi-agent]", ...args);
