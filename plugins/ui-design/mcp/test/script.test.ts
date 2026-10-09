/**
 * runDesignScript 沙箱单测：操作录制（I/U/log/返回值）、超时硬中断、
 * 语法错误与运行时报错的可读消息、逃逸桩、以及 op 上限。
 */
import { describe, expect, test } from "bun:test";
import { runDesignScript, SCRIPT_MAX_OPS } from "../script";

describe("run_design_script 沙箱", () => {
  test("I/U 录出操作，log 收集中间量，脚本返回值透传", async () => {
    const r = await runDesignScript(`
      const row = I("frame1", { type: "frame", name: "行", y: 100 });
      const label = I(row, { type: "text", text: "标题", w: 200 });
      U(label, { x: 12, color: "#ff0000" });
      log("建了", 2, "个节点");
      return row;
    `);
    expect(r.ops).toHaveLength(3);
    expect(r.ops[0]).toMatchObject({ kind: "insert", parent: "frame1" });
    expect((r.ops[0] as { spec: { id: string } }).spec.id).toBeTruthy();
    // 第二个节点的 parent 用的是 I() 返回的自动 id，串得起来
    expect(r.ops[1]).toMatchObject({ kind: "insert", parent: (r.ops[0] as { spec: { id: string } }).spec.id });
    expect(r.ops[2]).toMatchObject({ kind: "update", patch: { x: 12, color: "#ff0000" } });
    expect(r.logs).toEqual(["建了 2 个节点"]);
    expect(r.result).toBe((r.ops[0] as { spec: { id: string } }).spec.id);
  });

  test("显式给的 id 优先于自动 id", async () => {
    const r = await runDesignScript(`I("f1", { type: "rect", id: "my-rect" });`);
    expect((r.ops[0] as { spec: { id: string } }).spec.id).toBe("my-rect");
  });

  test("循环批量录制（列表 12 行这类真实用法）", async () => {
    const items = Array.from({ length: 12 }, (_, i) => `第${i}项`);
    const r = await runDesignScript(`
      const items = ${JSON.stringify(items)};
      for (let i = 0; i < items.length; i++) {
        const row = I("list", { type: "frame", name: "行" + i, y: i * 56, h: 48 });
        I(row, { type: "text", text: items[i], w: 300 });
      }
    `);
    // 每行 1 个 frame + 1 个 text
    expect(r.ops).toHaveLength(24);
    expect((r.ops[0] as { spec: { y: number } }).spec.y).toBe(0);
    expect((r.ops[22] as { spec: { y: number } }).spec.y).toBe(11 * 56);
  });

  test("死循环被超时硬中断，报错说清是被 terminate 的", async () => {
    const started = Date.now();
    await expect(runDesignScript("while (true) {}", 600)).rejects.toThrow(/超过 600ms/);
    // 必须在超时附近返回，而不是挂死
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15000);

  test("语法错误 → 可读报错，带栈信息", async () => {
    await expect(runDesignScript("const x = ;")).rejects.toThrow(/脚本报错/);
  });

  test("运行时报错原样透出（含 I 的参数校验）", async () => {
    await expect(runDesignScript(`I("", { type: "rect" })`)).rejects.toThrow(/parentId 必须是非空字符串/);
    await expect(runDesignScript(`U("a", [1,2])`)).rejects.toThrow(/patch 必须是字段对象/);
  });

  test("require/process/fetch 是抛错桩，不会真的碰到宿主能力", async () => {
    await expect(runDesignScript(`require("node:fs")`)).rejects.toThrow(/沙箱禁用 require\(\)/);
    await expect(runDesignScript(`process.exit(1)`)).rejects.toThrow(/沙箱禁用 process\.exit/);
    await expect(runDesignScript(`fetch("http://x")`)).rejects.toThrow(/沙箱禁用 fetch\(\)/);
    await expect(runDesignScript(`Buffer.from("x")`)).rejects.toThrow(/沙箱禁用 Buffer\.from/);
  }, 15000);

  test("空脚本报可读错误而不是崩", async () => {
    await expect(runDesignScript("   ")).rejects.toThrow(/script 必填/);
  });

  test("操作数超上限被拦下", async () => {
    const many = `for (let i = 0; i < ${SCRIPT_MAX_OPS + 10}; i++) I("f1", { type: "rect" });`;
    await expect(runDesignScript(many, 20000)).rejects.toThrow(new RegExp(`超过上限 ${SCRIPT_MAX_OPS}`));
  }, 25000);

  test("脚本抛异常时报错信息带原始堆栈", async () => {
    await expect(runDesignScript(`throw new Error("boom")`)).rejects.toThrow(/boom/);
  });
});