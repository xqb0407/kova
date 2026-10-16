import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkpointCapture,
  checkpointDiff,
  checkpointForget,
  checkpointPrepare,
  checkpointStatus,
  checkpointUndo,
} from "../../src/checkpoint/store";

/**
 * 编辑检查点（条目所有权层）单测：PI_CHECKPOINT_DIR 指到临时目录，
 * 全部走公共门面（与工具/协议同一入口），不戳内部。
 */

let roots: string[] = [];
let ckDir: string;
let ws: string;

beforeEach(() => {
  ckDir = mkdtempSync(join(tmpdir(), "kova-ck-"));
  roots.push(ckDir);
  ws = mkdtempSync(join(tmpdir(), "kova-ws-"));
  roots.push(ws);
  process.env.PI_CHECKPOINT_DIR = ckDir;
});

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.PI_CHECKPOINT_DIR;
});

const S = "session-1";
const put = (rel: string, text: string) => {
  const abs = join(ws, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
  return abs;
};

describe("checkpoint store", () => {
  test("modified file: stats + undo restores turn baseline", async () => {
    put("src/a.ts", "one\ntwo\nthree\n");
    await checkpointPrepare(S, ws, "t1", ["src/a.ts"]);
    put("src/a.ts", "one\nTWO TWO\nthree\n");
    await checkpointCapture(S, ws, "t1", ["src/a.ts"]);

    const files = await checkpointStatus(S, ws, "t1");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ rel: "src/a.ts", status: "modified", undoable: true, exact: true });
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);

    const diff = await checkpointDiff(S, ws, "t1", "src/a.ts");
    expect(diff?.original).toContain("two");
    expect(diff?.current).toContain("TWO TWO");

    const res = await checkpointUndo(S, ws, "t1", "src/a.ts");
    expect("rel" in res && res.rel).toBe("src/a.ts");
    expect(readFileSync(join(ws, "src/a.ts"), "utf8")).toBe("one\ntwo\nthree\n");
    // 回滚后本轮清单里不再有该文件（磁盘回到动手前，归属重置）
    expect(await checkpointStatus(S, ws, "t1")).toHaveLength(0);
  });

  test("added file: status=added, undo deletes it", async () => {
    await checkpointPrepare(S, ws, "t1", ["new/f.md"]);
    put("new/f.md", "hello\n");
    await checkpointCapture(S, ws, "t1", ["new/f.md"]);

    const files = await checkpointStatus(S, ws, "t1");
    expect(files[0]).toMatchObject({ rel: "new/f.md", status: "added", undoable: true });

    const res = await checkpointUndo(S, ws, "t1", "new/f.md");
    expect("rel" in res).toBe(true);
    expect(existsSync(join(ws, "new/f.md"))).toBe(false);
  });

  test("capture without prepare stays visible but never undoable", async () => {
    put("x.ts", "a\n");
    await checkpointCapture(S, ws, "t1", ["x.ts"]); // 无边界
    put("x.ts", "b\n");
    await checkpointCapture(S, ws, "t1", ["x.ts"]);

    const files = await checkpointStatus(S, ws, "t1");
    expect(files[0]).toMatchObject({ rel: "x.ts", undoable: false, exact: false });
    const res = await checkpointUndo(S, ws, "t1", "x.ts");
    expect("error" in res && res.error).toBe("no-boundary");
    expect(readFileSync(join(ws, "x.ts"), "utf8")).toBe("b\n");
  });

  test("third-party write after capture blocks undo (changed-after)", async () => {
    put("y.ts", "orig\n");
    await checkpointPrepare(S, ws, "t1", ["y.ts"]);
    put("y.ts", "agent\n");
    await checkpointCapture(S, ws, "t1", ["y.ts"]);
    put("y.ts", "user hand edit\n"); // 轮后第三方

    const files = await checkpointStatus(S, ws, "t1");
    expect(files[0].undoable).toBe(false);
    const res = await checkpointUndo(S, ws, "t1", "y.ts");
    expect("error" in res && res.error).toBe("changed-after");
    expect(readFileSync(join(ws, "y.ts"), "utf8")).toBe("user hand edit\n");
  });

  test("external touch between two agent edits in-turn marks exact=false, still undoable at end", async () => {
    put("z.ts", "base\n");
    await checkpointPrepare(S, ws, "t1", ["z.ts"]);
    put("z.ts", "agent1\n");
    await checkpointCapture(S, ws, "t1", ["z.ts"]);
    put("z.ts", "third-party\n"); // 两次 agent 编辑之间被外力改动
    await checkpointPrepare(S, ws, "t1", ["z.ts"]); // 第二次编辑的 prepare 检出 diverged
    put("z.ts", "agent2\n");
    await checkpointCapture(S, ws, "t1", ["z.ts"]);

    const files = await checkpointStatus(S, ws, "t1");
    expect(files[0]).toMatchObject({ rel: "z.ts", exact: false, undoable: true });
    const res = await checkpointUndo(S, ws, "t1", "z.ts");
    expect("rel" in res).toBe(true);
    expect(readFileSync(join(ws, "z.ts"), "utf8")).toBe("base\n"); // 回滚目标=本轮首次编辑前
  });

  test("second turn keeps its own baseline; first turn row stops being undoable", async () => {
    put("m.ts", "v0\n");
    await checkpointPrepare(S, ws, "t1", ["m.ts"]);
    put("m.ts", "v1\n");
    await checkpointCapture(S, ws, "t1", ["m.ts"]);
    await checkpointPrepare(S, ws, "t2", ["m.ts"]); // t2 基线 = v1
    put("m.ts", "v2\n");
    await checkpointCapture(S, ws, "t2", ["m.ts"]);

    const t1 = await checkpointStatus(S, ws, "t1");
    expect(t1[0].undoable).toBe(false); // 当前 v2 ≠ t1 after v1
    const t2 = await checkpointStatus(S, ws, "t2");
    expect(t2[0]).toMatchObject({ undoable: true });

    await checkpointUndo(S, ws, "t2", "m.ts");
    expect(readFileSync(join(ws, "m.ts"), "utf8")).toBe("v1\n");
    const t1b = await checkpointStatus(S, ws, "t1");
    expect(t1b[0].undoable).toBe(true); // 回退到 v1 后 t1 的行重新可回滚
  });

  test("absolute file_path and forward/back slash forms hit the same record", async () => {
    const abs = put("deep/nest/f.txt", "x\n");
    await checkpointPrepare(S, ws, "t1", [abs]); // 绝对路径（工具参数同款）
    writeFileSync(abs, "y\n");
    await checkpointCapture(S, ws, "t1", [abs]);
    const files = await checkpointStatus(S, ws, "t1");
    expect(files[0].rel).toBe("deep/nest/f.txt");
    expect(files[0].undoable).toBe(true);
  });

  test("paths outside the workspace are ignored", async () => {
    await checkpointPrepare(S, ws, "t1", ["../escape.txt", resolve(ws, "..", "out.txt")]);
    put("in.ts", "1\n");
    await checkpointPrepare(S, ws, "t1", ["in.ts"]);
    put("in.ts", "2\n");
    await checkpointCapture(S, ws, "t1", ["in.ts"]);
    const files = await checkpointStatus(S, ws, "t1");
    expect(files.map((f) => f.rel)).toEqual(["in.ts"]);
  });

  test("cwd change wipes and re-baselines", async () => {
    put("a.ts", "1\n");
    await checkpointPrepare(S, ws, "t1", ["a.ts"]);
    put("a.ts", "2\n");
    await checkpointCapture(S, ws, "t1", ["a.ts"]);
    const ws2 = mkdtempSync(join(tmpdir(), "kova-ws2-"));
    roots.push(ws2);
    await checkpointPrepare(S, ws2, "t2", ["b.ts"]);
    expect(await checkpointStatus(S, ws, "t1")).toHaveLength(0); // 旧 cwd 查询空
    const st = await checkpointStatus(S, ws2, "t2");
    expect(st).toHaveLength(0); // 只 prepare 未 capture：不展示
  });

  test("oversized file is skipped and never undoable; small sibling still works", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 10);
    put("big.bin", big);
    await checkpointPrepare(S, ws, "t1", ["big.bin", "small.ts"]);
    put("big.bin", big + "more");
    put("small.ts", "ok\n");
    await checkpointCapture(S, ws, "t1", ["big.bin", "small.ts"]);
    const files = await checkpointStatus(S, ws, "t1");
    const bigRow = files.find((f) => f.rel === "big.bin");
    expect(bigRow?.undoable).toBe(false);
    expect(bigRow?.exact).toBe(false);
    const res = await checkpointUndo(S, ws, "t1", "big.bin");
    expect("error" in res && res.error).toBe("skipped");
  });

  test("binary content reports unknown stats but stays undoable", async () => {
    const buf = Buffer.from([1, 2, 0, 4, 5]);
    writeFileSync(put("blob.bin", "placeholder"), buf);
    await checkpointPrepare(S, ws, "t1", ["blob.bin"]);
    writeFileSync(join(ws, "blob.bin"), Buffer.from([9, 8, 7]));
    await checkpointCapture(S, ws, "t1", ["blob.bin"]);
    const files = await checkpointStatus(S, ws, "t1");
    expect(files[0]).toMatchObject({ additions: -1, deletions: -1, undoable: true });
    const diff = await checkpointDiff(S, ws, "t1", "blob.bin");
    expect(diff?.binary).toBe(true);
  });

  test("symlink in path blocks undo", async () => {
    put("real/f.txt", "base\n");
    mkdirSync(join(ws, "dir"), { recursive: true });
    symlinkSync(join(ws, "real"), join(ws, "dir", "link"));
    await checkpointPrepare(S, ws, "t1", ["dir/link/f.txt"]); // 基线 = 经链接的 base
    writeFileSync(join(ws, "real", "f.txt"), "agent\n");
    await checkpointCapture(S, ws, "t1", ["dir/link/f.txt"]);
    // rel 不做 realpath（与工具参数同形），路径分量含 link → 符号链接门拒绝回写
    const files = await checkpointStatus(S, ws, "t1");
    expect(files[0].rel).toBe("dir/link/f.txt");
    expect(files[0].undoable).toBe(false);
    const res = await checkpointUndo(S, ws, "t1", "dir/link/f.txt");
    expect("error" in res && res.error).toBe("symlink");
    expect(readFileSync(join(ws, "real", "f.txt"), "utf8")).toBe("agent\n");
  });

  test("undo after file vanished externally is refused, then re-capture re-owns", async () => {
    put("gone.ts", "v1\n");
    await checkpointPrepare(S, ws, "t1", ["gone.ts"]);
    put("gone.ts", "v2\n");
    await checkpointCapture(S, ws, "t1", ["gone.ts"]);
    rmSync(join(ws, "gone.ts"));
    const res = await checkpointUndo(S, ws, "t1", "gone.ts");
    expect("error" in res && res.error).toBe("changed-after");
  });

  test("turn pruning caps at 24 records", async () => {
    put("p.ts", "base\n");
    for (let i = 1; i <= 26; i++) {
      const tid = `turn-${i}`;
      await checkpointPrepare(S, ws, tid, ["p.ts"]);
      writeFileSync(join(ws, "p.ts"), `v${i}\n`);
      await checkpointCapture(S, ws, tid, ["p.ts"]);
    }
    expect(await checkpointStatus(S, ws, "turn-1")).toHaveLength(0);
    expect(await checkpointStatus(S, ws, "turn-2")).toHaveLength(0);
    expect(await checkpointStatus(S, ws, "turn-3")).toHaveLength(1);
    const latest = await checkpointStatus(S, ws, "turn-26");
    expect(latest[0].undoable).toBe(true);
  });

  test("forget deletes the session checkpoint directory", async () => {
    put("f.ts", "a\n");
    await checkpointPrepare(S, ws, "t1", ["f.ts"]);
    put("f.ts", "b\n");
    await checkpointCapture(S, ws, "t1", ["f.ts"]);
    checkpointForget(S);
    // 同会话队列串行：forget 排在其后，status 落定即 forget 已结算
    expect(await checkpointStatus(S, ws, "t1")).toEqual([]);
    expect(existsSync(join(ckDir, S))).toBe(false);
  });

  test("broken checkpoint root degrades silently and never rejects", async () => {
    const blocker = join(tmpdir(), `kova-ck-blocker-${Date.now()}`);
    writeFileSync(blocker, "not a directory");
    roots.push(blocker);
    process.env.PI_CHECKPOINT_DIR = join(blocker, "sub");
    put("d.ts", "1\n");
    await checkpointPrepare(S, ws, "t1", ["d.ts"]); // mkdir 必失败
    put("d.ts", "2\n");
    await checkpointCapture(S, ws, "t1", ["d.ts"]);
    expect(await checkpointStatus(S, ws, "t1")).toEqual([]);
    rmSync(blocker, { force: true });
  });
});
