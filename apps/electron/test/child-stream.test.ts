import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Writable } from "node:stream";
import { guardStreamErrors, isBenignStreamClose } from "../main/child-stream";

describe("guardStreamErrors", () => {
  test("写失败不会被升级成 uncaughtException", async () => {
    const seen: string[] = [];
    const stream = new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error("write EOF"), { code: "EOF" }));
      },
    });
    guardStreamErrors(stream, (e) => seen.push(String(e.code)));
    stream.write("x");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["EOF"]);
  });
});

describe("isBenignStreamClose", () => {
  test("识别预期断管错误码", () => {
    for (const code of ["EPIPE", "EOF", "ECONNRESET", "ERR_STREAM_DESTROYED"]) {
      expect(isBenignStreamClose(Object.assign(new Error("write EOF"), { code }))).toBe(true);
    }
  });

  test("普通错误不算预期断管", () => {
    expect(isBenignStreamClose(new Error("write EOF"))).toBe(false);
    expect(isBenignStreamClose(Object.assign(new Error("disk full"), { code: "ENOSPC" }))).toBe(false);
    expect(isBenignStreamClose(null)).toBe(false);
    expect(isBenignStreamClose("EOF")).toBe(false);
  });
});

// 真实管道回归：只靠 write 回调兜不住流级 'error'（win32 上是 write EOF）。
// Windows 无 sh，跳过；对应平台由上面的合成 Writable 用例覆盖同一 Node 语义。
if (process.platform !== "win32") {
  test("真实子进程关闭 stdin 后写入不会升级成 uncaughtException", async () => {
    // 子进程关掉 stdin 读端后继续存活：父进程随后的写入一定异步失败
    const child = spawn("sh", ["-c", "exec 0<&-; echo ready; sleep 2"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    try {
      await once(child.stdout, "data");
      const seen: string[] = [];
      guardStreamErrors(child.stdin, (e) => seen.push(String(e.code)));
      child.stdin.write(Buffer.alloc(1024 * 1024));
      const deadline = Date.now() + 2000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(seen.length).toBeGreaterThanOrEqual(1);
    } finally {
      child.kill();
    }
  });
}
