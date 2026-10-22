import { describe, expect, test } from "bun:test";
import { join as joinWin32 } from "node:path/win32";
import { resolveShell } from "../main/shell-resolve";

/** existsSync 注入：传入的路径集合视为存在；分隔符/大小写归一，兼容 macOS 上跑 win32 分支 */
function fakeExists(...existing: string[]) {
  const set = new Set(existing.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  return (path: string) => set.has(path.replace(/\\/g, "/").toLowerCase());
}

const noExists = fakeExists();

const REAL_GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const WSL_STUB = "C:\\Windows\\System32\\bash.exe";

describe("resolveShell (win32)", () => {
  // join 用真实 Windows 语义（macOS/CI 上也能确定性测试 win32 分支）
  const resolveWin = (
    env: { PATH?: string; LOCALAPPDATA?: string },
    exists: (path: string) => boolean,
  ) => resolveShell("win32", env, exists, joinWin32);

  test("non-win32 keeps /bin/bash", () => {
    expect(resolveShell("darwin", {}, noExists, joinWin32)).toEqual({
      file: "/bin/bash",
      prefixArgs: ["-c"],
    });
  });

  test("硬编码 Git Bash 优先，PATH 里有 WSL stub 也不影响", () => {
    const exists = fakeExists(REAL_GIT_BASH, WSL_STUB);
    expect(
      resolveWin({ PATH: "C:\\Windows\\System32;C:\\tools" }, exists),
    ).toEqual({ file: REAL_GIT_BASH, prefixArgs: ["-c"] });
  });

  test("WSL stub 不被选中：PATH 只有 stub 时落到 cmd.exe", () => {
    const exists = fakeExists(WSL_STUB);
    expect(resolveWin({ PATH: "C:\\Windows\\System32" }, exists)).toEqual({
      file: "cmd.exe",
      prefixArgs: ["/d", "/s", "/c"],
    });
  });

  test("git.exe 目录反推出的 bash 优先于 PATH 扫描", () => {
    const exists = fakeExists("C:/Git/cmd/git.exe", "C:/Git/bin/bash.exe");
    expect(resolveWin({ PATH: "C:\\Git\\cmd" }, exists)).toEqual({
      file: "C:\\Git\\bin\\bash.exe",
      prefixArgs: ["-c"],
    });
  });

  test("PATH 扫描命中非 System32 的 bash（如 MSYS2）", () => {
    const exists = fakeExists("D:/msys64/usr/bin/bash.exe");
    expect(resolveWin({ PATH: "D:\\msys64\\usr\\bin" }, exists)).toEqual({
      file: "D:\\msys64\\usr\\bin\\bash.exe",
      prefixArgs: ["-c"],
    });
  });

  test("LOCALAPPDATA 下的 per-user Git Bash 可被选中", () => {
    const exists = fakeExists("C:/Users/u/AppData/Local/Programs/Git/bin/bash.exe");
    expect(
      resolveWin(
        { PATH: "", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        exists,
      ),
    ).toEqual({
      file: "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
      prefixArgs: ["-c"],
    });
  });

  test("Git Bash 都缺失且 PATH 只有 WSL stub：cmd.exe 兜底", () => {
    expect(
      resolveWin(
        { PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        noExists,
      ),
    ).toEqual({ file: "cmd.exe", prefixArgs: ["/d", "/s", "/c"] });
  });

  test("System32 stub 过滤是大小写/分隔符不敏感的", () => {
    const exists = fakeExists("C:\\Windows\\SYSTEM32\\bash.exe");
    expect(resolveWin({ PATH: "C:\\Windows\\SYSTEM32" }, exists)).toEqual({
      file: "cmd.exe",
      prefixArgs: ["/d", "/s", "/c"],
    });
  });

  test("PATH 项用正斜杠（join 会产生混合分隔符）同样过滤得住", () => {
    const exists = fakeExists("C:/Windows/System32/bash.exe");
    expect(resolveWin({ PATH: "C:/Windows/System32" }, exists)).toEqual({
      file: "cmd.exe",
      prefixArgs: ["/d", "/s", "/c"],
    });
  });
});
