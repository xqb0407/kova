import { mock } from "bun:test";

/**
 * mock.module 生命周期包装（测试顺序脆弱性治理）。
 *
 * 背景：bun test 同进程内，mock.module 的注入会泄漏到之后加载的测试文件；
 * 文件执行顺序又随目录结构/文件名变化——实际炸过一次：app-mode/automations
 * 对 pi-bridge 的泄漏桩顺着命名导入进到 subagent-runs 的用例里，造成随机超时。
 *
 * bun>=1.2 的 mock.module 运行时返回注销函数（撤销本次注入、恢复原模块），
 * 但 @types/bun 签名仍写成 void —— 这里窄化收口：调用即登记撤销函数，
 * 测试文件在 afterAll 里调 restoreAllMocks()，本文件用例跑完即还原。
 *
 * ⚠ 实测限制（bun 1.3.14）：restore() 对「经 tsconfig 路径别名（@/...）解析的模块」
 * 跨文件不可靠——用别名 id 或相对 id mock 后再 restore，后续文件里走别名 import 的
 * 消费方仍可能拿到假模块（对照组：纯相对路径 ./x 的 mock+restore 跨文件正常）。
 * 因此 restore 只当尽力清理，不作为隔离保证：**共享模块的每个 mock 消费文件必须
 * 自锚边界**——凡用例依赖某模块的真实行为、而别的文件 mock 过它，本文件就自己
 * mockModule 一个语义等价桩（见 subagent-runs.test.ts 对 pi-bridge 的委托桩：
 * 桩只是把调用转发回当前注册的通道，行为与真模块一致，不改变被测语义）。
 */
const restores: Array<() => void> = [];

export function mockModule(id: string, factory: () => unknown): void {
  const restore = mock.module(id, factory) as unknown as (() => void) | undefined;
  if (typeof restore === "function") restores.push(restore);
}

/** 回滚本进程内经 mockModule 登记的全部注入（倒序撤销，嵌套 mock 同栈语义） */
export function restoreAllMocks(): void {
  let restore = restores.pop();
  while (restore) {
    restore();
    restore = restores.pop();
  }
}
