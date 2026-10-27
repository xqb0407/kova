/**
 * 子进程管道 / 文件写流的错误兜底。
 *
 * writable 对失败的写入，除了把错误交给 write 回调，还会向流 emit('error')；
 * 没有监听者时 Node 直接抛 uncaughtException。Windows/libuv 把管道的
 * ERROR_BROKEN_PIPE 翻译成 UV_EOF，日志里表现为 "Error: write EOF"
 * （TTY/console 走写专用翻译，是 EPIPE）。
 */

/** 给流挂 'error' 监听：对端关闭、写失败都不再升级成主进程崩溃。 */
export function guardStreamErrors(
  stream: NodeJS.EventEmitter | null | undefined,
  onError?: (err: NodeJS.ErrnoException) => void,
): void {
  stream?.on("error", (err) => onError?.(err as NodeJS.ErrnoException));
}

const BENIGN_STREAM_CODES = new Set([
  "EPIPE",
  "EOF",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

/** 对端已关闭/流已销毁属于预期断管，不值得按错误告警。 */
export function isBenignStreamClose(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && BENIGN_STREAM_CODES.has(code);
}
