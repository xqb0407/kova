/**
 * 预览 harness 的帧时间轴兜底（仅 dev-preview/quick-view 页面使用）：
 * IAB 预览面板不产帧时 window.requestAnimationFrame 会整体冻结，framer-motion
 * 的入场动画于是永远停在初始帧（卡片 opacity 0、分区高度 0），看起来像功能坏掉。
 * 在页面模块图里**最先**执行，把 rAF 接到 setTimeout 上（~16ms 一拍）。
 * 只影响这个验证页，生产 Electron 前台帧调度正常，不经过这里。
 */
if (typeof window !== "undefined") {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let seq = 1;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = seq++;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        cb(performance.now());
      }, 16),
    );
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }) as typeof window.cancelAnimationFrame;
}

export {};
