/**
 * 管理命令串行队列：避免凭据写入与列表查询等异步命令交叠产生竞态。
 * handleLine 把非 prompt 命令整体入队；prompt 的会话准备段（runPromptTurn）
 * 与自动化预建会话（mgmtResolveSession）也经此排队——agent.prompt 长任务
 * 本体在队列外运行。队列按提交顺序严格串行，前序失败不阻塞后续。
 */

let mgmtQueue: Promise<void> = Promise.resolve();

/** 入队一个管理任务：返回任务自身的 Promise（失败向上抛给调用方），
 *  队列链吸收失败继续放行下一个任务 */
export function enqueueMgmt<T>(task: () => Promise<T>): Promise<T> {
  const p = mgmtQueue.then(task, task);
  mgmtQueue = p.then(
    () => {},
    () => {},
  );
  return p;
}
