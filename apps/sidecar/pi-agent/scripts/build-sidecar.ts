/**
 * 构建 sidecar 单文件二进制到 Electron 壳的产物目录：
 *   apps/electron/binaries/kova-worker-<rustc host 三元组>（Windows 上自动追加 .exe）
 *
 * 现在一并构建 kova-automation（独立调度进程）。两者共用同一套：
 * bun --compile → 稳定别名 → macOS ad-hoc 签名 → ping/pong 冒烟。
 *
 * 优先用 rustc 的 host 三元组；没装 rustc 的开发机回退到 platform/arch 映射表，
 * 保证本地与 CI 矩阵（macos-latest / windows-latest）各自原生构建时产物路径正确。
 *
 * compile 后**冒烟验产物**：拉起刚编出来的二进制，走一次 ping/pong。dev 模式下
 * sidecar 只在 electron dev 启动那刻编一次，之后改 TS 源码不会自动生效——真正
 * 咬人的场景是「产物压根没跑起来」：三元组写错落到了别的路径、上一台机器的
 * 旧二进制被照单全收、编出来启动即崩。没有这一步，这些都要等到用户发出第一
 * 条消息才以"助手没反应"的形式暴露出来，而那时人已经在查模型/网络了。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** platform/arch → rustc host 三元组（rustc 不在 PATH 时的回退映射） */
const HOST_FALLBACK: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

/** 需要构建的二进制；顺序即构建/冒烟顺序。
 *  extraEntries 是 `--compile` 的附加入口：被 Bun 嵌进二进制，运行时按
 *  相对源码路径解析（PTC 的 QuickJS worker 用，见 tools/codemode-runtime.ts）。 */
const BINARIES = [
  {
    name: "kova-worker",
    entry: "src/index.ts",
    label: "sidecar",
    extraEntries: ["src/tools/codemode-worker.ts"],
  },
  { name: "kova-automation", entry: "src/automation/entry.ts", label: "automation", extraEntries: [] },
] as const;

// 包根目录（scripts/ 的上一级），bun build 与 outfile 的相对路径都以它为基准。
// 必须用 import.meta.dir：new URL("..", import.meta.url).pathname 在 Windows 上
// 会返回 "/D:/Users/..." 这种带前导斜杠的非法路径，当 cwd 用会让 bun build
// 找不到入口文件。口径与同目录另两个脚本一致。
const pkgRoot = resolve(import.meta.dir, "..");

// Electron 壳：产物进 apps/electron/binaries/（宿主按稳定别名拉起）
const outfileDir = resolve(pkgRoot, "../../electron/binaries");
const aliasExt = process.platform === "win32" ? ".exe" : "";

interface BuiltBinary {
  name: string;
  label: string;
  compiledPath: string;
}

/** Bun.spawnSync 对 ENOENT 是**抛异常**而不是返回非零：rustc 缺席必须捕获，
 *  走 platform/arch 回退映射（否则没装 rustc 的开发机连第一行都过不去）。 */
function resolveHostTriple(): string {
  let host: string | undefined;
  try {
    const rustc = Bun.spawnSync(["rustc", "-vV"]);
    host = /^host:\s*(.+)$/m.exec(rustc.stdout.toString())?.[1];
  } catch {
    /* rustc 不在 PATH：走 platform/arch 回退 */
  }
  host ??= HOST_FALLBACK[`${process.platform}-${process.arch}`];
  if (!host) {
    throw new Error(
      "无法解析 host 三元组：rustc 不在 PATH 中，且平台映射表里没有 " +
        `${process.platform}-${process.arch}`,
    );
  }
  return host;
}

/** 改名卫生：清掉旧名（pi-agent*）产物与本地模式运行残留，免得打包目录里
 *  新旧两套并存、任务管理器里也看不出到底在跑哪个。 */
function cleanupLegacyArtifacts(): void {
  mkdirSync(outfileDir, { recursive: true });
  for (const stale of readdirSync(outfileDir)) {
    const isOldName = stale.startsWith("pi-agent");
    const isRunDroppings =
      stale.endsWith(".db") || stale.includes(".db-") || stale === "sessions";
    if (isOldName || isRunDroppings) {
      rmSync(join(outfileDir, stale), { recursive: true, force: true });
      console.log(`[build] 清理 ${isOldName ? "旧名产物" : "运行残留"}：${stale}`);
    }
  }
}

