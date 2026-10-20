/**
 * 最小 `bun:test` 声明。
 *
 * apps/electron 的 tsconfig 只启用 node 类型（主进程代码运行在 Electron 的
 * Node 里，不应看到 Bun 全局），测试却由 `bun test` 执行。这里只声明本目录
 * 测试实际用到的 API，避免为了一个测试文件把 Bun 全局灌进整个主进程工程。
 */
declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(value: unknown): {
    toEqual(expected: unknown): void;
    toBe(expected: unknown): void;
  };
}
