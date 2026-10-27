/**
 * 右侧 panel 远程文件通道（remote_fs_*）的端到端测试：
 * 真实 ssh2 服务端 + handler 实跑，验证列目录/读/写/增删改与工作区越界拒绝。
 * send() 的出口是 process.stdout，测试用短暂拦截捕获协议帧。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { Server, utils } from "ssh2";
import { handlers } from "../../src/protocol/handlers/remote-fs";
import { closeAllSsh2 } from "../../src/tools/remote/ssh2-client";
import type { RemoteTarget } from "../../src/types";

const PASSWORD = "panel-secret";
const ROOT = `/tmp/kova-remote-fs-${process.pid}`;

let server: InstanceType<typeof Server>;
let port = 0;

const remote: RemoteTarget = {
  host: "127.0.0.1",
  username: "panel",
  password: PASSWORD,
};

beforeAll(async () => {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.password === PASSWORD) ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const child = spawn("/bin/sh", ["-c", info.command]);
          stream.on("data", (d: Buffer) => child.stdin.write(d));
          stream.on("end", () => child.stdin.end());
          child.stdout.on("data", (d) => stream.write(d));
          child.stderr.on("data", (d) => stream.stderr.write(d));
          child.on("exit", (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
        });
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      remote.port = port;
      resolve();
    });
  });
  spawn("/bin/sh", ["-c", `mkdir -p ${ROOT}`]);
});

afterAll(() => {
  closeAllSsh2();
  server?.close();
  spawn("/bin/sh", ["-c", `rm -rf ${ROOT}`]);
});

type LooseWrite = (chunk: unknown, ...rest: unknown[]) => boolean;

/** 短暂拦截 stdout，捕获 send() 写出的协议帧 */
async function call(name: string, reqId: string, msg: Record<string, unknown>) {
  const frames: Array<Record<string, unknown>> = [];
  const out = process.stdout as unknown as { write: LooseWrite };
  const orig = out.write.bind(process.stdout) as unknown as LooseWrite;
  out.write = (chunk: unknown) => {
    try {
      frames.push(JSON.parse(String(chunk)));
    } catch {
      /* 非 JSON 行忽略 */
    }
    return true;
  };
  try {
    await handlers[name](reqId, { remote, ...msg } as never);
  } finally {
    out.write = orig;
  }
  const frame = frames.find((f) => f.id === reqId);
  if (!frame) throw new Error(`no frame for ${name}`);
  return frame;
}

describe("remote_fs_* handlers（真实 SSH 服务端）", () => {
  test("写入 → 读取 → 列目录 → 重命名 → 删除", async () => {
    const content = "panel 写入内容\nline-2\n";
    const base64 = Buffer.from(content, "utf8").toString("base64");

    const w = await call("remote_fs_write", "w1", {
      cwd: ROOT,
      path: "dir/a.txt",
      base64,
    });
    expect(w.type).toBe("remote_fs_write_result");

    const r = await call("remote_fs_read", "r1", { cwd: ROOT, path: "dir/a.txt" });
    expect(r.content).toBe(content);
    expect(r.binary).toBe(false);

    const list = await call("remote_fs_list", "l1", { cwd: ROOT, dir: "dir" });
    expect(
      (list.entries as Array<{ name: string; dir: boolean }>).map((e) => e.name),
    ).toContain("a.txt");

    const ren = await call("remote_fs_rename", "rn1", {
      cwd: ROOT,
      path: "dir/a.txt",
      newName: "b.txt",
    });
    expect(ren.type).toBe("remote_fs_ok");
    const r2 = await call("remote_fs_read", "r2", { cwd: ROOT, path: "dir/b.txt" });
    expect(r2.content).toBe(content);

    const del = await call("remote_fs_delete", "d1", { cwd: ROOT, path: "dir/b.txt" });
    expect(del.type).toBe("remote_fs_ok");
    const after = await call("remote_fs_read", "r3", { cwd: ROOT, path: "dir/b.txt" });
    expect(String(after.errorText ?? "")).not.toBe("");
  }, 30_000);

  test("图片/二进制 base64 读取", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    await call("remote_fs_write", "w2", {
      cwd: ROOT,
      path: "img.png",
      base64: bytes.toString("base64"),
    });
    const res = await call("remote_fs_read_base64", "b1", {
      cwd: ROOT,
      path: "img.png",
    });
    expect(res.size).toBe(bytes.length);
    expect(Buffer.from(String(res.base64), "base64").equals(bytes)).toBe(true);
    // 文本读取标记 binary
    const text = await call("remote_fs_read", "b2", { cwd: ROOT, path: "img.png" });
    expect(text.binary).toBe(true);
  }, 30_000);

  test("工作区越界路径被拒绝", async () => {
    const res = await call("remote_fs_read", "x1", {
      cwd: ROOT,
      path: "../../etc/hostname",
    });
    expect(String(res.errorText ?? "")).toContain("outside workspace");
    const del = await call("remote_fs_delete", "x2", { cwd: ROOT, path: "/etc" });
    expect(String(del.errorText ?? "")).toContain("outside workspace");
  }, 30_000);

  test("move 重名不覆盖（自动加序号）；rename 重名拒绝", async () => {
    const contentA = Buffer.from("A").toString("base64");
    const contentB = Buffer.from("B").toString("base64");
    await call("remote_fs_mkdir", "mv-m1", { cwd: ROOT, path: "m/a" });
    await call("remote_fs_mkdir", "mv-m2", { cwd: ROOT, path: "m/b" });
    await call("remote_fs_write", "mv-w1", { cwd: ROOT, path: "m/a/x.txt", base64: contentA });
    await call("remote_fs_write", "mv-w2", { cwd: ROOT, path: "m/b/x.txt", base64: contentB });
    const mv = await call("remote_fs_move", "mv-1", {
      cwd: ROOT,
      path: "m/a/x.txt",
      destDir: "m/b",
    });
    expect(mv.type).toBe("remote_fs_move_result");
    expect(mv.name).toBe("x-2.txt");
    const b = await call("remote_fs_read", "mv-r1", { cwd: ROOT, path: "m/b/x.txt" });
    expect(b.content).toBe("B"); // 目标内容未被覆盖
    const moved = await call("remote_fs_read", "mv-r2", { cwd: ROOT, path: "m/b/x-2.txt" });
    expect(moved.content).toBe("A");
    // rename 到已存在名字：拒绝
    const rn = await call("remote_fs_rename", "mv-rn", {
      cwd: ROOT,
      path: "m/b/x-2.txt",
      newName: "x.txt",
    });
    expect(String(rn.errorText ?? "")).toContain("already-exists");
  }, 30_000);

  test("删除工作区根被拒绝", async () => {
    const res = await call("remote_fs_delete", "del-root", { cwd: ROOT, path: "." });
    expect(String(res.errorText ?? "")).not.toBe("");
  }, 30_000);

  test("mkdir / touch 语义", async () => {
    const mk = await call("remote_fs_mkdir", "m1", { cwd: ROOT, path: "new/nested" });
    expect(mk.type).toBe("remote_fs_ok");
    const t1 = await call("remote_fs_touch", "t1", { cwd: ROOT, path: "new/empty.txt" });
    expect(t1.type).toBe("remote_fs_ok");
    const t2 = await call("remote_fs_touch", "t2", { cwd: ROOT, path: "new/empty.txt" });
    expect(String(t2.errorText ?? "")).toContain("already-exists");
  }, 30_000);
});
