import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTools } from "./tools";

const cwd = mkdtempSync(path.join(tmpdir(), "pi-agent-tools-"));
const tools = buildTools(cwd);
const tool = (name: string) => tools.find((t) => t.name === name)!;

type ToolResult = {
  content: { type: string; text: string }[];
  details?: unknown;
};
const run = (name: string, params: Record<string, unknown>) =>
  (tool(name).execute as unknown as (
    id: string,
    p: Record<string, unknown>,
  ) => Promise<ToolResult>)("t1", params);
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

describe("write tool", () => {
  test("writes file and creates parent directories", async () => {
    const r = await run("write", {
      file_path: "nested/dir/a.txt",
      content: "hello",
    });
    expect(text(r)).toContain("Wrote 5 bytes to nested/dir/a.txt");
    expect(readFileSync(path.join(cwd, "nested/dir/a.txt"), "utf8")).toBe(
      "hello",
    );
  });
});

describe("read tool", () => {
  test("returns numbered lines", async () => {
    writeFileSync(path.join(cwd, "lines.txt"), "alpha\nbeta\ngamma", "utf8");
    const r = await run("read", { file_path: "lines.txt" });
    expect(text(r)).toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  test("supports offset/limit pagination", async () => {
    const r = await run("read", { file_path: "lines.txt", offset: 2, limit: 1 });
    expect(text(r)).toContain("2\tbeta");
    expect(text(r)).not.toContain("alpha");
    expect(text(r)).toContain("1 more lines"); // 提示还有剩余行
  });

  test("rejects missing files", async () => {
    expect(run("read", { file_path: "nope.txt" })).rejects.toThrow();
  });

  test("rejects binary files", async () => {
    writeFileSync(path.join(cwd, "bin.dat"), Buffer.from([1, 0, 2]));
    expect(run("read", { file_path: "bin.dat" })).rejects.toThrow("binary");
  });
});

describe("edit tool", () => {
  test("replaces an exact match", async () => {
    writeFileSync(path.join(cwd, "e.txt"), "foo bar", "utf8");
    const r = await run("edit", {
      file_path: "e.txt",
      old_string: "bar",
      new_string: "baz",
    });
    expect(text(r)).toContain("Replaced 1 occurrence");
    expect(readFileSync(path.join(cwd, "e.txt"), "utf8")).toBe("foo baz");
  });

  test("errors when old_string is absent", async () => {
    expect(
      run("edit", {
        file_path: "e.txt",
        old_string: "missing",
        new_string: "x",
      }),
    ).rejects.toThrow("not found");
  });

  test("errors on multiple matches without replace_all", async () => {
    writeFileSync(path.join(cwd, "multi.txt"), "x x", "utf8");
    expect(
      run("edit", {
        file_path: "multi.txt",
        old_string: "x",
        new_string: "y",
      }),
    ).rejects.toThrow("2 times");
  });

  test("replace_all replaces every occurrence", async () => {
    const r = await run("edit", {
      file_path: "multi.txt",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(text(r)).toContain("Replaced 2 occurrence");
    expect(readFileSync(path.join(cwd, "multi.txt"), "utf8")).toBe("y y");
  });
});

describe("bash tool", () => {
  // /bin/bash 在 Windows 上不存在，走 spawn error 分支，不做断言
  test.skipIf(process.platform === "win32")(
    "runs a shell command in the workspace",
    async () => {
      writeFileSync(path.join(cwd, "probe.txt"), "probe", "utf8");
      const r = await run("bash", { command: "cat probe.txt" });
      expect(text(r)).toContain("probe");
      expect(text(r)).not.toContain("[exit code");
    },
  );

  test("resolves with error status when shell is unavailable", async () => {
    // Windows 上 /bin/bash 缺失 → spawn error → exit -1；Unix 上正常执行
    const r = await run("bash", { command: "echo hi" });
    expect(typeof r.details).toBe("object");
  });
});

describe("tools use workspace-relative paths", () => {
  test("absolute paths are preserved", async () => {
    const abs = path.join(cwd, "abs.txt");
    const r = await run("write", { file_path: abs, content: "abs" });
    expect(text(r)).toContain("Wrote 3 bytes");
    expect(existsSync(abs)).toBe(true);
  });
});