function adhocSignDarwin(targets: string[]): void {
  if (process.platform !== "darwin") return;

  // macOS：必须重新 ad-hoc 签名，不能留 bun 的 linker-signed 状态。
  // 实测（Apple Silicon，macOS 24.6）：bun --compile 产物带 flags=adhoc,linker-signed
  // 且 `codesign --verify` 报 "code or signature have been modified"；该状态的二进制
  // 被 cp 成别名后，内核 exec 会既不运行也不报错地**卡死**——进程停在 UE 状态、
  // 零输出、kill -9 无效。`codesign --force --sign -` 后 verify 通过、启动稳定。
  for (const target of targets) {
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

/** 编译一个二进制并生成稳定别名；macOS 上补 ad-hoc 签名。 */
function buildBinary(
  host: string,
  name: string,
  entry: string,
  label: string,
  extraEntries: readonly string[] = [],
): BuiltBinary {
  const outfile = `../../electron/binaries/${name}-${host}`;
  // 清掉上一次编译的两种命名，避免 Bun 是否补 .exe 的差异留下陈旧产物
  rmSync(resolve(pkgRoot, outfile), { force: true });
  rmSync(resolve(pkgRoot, `${outfile}.exe`), { force: true });
  // --root 必须显式钉在包根：附加入口在编译产物里的 key 是「相对构建 root」的路径，
  // 而 root 默认取所有入口的共同祖先目录。入口是 src/index.ts + src/tools/... 时
  // 共同祖先是 src/，key 会变成 "./tools/codemode-worker.ts"，运行时按源码路径
  // "./src/tools/codemode-worker.ts" 就取不到，报 ModuleNotFound（Windows 实测）。
  const build = Bun.spawnSync(
    ["bun", "build", entry, ...extraEntries, "--compile", "--root", pkgRoot, "--outfile", outfile],
    {
      cwd: pkgRoot,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
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

  // 稳定别名：宿主按不带三元组的名字拉起，免去运行时解析 host triple
  const aliasPath = join(outfileDir, `${name}${aliasExt}`);
  try {
    copyFileSync(compiledPath, aliasPath);
  } catch (err) {
    console.error(`✗ 复制稳定别名失败：${aliasPath}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  adhocSignDarwin([resolve(pkgRoot, outfile), aliasPath]);
  return { name, label, compiledPath };
}

/** 冒烟：起进程 → 写一行 ping → 等 pong。任一环不成立即构建失败（带 stderr）。 */
async function smokeCheck(host: string, binary: string, label: string): Promise<void> {
  // 必须跑**本地模式**（不注入 PI_SESSIONS_DIR）：宿主模式下 sidecar 启动即向
  // 宿主发 host_query（加载自定义提供商），没有宿主应答就永远卡在初始化闸门，
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
      // 两个变量都要显式清空：automation entry 优先读 KOVA_SESSIONS_DIR，
      // 不能让开发机 shell 里偶发的值把冒烟写进真实 sessions 目录。
      PI_SESSIONS_DIR: undefined,
      KOVA_SESSIONS_DIR: undefined,
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
    const e = new Error(`[${label}] ${msg}`) as Error & { stderr?: string };
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
            console.log(`${label} smoke check ok (${host})`);
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

async function main(): Promise<void> {
  const host = resolveHostTriple();
  console.log(`[build] host triple: ${host}`);
  cleanupLegacyArtifacts();

  const built = BINARIES.map(({ name, entry, label, extraEntries }) =>
    buildBinary(host, name, entry, label, extraEntries),
  );
  for (const binary of built) {
    await smokeCheck(host, binary.compiledPath, binary.label);
    // ACP 冒烟只挂 sidecar（kova-worker）；automation 调度进程没有 ACP 形态
    if (binary.name === "kova-worker") {
      await acpSmokeCheck(host, binary.compiledPath);
    }
  }
}

/**
 * ACP 冒烟：--acp 启动后 stdout 必须是 JSON-RPC 2.0，initialize 必须回 result。
 * 这一步专门拦「SDK/zod 没打进单文件产物」「frame sink 没装、内部 NDJSON 泄漏」
 * 这类只在编译产物上出现的问题。
 */
async function acpSmokeCheck(host: string, binary: string): Promise<void> {
  const sandbox = resolve(pkgRoot, ".build-smoke-acp");
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  const proc = Bun.spawn([binary, "--acp"], {
    cwd: sandbox,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PI_SESSIONS_DIR: undefined,
      KOVA_ACP_DATA_DIR: sandbox,
    },
  });
  let stderr = "";
  void new Response(proc.stderr).text().then((t) => (stderr = t));
  const fail = (msg: string): never => {
    const e = new Error(msg) as Error & { stderr?: string };
    e.stderr = stderr;
    throw e;
  };
  const timer = setTimeout(() => void proc.kill(), 30_000);
  try {
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }) + "\n",
    );
    proc.stdin.flush();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split("\n")) {
        if (!line.trim() || !line.includes('"id":1')) continue;
        let parsed: {
          jsonrpc?: string;
          id?: number;
          result?: { protocolVersion?: number };
        } | null = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          fail(`ACP stdout 不是合法 JSON-RPC：${line.slice(0, 200)}`);
        }
        if (!parsed) continue;
        if (parsed.jsonrpc !== "2.0") {
          fail(`ACP stdout 出现非 JSON-RPC 行：${line.slice(0, 200)}`);
        }
        if (parsed.id === 1 && parsed.result?.protocolVersion === 1) {
          console.log(`sidecar ACP smoke check ok (${host})`);
          return;
        }
      }
    }
    fail("ACP 产物启动后没有回应 initialize（进程先退了？）");
  } finally {
    clearTimeout(timer);
    proc.kill();
    await proc.exited;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  const stderr = (err as { stderr?: string }).stderr ?? "";
  console.error(
    `\nsidecar 构建/冒烟失败：${err instanceof Error ? err.message : String(err)}\n` +
      (stderr ? `产物 stderr：\n${stderr.slice(0, 2000)}\n` : "") +
      `若产物根本不在该路径，先删掉 apps/electron/binaries/ 下别的三元组产物再重编。`,
  );
  process.exit(1);
}
