/**
 * host_query RPC 传输策略（host 模式）：stdout 请求 / stdin host_result 应答，
 * 含超时、AbortSignal 取消（向宿主发 host_cancel）与挂起请求登记。
 * local 模式的传输实现见 ./local.ts（localDispatch），经 setTransport 注入。
 */

/* ---------------------------------- 模式管理 --------------------------------- */
/** RPC 附加选项：signal 中断时向宿主发 host_cancel；timeoutMs 覆盖默认 15s */
export type RpcOptions = { signal?: AbortSignal; timeoutMs?: number };

type QueryTransport = (
  kind: string,
  params: Record<string, unknown>,
  opts?: RpcOptions,
) => Promise<unknown>;

let transport: QueryTransport | null = null;

/** 生产入口：走 stdout host_query RPC（index.ts 在读完 env 后调用） */
export function initHostTransport(): void {
  hostSeq = 0;
  transport = stdoutRpc;
}

/** 传输策略注入点：host 模式注入 stdoutRpc，local 模式注入 localDispatch（见 ./local.ts） */
export function setTransport(t: QueryTransport | null): void {
  transport = t;
}

export function getTransport(): QueryTransport | null {
  return transport;
}

/** 测试辅助：拒绝并清空所有挂起请求（resetStorageForTest 用） */
export function rejectAllPending(): void {
  for (const [, p] of pending) p.reject(new Error("storage reset"));
  pending.clear();
}

let hostSeq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const HOST_QUERY_TIMEOUT_MS = 15_000;
/** 工具类 RPC 在「工具自身超时」之外再等的余量（宿主执行完还要序列化回写） */
const TOOL_RPC_SLACK_MS = 15_000;

function abortAsError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r;
  return new Error("Operation aborted");
}

/** 告知宿主「放弃这条请求」：Rust 侧据此杀对应工具进程树；无登记则无害 no-op */
function writeHostCancel(id: string): void {
  try {
    process.stdout.write(JSON.stringify({ type: "host_cancel", id }) + "\n");
  } catch {
    // 管道破裂说明宿主已退出，无需再取消
  }
}

function stdoutRpc(
  kind: string,
  params: Record<string, unknown>,
  opts: RpcOptions = {},
): Promise<unknown> {
  const id = `hq-${++hostSeq}`;
  const { signal, timeoutMs = HOST_QUERY_TIMEOUT_MS } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortAsError(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      pending.delete(id);
      writeHostCancel(id); // bash 等仍在宿主里跑：立即通知杀进程树
      // onAbort 只在 signal 存在时才被注册
      settle(() => reject(abortAsError(signal!)));
    };
    const fail = (fn: () => void) => {
      pending.delete(id);
      writeHostCancel(id); // 超时同样取消，避免宿主在「JS 已报错」后才跑完
      settle(fn);
    };
    timer = setTimeout(
      () =>
        fail(() =>
          reject(
            new Error(
              `host_query timeout: ${kind}（宿主在 ${Math.round(timeoutMs / 1000)}s 内没回结果；` +
                `已发 host_cancel 取消。命令本身可能跑得太久——bash 可显式传更小的 timeout 参数，` +
                `不要据此重试同一个长命令）`,
            ),
          ),
        ),
      timeoutMs,
    );
    pending.set(id, {
      resolve: (v) => settle(() => resolve(v)),
      reject: (e) => settle(() => reject(e)),
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    process.stdout.write(JSON.stringify({ type: "host_query", id, kind, params }) + "\n");
  });
}

/** stdin 循环解析出 host_result 行后调用（index.ts 接线） */
export function resolveHostResult(msg: Record<string, unknown>): boolean {
  if (msg?.type !== "host_result") return false;
  const id = typeof msg.id === "string" ? msg.id : "";
  const waiter = pending.get(id);
  if (!waiter) return true; // 无匹配（超时已清理）：吞掉
  pending.delete(id);
  if (msg.ok === true) waiter.resolve(msg.data);
  else waiter.reject(new Error(String(msg.error ?? "host_query failed")));
  return true;
}
/** 工具类 RPC 的超时 = 工具自身超时 + 余量：bash 默认 120s、http 默认 30s（上限 120s），
 *  不能让它们在宿主还在正常执行时先吃 15s 的通用超时。仅 host 模式的工具调用出口使用 */
export function toolRpcTimeoutMs(name: string, params: Record<string, unknown>): number {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  if (name === "bash") return (num(params.timeout) ?? 120_000) + TOOL_RPC_SLACK_MS;
  if (name === "http") return (num(params.timeoutMs) ?? 30_000) + TOOL_RPC_SLACK_MS;
  // browser_shot：冷启动一个无头 Chrome 再导航，比面板动作重得多，
  // 但 Rust 侧自己封在 25s（SHOT_TIMEOUT），这里必须比它大
  if (name === "browser_shot") return 40_000;
  // 其余 browser_*：动作含导航/点击后的页面稳定等待（Rust 上限 30s+10s）再加速照
  if (name.startsWith("browser_")) return 60_000 + TOOL_RPC_SLACK_MS;
  // screenshot：screencapture + 阶梯 sips 压缩，慢机/超大 Retina 留 30s 余量
  if (name === "screenshot") return 30_000;
  return HOST_QUERY_TIMEOUT_MS; // read/write/edit 是本地文件操作
}
