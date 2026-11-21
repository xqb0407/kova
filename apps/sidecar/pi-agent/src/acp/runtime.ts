/**
 * ACP 运行时标记：让工具装配层知道当前进程是编辑器拉起的 ACP agent，
 * 从而过滤掉桌面 UI 专属工具（browser/screenshot/open_file/...）。
 *
 * 故意不 import @agentclientprotocol/sdk：tools.ts 在进程早期就会加载，
 * 这里只能是一个零依赖的布尔值。
 */
let acpRuntime = false;

export function setAcpRuntime(value: boolean): void {
  acpRuntime = value;
}

export function isAcpRuntime(): boolean {
  return acpRuntime;
}

export function resetAcpRuntimeForTest(): void {
  acpRuntime = false;
}
