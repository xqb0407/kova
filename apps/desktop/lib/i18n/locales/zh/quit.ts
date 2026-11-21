/**
 * 中文词典：⌘Q 退出进度条与提示条。
 * 事实源；en/quit.ts 以 typeof 本对象镜像，漏翻即编译错误。
 */
export const zhQuit = {
  /** 提示条主文案（holding 阶段；剩余秒数显示在圆形进度环中心） */
  hold: "按住 {shortcut} 退出 · 松开取消",
  /** 已确认，逐项停止任务 */
  stopping: "正在退出 · 停止任务 {done}/{total}",
  stoppingNoTasks: "正在退出…",
  /** 不可取消的收尾阶段 */
  finalizing: "正在关闭后台服务…",
  cancel: "取消",
  cancelled: "已取消退出",
  cancelledPartial: "已取消退出 · 已停止 {count} 个任务",
  untitledSession: "未命名会话",
  kind: {
    session: "会话",
    background: "后台命令",
    terminal: "终端",
    automation: "定时任务",
    engine: "AI 引擎",
    remote: "远程访问",
    im: "消息通道",
  },
};
