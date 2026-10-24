/**
 * 换代广播 e2e：真进程直跑 sidecar（本地存储模式，无宿主），断言启动后
 * 第一条 stdout 帧是 {"type":"pi_restarted"}。
 *
 * 背景：dev 模式 sidecar 跑在 bun --watch 下，源码一改就原地换代（进程句柄
 * 不变，宿主 close 事件不响）。前端靠这条无 id 自发帧感知换代并对在跑线程
 * 拉快照对账归位——没有它，换代瞬间在跑的轮次没有 agent_end 收尾，UI 永远
 * 停在 running（2026-10-24「停止不了」的根因）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清扫失败非致命 */
    }
  }
});

describe("pi_restarted 换代广播", () => {
  test("启动后第一条 stdout 帧是 pi_restarted（无 id 自发通知）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-agent-restart-e2e-"));
    dirs.push(cwd);
    const entry = join(import.meta.dir, "..", "..", "src", "index.ts");
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: {
        ...process.env,
        // 本地存储模式（无 PI_SESSIONS_DIR）：SQLite/会话目录都落临时目录
        PI_DB_PATH: join(cwd, "state.db"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // 启动横幅走 stderr，不影响 stdout 首帧；但初始化报错会卡住首帧——
    // 收集 stderr 供断言失败时定位
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    try {
      const firstLine = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`stdout first line timeout; stderr:\n${stderrTail}`)),
          15_000,
        );
        let buf = "";
        const onData = (chunk: Buffer) => {
          buf += chunk.toString();
          const idx = buf.indexOf("\n");
          if (idx >= 0) {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            resolve(buf.slice(0, idx));
          }
        };
        child.stdout.on("data", onData);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const frame = JSON.parse(firstLine) as { type?: string; id?: unknown };
      expect(frame.type).toBe("pi_restarted");
      // 自发通知帧不带 id（协议契约：无 id 行由宿主广播给所有前端）
      expect(frame.id).toBeUndefined();
    } finally {
      // 超时/断言失败路径同样要收尸：否则测试失败会留下常驻的 sidecar 进程
      child.kill("SIGKILL");
    }
  }, 20_000);
});
