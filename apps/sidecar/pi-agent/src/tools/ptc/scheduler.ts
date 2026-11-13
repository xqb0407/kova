/**
 * 子调用调度器：PTC 脚本里的 `Promise.all` 不应把 bash 这类串行工具并发出去。
 *
 * 规则：
 * - parallel：只读检索/读取类，最多 `maxParallel` 个同时跑。
 * - sequential：其余工具（第一版没有，但写类/MCP 以后会进来），独占运行，
 *   且等当前并行调用全部结束。
 *
 * FIFO 队列保证 `tools.edit(1); tools.read(2)` 的顺序不会被并行的 read 插队。
 */
export type PtcCallMode = "parallel" | "sequential";

interface QueuedCall<T> {
  mode: PtcCallMode;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export const PTC_MAX_PARALLEL_CALLS = 8;

export class PtcScheduler {
  private readonly queue: QueuedCall<unknown>[] = [];
  private activeParallel = 0;
  private sequentialRunning = false;

  constructor(private readonly maxParallel = PTC_MAX_PARALLEL_CALLS) {}

  run<T>(mode: PtcCallMode, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        mode,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /** 当前排队 + 运行中的调用数（测试与观测用）。 */
  get size(): number {
    return this.queue.length + this.activeParallel + (this.sequentialRunning ? 1 : 0);
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (head.mode === "sequential") {
        if (this.activeParallel > 0 || this.sequentialRunning) return;
        this.queue.shift();
        this.sequentialRunning = true;
        this.start(head);
        return;
      }
      if (this.sequentialRunning || this.activeParallel >= this.maxParallel) return;
      this.queue.shift();
      this.activeParallel++;
      this.start(head);
    }
  }

  private start(call: QueuedCall<unknown>): void {
    void (async () => {
      try {
        call.resolve(await call.run());
      } catch (error) {
        call.reject(error);
      } finally {
        if (call.mode === "sequential") this.sequentialRunning = false;
        else this.activeParallel--;
        this.pump();
      }
    })();
  }
}
