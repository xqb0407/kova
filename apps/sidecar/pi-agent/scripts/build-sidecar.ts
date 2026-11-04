/**
 * 构建 sidecar 单文件二进制到 Electron 壳的产物目录：
 *   原 Rust 宿主/binaries/pi-agent-<rustc host 三元组>（Windows 上自动追加 .exe）
 *
 * 用 rustc 的 host 三元组而不是硬编码平台，保证本地与 CI 矩阵
 * （macos-latest / windows-latest）各自原生构建时产物路径都正确。
 *
 * compile 后**冒烟验产物**：拉起刚编出来的二进制，走一次 ping/pong。dev 模式下
 * sidecar 只在 electron dev 启动那刻编一次，之后改 TS 源码不会自动生效——真正
 * 咬人的场景是「产物压根没跑起来」：三元组写错落到了别的路径、上一台机器的
 * 旧二进制被照单全收、编出来启动即崩。没有这一步，这些都要等到用户发出第一
 * 条消息才以"助手没反应"的形式暴露出来，而那时人已经在查模型/网络了。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

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

// Electron 壳：产物进 apps/electron/binaries/（宿主 pi-agent.ts 按此路径拉起）
const outfileDir = resolve(pkgRoot, "../../electron/binaries");
mkdirSync(outfileDir, { recursive: true });
const outfile = `../../electron/binaries/kova-worker-${host}`;
// 清掉上一次编译的两种命名，避免 Bun 是否补 .exe 的差异留下陈旧产物
rmSync(resolve(pkgRoot, outfile), { force: true });
rmSync(resolve(pkgRoot, `${outfile}.exe`), { force: true });
const build = Bun.spawnSync(["bun", "build", "src/index.ts", "--compile", "--outfile", outfile], {
  cwd: pkgRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

// Bun 在 Windows 上可能自动补 .exe；两种都探一下，后面复制/冒烟用同一路径
const compiledPath = [
  resolve(pkgRoot, outfile),
  resolve(pkgRoot, `${outfile}.exe`),
].find((p) => existsSync(p));
if (!compiledPath) {
  console.error(`✗ 找不到编译产物：${resolve(pkgRoot, outfile)}(.exe)`);
  process.exit(1);
}

// 改名卫生：清掉旧名（pi-agent*）产物，免得打包目录里新旧两套并存、
// 任务管理器里也看不出到底在跑哪个
for (const stale of readdirSync(outfileDir)) {
  const isOldName = stale.startsWith("pi-agent");
  const isRunDroppings = stale.endsWith(".db") || stale.includes(".db-") || stale === "sessions";
  if (isOldName || isRunDroppings) {
    rmSync(join(outfileDir, stale), { recursive: true, force: true });
    console.log(`[build] 清理 ${isOldName ? "旧名产物" : "运行残留"}：${stale}`);
  }
}

// 稳定别名：宿主按不带三元组的 kova-worker(.exe) 拉起，免去运行时解析 host triple
const aliasExt = process.platform === "win32" ? ".exe" : "";
const aliasPath = join(outfileDir, `kova-worker${aliasExt}`);
try {
  copyFileSync(compiledPath, aliasPath);
} catch (err) {
  console.error(`✗ 复制稳定别名失败：${aliasPath}`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// macOS：必须重新 ad-hoc 签名，不能留 bun 的 linker-signed 状态。
// 实测（Apple Silicon，macOS 24.6）：bun --compile 产物带 flags=adhoc,linker-signed
// 且 `codesign --verify` 报 "code or signature have been modified"；该状态的二进制
// 被 cp 成别名后，内核 exec 会既不运行也不报错地**卡死**——进程停在 UE 状态、零输出、
// kill -9 无效，表现为「app 起得来、界面却一片空白」：侧车从不回 host_query，
// 渲染层 15s 超时（会话列表/资源管理器全空）。`codesign --force --sign -` 后
// verify 通过、启动稳定。打包版此前一直正常，正是 afterPack 深度签名把 bundle 里的
// 二进制重签了一遍——这条注释是给「为什么开发态也必须签」留的证据。
if (process.platform === "darwin") {
  for (const target of [resolve(pkgRoot, outfile), aliasPath]) {
    const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", target], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (sign.exitCode !== 0) {
      console.error(`✗ ad-hoc 签名失败：${target}\n${sign.stderr.toString()}`);
      process.exit(sign.exitCode ?? 1);
    }
  }
}

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
      // 编译产物必须真的能加载 shell 解析器的 WASM；失败则启动期直接崩，
      // 让 build smoke 拦住，而不是等线上第一条命令才降级。
      PI_SHELL_POLICY_SELFTEST: "1",
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
  await smokeCheck(compiledPath);
} catch (err) {
  const stderr = (err as { stderr?: string }).stderr ?? "";
  console.error(
    `\nsidecar 冒烟失败：${err instanceof Error ? err.message : String(err)}\n` +
      `产物：${compiledPath}\n` +
      `宿主三元组：${host}\n` +
      (stderr ? `产物 stderr：\n${stderr.slice(0, 2000)}\n` : "") +
      `若产物根本不在该路径，先删掉 原 Rust 宿主/binaries/ 下别的三元组产物再重编。`,
  );
  process.exit(1);
}
