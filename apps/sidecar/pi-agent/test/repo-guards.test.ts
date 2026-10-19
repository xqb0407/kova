import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 跨包门禁：主进程同步阻塞面（发布前守门）。
 *
 * 放在 sidecar 测试目录，是因为根 `bun run test` 只覆盖本包——规则本身属于整个
 * 仓库，这里至少让它随测试一起跑。背景：主进程被同步 fs / 同步 SQLite 按住时
 * 全部 IPC 排队、界面"哪里都点不了"，而且 crash.ts 自己写了——同步阻塞期间同进
 * 程内没有任何代码能弹窗（2026-10 那次 42s 界面冻结就是这一族）。所以：
 * - 目录遍历 / 大文件读写 / 递归删除一律异步 fs（走 libuv 线程池）；
 * - 单路径的 existsSync/lstatSync/mkdirSync 是微秒级，允许保留（不为此抖动代码）；
 * - 慢操作留痕 + lag 心跳归因的接线必须还在（slow-ops.ts）。
 * 哪条红了，就是主进程又开始在主线程干重活（或把归因拆了）。
 */
/** apps/sidecar/pi-agent/test → 仓库根 */
const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
/** 判负断言只应看代码：注释里提到旧实现（如 "statSync"）不该把门禁搞红 */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("主进程同步阻塞面", () => {
  test("资料库命令：目录遍历 / 拷贝 / 统计全异步，不留同步重活", () => {
    const src = code("apps/electron/main/library-cmds.ts");
    expect(src).toContain("node:fs/promises");
    // 这些一旦回来，巨型目录/整目录导入就会重新按住事件循环
    expect(src).not.toMatch(/\b(readdirSync|statSync|cpSync|lstatSync|realpathSync)\b/);
  });

  test("fs-cmds：目录列表与 20MiB 级读写不再用同步 API", () => {
    const src = code("apps/electron/main/fs-cmds.ts");
    expect(src).not.toMatch(/\breaddirSync\b/);
    expect(src).not.toMatch(/\b(rmSync|unlinkSync|writeFileSync)\b/);
    expect(src).toContain("await readdir(");
    expect(src).toContain("await rm(");
  });

  test("慢操作自报与 lag 归因接线在位", () => {
    expect(read("apps/electron/main/slow-ops.ts")).toContain("export function noteMainOp");
    expect(read("apps/electron/main/ipc.ts")).toContain("noteMainOp(cmd");
    expect(read("apps/electron/main/data.ts")).toContain("measureSync(");
    const idx = read("apps/electron/main/index.ts");
    expect(idx).toContain("lastSlowMainOp()");
    expect(idx).toContain("SLOW_OP_ATTRIBUTION_WINDOW_MS");
  });

  test("sidecar 侧慢命令也自报（长任务必须能从事后日志里认出来）", () => {
    const src = read("apps/sidecar/pi-agent/src/protocol/protocol.ts");
    expect(src).toContain("MGMT_QUEUE_SLOW_WARN_MS");
    expect(src).toContain("占用串行队列");
  });
});