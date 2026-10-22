/**
 * macOS 沙箱兼容矩阵（开发用，不进 CI）：
 *   bun scripts/sandbox-matrix.ts
 *
 * 在真实 Seatbelt profile 下跑常见命令，确认写隔离没有误伤；同时验证
 * 工作区外写入仍被拒绝。脚本只在 darwin 上运行。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxPlan, DEFAULT_SANDBOX_CONFIG } from "../packages/pi-sandbox/src/index.ts";
import { buildSeatbeltProfile, isSeatbeltAvailable } from "../apps/electron/main/sandbox/seatbelt.ts";

if (process.platform !== "darwin") {
  console.log("skip: sandbox matrix is macOS-only");
  process.exit(0);
}
if (!isSeatbeltAvailable()) {
  console.error("fail: /usr/bin/sandbox-exec is not available");
  process.exit(1);
}

const project = mkdtempSync(join(tmpdir(), "kova-matrix-project-"));
const outside = mkdtempSync(join(tmpdir(), "kova-matrix-outside-"));
const tempRoot = mkdtempSync(join(tmpdir(), "kova-matrix-tmp-"));
const npmCache = join(project, ".npm-cache");
const home = homedir();

mkdirSync(npmCache, { recursive: true });
mkdirSync(join(project, ".kova"), { recursive: true });
writeFileSync(
  join(project, ".kova", "permissions.local.json"),
  '{"writeRoots":[]}\n',
);

const plan = buildSandboxPlan({
  cwd: project,
  tempRoot,
  homeDir: home,
  config: {
    ...DEFAULT_SANDBOX_CONFIG,
    tier: "workspace",
    allowPackageCaches: true,
  },
  platform: "darwin",
  env: process.env,
})!;
const profile = buildSeatbeltProfile(plan);

const env = {
  ...process.env,
  HOME: home,
  TMPDIR: tempRoot,
  TMP: tempRoot,
  TEMP: tempRoot,
  npm_config_cache: npmCache,
  GIT_AUTHOR_NAME: "Sandbox Matrix",
  GIT_AUTHOR_EMAIL: "sandbox@example.invalid",
  GIT_COMMITTER_NAME: "Sandbox Matrix",
  GIT_COMMITTER_EMAIL: "sandbox@example.invalid",
};

type Case = {
  name: string;
  command: string;
  expect: "pass" | "fail";
  check?: () => boolean | string;
};

const cases: Case[] = [
  {
    name: "git status/commit",
    command:
      "git init -q && printf hi > a.txt && git add a.txt && " +
      "git commit -qm init && git status --porcelain",
    expect: "pass",
    check: () => existsSync(join(project, ".git", "HEAD")),
  },
  {
    name: "node -e",
    command: "node -e 'process.stdout.write(String(1+1))'",
    expect: "pass",
    check: () => true,
  },
  {
    name: "bun test",
    command:
      "printf 'import { test, expect } from \"bun:test\"; test(\"x\", () => expect(1+1).toBe(2));\\n' > matrix.test.ts && " +
      "bun test matrix.test.ts",
    expect: "pass",
    check: () => existsSync(join(project, "matrix.test.ts")),
  },
  {
    name: "npm install (network)",
    command:
      "printf '{\"name\":\"matrix\",\"version\":\"1.0.0\"}\\n' > package.json && " +
      "npm install --ignore-scripts --no-audit --no-fund is-number@7",
    expect: "pass",
    check: () => existsSync(join(project, "node_modules", "is-number", "package.json")),
  },
  {
    name: "python3",
    command: "python3 -c 'print(1+1)'",
    expect: "pass",
    check: () => true,
  },
  {
    name: "make",
    command:
      "printf 'all:\\n\\tprintf ok > out.txt\\n' > Makefile && make -s && cat out.txt",
    expect: "pass",
    check: () => existsSync(join(project, "out.txt")),
  },
  {
    name: "deny write outside workspace",
    command: `printf bad > ${JSON.stringify(join(outside, "outside.txt"))}`,
    expect: "fail",
    check: () => !existsSync(join(outside, "outside.txt")),
  },
  {
    name: "deny permission file write",
    command: "printf bad > .kova/permissions.local.json",
    expect: "fail",
    check: () =>
      readFileSync(join(project, ".kova", "permissions.local.json"), "utf8") ===
      '{"writeRoots":[]}\n',
  },
];

let failures = 0;
for (const c of cases) {
  const started = Date.now();
  const r = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", profile, "/bin/bash", "-c", c.command],
    { cwd: project, env, encoding: "utf8", timeout: 180_000 },
  );
  const statusOk = c.expect === "pass" ? r.status === 0 : r.status !== 0;
  const check = c.check?.() ?? true;
  const checkOk = check === true;
  const detail =
    check === false
      ? "post-check failed"
      : typeof check === "string"
        ? check
        : "";
  const ok = statusOk && checkOk;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}  (${Date.now() - started}ms, exit=${r.status})${detail ? `  ${detail}` : ""}`,
  );
  if (!ok) {
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (out) console.log(out.split("\n").slice(-20).join("\n"));
  }
}

rmSync(project, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
rmSync(tempRoot, { recursive: true, force: true });

console.log(
  failures === 0
    ? "\nall sandbox matrix cases passed"
    : `\n${failures} sandbox matrix case(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
