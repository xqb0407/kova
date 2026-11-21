/**
 * 页面控制台消息的摄入预算（纯逻辑、无 electron 依赖）。
 *
 * `webContents` 的 `console-message` 事件在**主进程**上派发；一个 WebGL 调试页
 * 很容易每帧打几十上百条日志（draw call / shader 编译 / FPS 打印），换算下来
 * 每秒上万条。主进程逐条建对象、攒 150ms 批量 `webContents.send`；如果主窗口
 * 渲染进程此时正忙（流式更新、60fps guest 合成），IPC 发送队列会在主进程里排队，
 * 内存和 CPU 一起飙——表现为「AI 调工具时主进程卡」。
 *
 * 预算按 1s 滑窗封顶：超出的直接丢弃并计数，flush 时补一条「已省略 N 条」，
 * 既让控制台面板知道刷屏发生了，又保证主进程的摄入量有上界。
 */

export class ConsoleMessageBudget {
  /** 已放行消息的时间戳（升序）；只保留窗口内的，长度自然不超过 maxPerWindow */
  private accepted: number[] = [];
  private dropped = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(maxPerWindow) || maxPerWindow < 0) {
      throw new Error("ConsoleMessageBudget: maxPerWindow must be >= 0");
    }
  }

  /** 当前这条消息是否允许进入缓冲；拒绝时内部累加 dropped。 */
  allow(): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    // 真正的滑动窗口：每分钟都按「最近 windowMs」算，而不是在固定边界整窗清零
    while (this.accepted.length > 0 && this.accepted[0]! <= cutoff) {
      this.accepted.shift();
    }
    if (this.accepted.length >= this.maxPerWindow) {
      this.dropped += 1;
      return false;
    }
    this.accepted.push(t);
    return true;
  }

  /** 取走并清零「被丢弃条数」（flush 时用）。 */
  takeDropped(): number {
    const n = this.dropped;
    this.dropped = 0;
    return n;
  }

  /** 测试/页面切换用：清空窗口、计数与丢弃量。 */
  reset(): void {
    this.accepted.length = 0;
    this.dropped = 0;
  }
}
