/**
 * 构建 sidecar 单文件二进制到 Tauri externalBin 约定路径：
 *   src-tauri/binaries/pi-agent-<rustc host 三元组>（Windows 上自动追加 .exe）
 *
 * 用 rustc 的 host 三元组而不是硬编码平台，保证本地与 CI 矩阵
 * （macos-latest / windows-latest）各自原生构建时产物路径都正确。
 *
 * compile 前重打内置插件包 zip（提交进仓库的产物可能与源漂移——build 兜底
 * 重打，同源同字节幂等）：见 scripts/build-builtin-plugins-zip.ts。
 *
 * compile 后**冒烟验产物**：拉起刚编出来的二进制，走一次 ping/pong。dev 模式下
 * sidecar 只在 tauri dev 启动那刻编一次，之后改 TS 源码不会自动生效——真正
 * 咬人的场景是「产物压根没跑起来」：三元组写错落到了别的路径、上一台机器的
 * 旧二进制被照单全收、编出来启动即崩。没有这一步，这些都要等到用户发出第一
 * 条消息才以"助手没反应"的形式暴露出来，而那时人已经在查模型/网络了。
 */
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const rustc = Bun.spawnSync(["rustc", "-vV"]);
const host = /^host:\s*(.+)$/m.exec(rustc.stdout.toString())?.[1];
if (!host) {
  console.error(rustc.stderr.toString());
  throw new Error("无法从 rustc -vV 解析 host 三元组，请确认 rustc 已安装并在 PATH 中");
}

// 包根目录（scripts/ 的上一级），bun build 与 outfile 的相对路径都以它为基准。
// 必须用 import.meta.dir：new URL("..", import.meta.url).pathname 在 Windows 上
// 会返回 "/D:/Users/..." 这种带前导斜杠的非法路径，当 cwd 用会让 bun build
// 找不到入口文件。口径与同目录另两个脚本一致。
const pkgRoot = resolve(import.meta.dir, "..");

// 面板 HTML 为构建产物不入库：缺失时先构建（root scripts/build-plugins.mjs 幂等，
// 已有产物即刻跳过）。放在这里保证任何入口——npm/tauri beforeBuildCommand、bun、
// CI——都能自愈，调用方不必各自记得前置 build:plugins。
const plugins = Bun.spawnSync([process.execPath, resolve(pkgRoot, "../../../scripts/build-plugins.mjs")], {
  cwd: pkgRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (plugins.exitCode !== 0) process.exit(plugins.exitCode ?? 1);

// 先重打内置插件包：`import ... with { type: "file" }` 在 compile 期读盘嵌入，
// zip 不提交仓库，缺失时必须先产出（幂等：内容不变 zip 字节不变）
const pack = Bun.spawnSync(["bun", "run", "scripts/build-builtin-plugins-zip.ts"], {
  cwd: pkgRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (pack.exitCode !== 0) process.exit(pack.exitCode ?? 1);

const outfile = `../../../apps/desktop/src-tauri/binaries/pi-agent-${host}`;
const build = Bun.spawnSync(["bun", "build", "src/index.ts", "--compile", "--outfile", outfile], {
  cwd: pkgRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

/** 冒烟：起进程 → 写一行 ping → 等 pong。任一环不成立即构建失败（带 stderr）。 */
async function smokeCheck(binary: string): Promise<void> {
  // 必须跑**本地模式**（不注入 PI_SESSIONS_DIR）：宿主模式下 sidecar 启动即向
  // 宿主发 host_query（加载自定义提供商），没有 Rust 应答就永远卡在初始化闸门，
  // 我们的 ping 排在闸门后面，永远等不到 pong。本地模式用进程内 SQLite，
  // 不碰开发机真实数据，答得也快。
  const sandbox = resolve(pkgRoot, ".build-smoke");
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  const proc = Bun.spawn([binary], {
    cwd: sandbox,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PI_SESSIONS_DIR: undefined,
      PI_DB_PATH: resolve(sandbox, "smoke.db"),
      PI_TASK_CWD: resolve(sandbox, "task-workspace"),
    },
  });
  let stderr = "";
  void new Response(proc.stderr).text().then((t) => (stderr = t));
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => void proc.kill(), 30_000);
  // stderr 在 finally 之后才可能读全（进程刚退），所以把失败连同它一起抛出
  const fail = (msg: string): never => {
    const e = new Error(msg) as Error & { stderr?: string };
    e.stderr = stderr;
    throw e;
  };
  try {
    proc.stdin.write(JSON.stringify({ type: "ping", id: "buildcheck" }) + "\n");
    proc.stdin.flush();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split("\n")) {
        if (!line.includes("buildcheck")) continue;
        try {
          const frame = JSON.parse(line) as { id?: string; type?: string };
          if (frame.id === "buildcheck" && frame.type === "pong") {
            console.log(`sidecar smoke check ok (${host})`);
            return;
          }
        } catch {
          /* 半行/非 JSON 噪声：继续读到 pong 为止 */
        }
      }
    }
    fail("产物启动后没有回应 ping（进程先退了？）");
  } finally {
    clearTimeout(timer);
    proc.kill();
    await proc.exited;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

try {
  await smokeCheck(resolve(pkgRoot, outfile));
} catch (err) {
  const stderr = (err as { stderr?: string }).stderr ?? "";
  console.error(
    `\nsidecar 冒烟失败：${err instanceof Error ? err.message : String(err)}\n` +
      `产物：${outfile}\n` +
      `宿主三元组：${host}\n` +
      (stderr ? `产物 stderr：\n${stderr.slice(0, 2000)}\n` : "") +
      `若产物根本不在该路径，先删掉 src-tauri/binaries/ 下别的三元组产物再重编。`,
  );
  process.exit(1);
}
