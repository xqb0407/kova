import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activeGitAccelEnv,
  activeMirrorPolicy,
  applyMirrorConfig,
  DEFAULT_MIRROR_CONFIG,
  getMirrorConfig,
  initMirrorConfig,
  MIRROR_KV_KEY,
  normalizeMirrorConfig,
  resetMirrorConfigForTest,
  setMirrorConfigForTest,
} from "../../src/tools/mirror-config";
import { initLocalStorage, kvSet, resetStorageForTest } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mirror-config-"));

beforeAll(() => {
  // hostdb 本地存储（kv_get/kv_set 落 SQLite）：钉到临时目录，不碰真实应用数据
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清内存态与底层连接，避免污染后续文件
  resetMirrorConfigForTest();
  resetStorageForTest();
});

describe("normalizeMirrorConfig", () => {
  test("非法输入回落默认（默认开，前缀为内建 GitHub 加速站）", () => {
    expect(normalizeMirrorConfig(undefined)).toEqual(DEFAULT_MIRROR_CONFIG);
    expect(normalizeMirrorConfig(null)).toEqual(DEFAULT_MIRROR_CONFIG);
    expect(normalizeMirrorConfig("nope")).toEqual(DEFAULT_MIRROR_CONFIG);
    expect(normalizeMirrorConfig({ enabled: "yes", gitInsteadOf: 1 })).toEqual(
      DEFAULT_MIRROR_CONFIG,
    );
  });

  test("前缀三态：缺字段取默认、显式空串表示不加速 GitHub、非法串回落默认", () => {
    expect(normalizeMirrorConfig({}).githubPrefix).toBe(DEFAULT_MIRROR_CONFIG.githubPrefix);
    expect(normalizeMirrorConfig({ githubPrefix: "" }).githubPrefix).toBe("");
    expect(normalizeMirrorConfig({ githubPrefix: "   " }).githubPrefix).toBe("");
    expect(normalizeMirrorConfig({ githubPrefix: "gh-proxy.com" }).githubPrefix).toBe(
      DEFAULT_MIRROR_CONFIG.githubPrefix,
    );
    expect(normalizeMirrorConfig({ githubPrefix: "https://gh-proxy.com/" }).githubPrefix).toBe(
      "https://gh-proxy.com",
    );
  });

  test("自定义规则原样保留：输入中途的行也存，能不能用交给改写侧判定", () => {
    const cfg = normalizeMirrorConfig({
      customRules: [
        { from: "https://huggingface.co/", to: "https://hf-mirror.com/" },
        // 半截（正在打字）：存下来，否则用户会在失焦/重载后看到输入被吃掉
        { from: "https://h", to: "" },
        { from: "", to: "" },
        // 形状不对的丢掉：不是一对字符串
        { from: "https://a.test/" },
        "junk",
        null,
      ],
    });
    expect(cfg.customRules).toEqual([
      { from: "https://huggingface.co/", to: "https://hf-mirror.com/" },
      { from: "https://h", to: "" },
      { from: "", to: "" },
    ]);
  });

  test("布尔字段逐项回落，不因一项非法丢掉其余设置", () => {
    const cfg = normalizeMirrorConfig({ enabled: false, gitInsteadOf: "no" });
    expect(cfg.enabled).toBe(false);
    expect(cfg.gitInsteadOf).toBe(DEFAULT_MIRROR_CONFIG.gitInsteadOf);
  });
});

describe("applyMirrorConfig + initMirrorConfig（kv 往返）", () => {
  test("落库后重载读到同一份配置", async () => {
    resetMirrorConfigForTest();
    await applyMirrorConfig({ enabled: false, githubPrefix: "https://gh-proxy.com" });
    expect(getMirrorConfig().enabled).toBe(false);
    expect(getMirrorConfig().githubPrefix).toBe("https://gh-proxy.com");

    resetMirrorConfigForTest();
    expect(getMirrorConfig()).toEqual(DEFAULT_MIRROR_CONFIG);

    await initMirrorConfig();
    expect(getMirrorConfig().enabled).toBe(false);
    expect(getMirrorConfig().githubPrefix).toBe("https://gh-proxy.com");
  });

  test("kv 里是坏 JSON 时保持默认，不抛错", async () => {
    await kvSet(MIRROR_KV_KEY, "{not json");
    resetMirrorConfigForTest();
    await initMirrorConfig();
    expect(getMirrorConfig()).toEqual(DEFAULT_MIRROR_CONFIG);
  });

  test("半截/空的自定义规则也能熬过重载（设置页「下次打开还在」的承诺）", async () => {
    resetMirrorConfigForTest();
    await applyMirrorConfig({
      customRules: [{ from: "https://h", to: "" }, { from: "", to: "" }],
    });
    resetMirrorConfigForTest();
    await initMirrorConfig();
    expect(getMirrorConfig().customRules).toEqual([
      { from: "https://h", to: "" },
      { from: "", to: "" },
    ]);
  });
});

describe("activeMirrorPolicy / activeGitAccelEnv（门控）", () => {
  test("总开关关闭：不加速（策略为 null、无 git 环境）", () => {
    setMirrorConfigForTest({ enabled: false });
    expect(activeMirrorPolicy()).toBeNull();
    expect(activeGitAccelEnv("git clone https://github.com/o/r.git")).toBeNull();
  });

  test("总开关打开：策略带前缀与自定义规则", () => {
    setMirrorConfigForTest({
      enabled: true,
      githubPrefix: "https://ghfast.top",
      customRules: [{ from: "https://huggingface.co/", to: "https://hf-mirror.com/" }],
    });
    expect(activeMirrorPolicy()).toEqual({
      githubPrefix: "https://ghfast.top",
      // 存的是用户输入的原样（不在这里去尾斜杠），改写时才规整
      customRules: [{ from: "https://huggingface.co/", to: "https://hf-mirror.com/" }],
    });
  });

  test("git 子开关关闭 / 命令带 push 时不给环境", () => {
    setMirrorConfigForTest({ enabled: true, gitInsteadOf: false });
    expect(activeGitAccelEnv("git clone https://github.com/o/r.git")).toBeNull();

    setMirrorConfigForTest({ enabled: true, gitInsteadOf: true });
    expect(activeGitAccelEnv("git clone https://github.com/o/r.git")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.https://ghfast.top/https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_0: "https://github.com/",
    });
    expect(activeGitAccelEnv("git push origin main")).toBeNull();
  });

  test("githubPrefix 清空后 git 也不给环境（没有可用的前缀）", () => {
    setMirrorConfigForTest({ enabled: true, gitInsteadOf: true, githubPrefix: "" });
    expect(activeGitAccelEnv("git clone https://github.com/o/r.git")).toBeNull();
  });
});
