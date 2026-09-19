/**
 * 构建 sidecar 单文件二进制到 Tauri externalBin 约定路径：
 *   src-tauri/binaries/pi-agent-<rustc host 三元组>（Windows 上自动追加 .exe）
 *
 * 用 rustc 的 host 三元组而不是硬编码平台，保证本地与 CI 矩阵
 * （macos-latest / windows-latest）各自原生构建时产物路径都正确。
 */
const rustc = Bun.spawnSync(["rustc", "-vV"]);
const host = /^host:\s*(.+)$/m.exec(rustc.stdout.toString())?.[1];
if (!host) {
  console.error(rustc.stderr.toString());
  throw new Error("无法从 rustc -vV 解析 host 三元组，请确认 rustc 已安装并在 PATH 中");
}

// 包根目录（scripts/ 的上一级），bun build 与 outfile 的相对路径都以它为基准
const pkgRoot = new URL("..", import.meta.url).pathname;
const outfile = `../../../apps/desktop/src-tauri/binaries/pi-agent-${host}`;
const build = Bun.spawnSync(["bun", "build", "src/index.ts", "--compile", "--outfile", outfile], {
  cwd: pkgRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
