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
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export const mock: {
    module(name: string, factory: () => unknown): void;
  };
  export function expect(value: unknown): {
    toEqual(expected: unknown): void;
    toBe(expected: unknown): void;
    toThrow(expected?: unknown): void;
    toHaveLength(expected: number): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeTruthy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toContain(expected: unknown): void;
    toMatch(expected: RegExp | string): void;
    not: {
      toContain(expected: unknown): void;
      toBeNull(): void;
    };
  };
}

declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string);
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
      };
    };
    exec(sql: string): void;
    close(): void;
  }
}
