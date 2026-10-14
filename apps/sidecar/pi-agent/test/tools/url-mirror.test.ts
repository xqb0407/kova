import { describe, test, expect } from "bun:test";
import {
  applyMirrorRules,
  DEFAULT_GITHUB_PREFIX,
  gitAccelEnv,
  githubRules,
  hasCredential,
  mirrorUrl,
  normalizeMirrorPrefix,
  policyRules,
  shouldAccelerateGit,
  type MirrorPolicy,
} from "../../src/tools/url-mirror";

const policy = (over: Partial<MirrorPolicy> = {}): MirrorPolicy => ({
  githubPrefix: DEFAULT_GITHUB_PREFIX,
  ...over,
});

describe("normalizeMirrorPrefix", () => {
  test("去尾斜杠、trim 后保留合法前缀", () => {
    expect(normalizeMirrorPrefix("  https://ghfast.top/  ")).toBe("https://ghfast.top");
    expect(normalizeMirrorPrefix("https://ghfast.top/gh")).toBe("https://ghfast.top/gh");
  });

  test("非 http(s)、非法、带查询/锚点、空值一律返回空串", () => {
    expect(normalizeMirrorPrefix("")).toBe("");
    expect(normalizeMirrorPrefix("   ")).toBe("");
    expect(normalizeMirrorPrefix(undefined)).toBe("");
    expect(normalizeMirrorPrefix(123)).toBe("");
    expect(normalizeMirrorPrefix("ghfast.top")).toBe("");
    expect(normalizeMirrorPrefix("ftp://ghfast.top")).toBe("");
    expect(normalizeMirrorPrefix("https://ghfast.top/?x=1")).toBe("");
    expect(normalizeMirrorPrefix("https://ghfast.top/#frag")).toBe("");
  });
});

describe("applyMirrorRules", () => {
  test("前缀形态：镜像前缀套在原始 URL 前面，路径与查询串原样保留", () => {
    const rules = githubRules("https://ghfast.top");
    const hit = applyMirrorRules(
      "https://github.com/o/r/releases/download/v1.0/a.zip?token=no",
      rules,
    );
    expect(hit?.url).toBe(
      "https://ghfast.top/https://github.com/o/r/releases/download/v1.0/a.zip?token=no",
    );
  });

  test("raw 主机整站改写", () => {
    const rules = githubRules("https://ghfast.top");
    expect(applyMirrorRules("https://raw.githubusercontent.com/o/r/main/a.ts", rules)?.url).toBe(
      "https://ghfast.top/https://raw.githubusercontent.com/o/r/main/a.ts",
    );
  });

  test("github.com 只改下载类路径：仓库页/issue/tree 不动", () => {
    const rules = githubRules("https://ghfast.top");
    for (const url of [
      "https://github.com/o/r",
      "https://github.com/o/r/tree/main/src",
      "https://github.com/o/r/issues/12",
      "https://github.com/o/r/releases",
      "https://github.com/o/r/blob/main/a.ts",
    ]) {
      expect(applyMirrorRules(url, rules)).toBeNull();
    }
    // 同一主机的下载路径要改
    for (const url of [
      "https://github.com/o/r/releases/download/v1/a.zip",
      "https://github.com/o/r/releases/latest/download/a.zip",
      "https://github.com/o/r/archive/refs/heads/main.zip",
      "https://github.com/o/r/raw/main/a.ts",
    ]) {
      expect(applyMirrorRules(url, rules)?.url).toBe(
        `https://ghfast.top/${url}`,
      );
    }
  });

  test("主机精确相等：相似域名不误伤", () => {
    const rules = githubRules("https://ghfast.top");
    expect(applyMirrorRules("https://raw.githubusercontent.com.evil.test/o/r", rules)).toBeNull();
    expect(applyMirrorRules("https://notgithub.com/o/r/archive/x.zip", rules)).toBeNull();
    // 子域也不写：规则只认列出的那几个主机
    expect(applyMirrorRules("https://foo.githubusercontent.com/o/r", rules)).toBeNull();
  });

  test("已改写过的不再改写（首条命中即返回，不递归）", () => {
    const rules = githubRules("https://ghfast.top");
    const once = applyMirrorRules("https://github.com/o/r/archive/main.zip", rules);
    expect(once).not.toBeNull();
    expect(applyMirrorRules(once!.url, rules)).toBeNull();
  });

  test("路径按段对齐：/archive 不吃 /archive-notes", () => {
    const rules = [{ from: "https://example.com/archive", to: "https://m.test/a" }];
    expect(applyMirrorRules("https://example.com/archive/x.zip", rules)?.url).toBe(
      "https://m.test/a/x.zip",
    );
    expect(applyMirrorRules("https://example.com/archive", rules)?.url).toBe("https://m.test/a");
    expect(applyMirrorRules("https://example.com/archive-notes/x", rules)).toBeNull();
  });

  test("非 http(s)、非法 URL、空规则表都返回 null", () => {
    expect(applyMirrorRules("ftp://github.com/o/r", githubRules("https://ghfast.top"))).toBeNull();
    expect(applyMirrorRules("not a url", githubRules("https://ghfast.top"))).toBeNull();
    expect(applyMirrorRules("https://github.com/o/r/archive/main.zip", [])).toBeNull();
  });

  test("规则表里前缀非法的那条被跳过，不会拿半个字符串去拼", () => {
    const rules = [
      { from: "https://github.com/", to: "ghfast.top" },
      { from: "https://github.com/", to: "https://good.test/" },
    ];
    expect(applyMirrorRules("https://github.com/o/r.git", rules)?.url).toBe(
      "https://good.test/o/r.git",
    );
  });
});

describe("policyRules", () => {
  test("自定义规则在前、优先命中，内建规则兜后", () => {
    const rules = policyRules(
      policy({
        customRules: [{ from: "https://raw.githubusercontent.com/", to: "https://raw.gitmirror.com/" }],
      }),
    );
    // 自定义规则是路径替换形态，赢在第一个
    expect(applyMirrorRules("https://raw.githubusercontent.com/o/r/main/a.ts", rules)?.url).toBe(
      "https://raw.gitmirror.com/o/r/main/a.ts",
    );
    // 自定义没覆盖的仍走内建
    expect(applyMirrorRules("https://github.com/o/r/archive/main.zip", rules)?.url).toBe(
      "https://ghfast.top/https://github.com/o/r/archive/main.zip",
    );
  });

  test("空 githubPrefix = 不改 GitHub（只留自定义规则）", () => {
    const rules = policyRules(policy({ githubPrefix: "" }));
    expect(rules).toHaveLength(0);
    expect(
      mirrorUrl("https://github.com/o/r/archive/main.zip", policy({ githubPrefix: "" })).url,
    ).toBe("https://github.com/o/r/archive/main.zip");
  });

  test("非法自定义规则被丢弃，不影响其余规则", () => {
    const rules = policyRules(
      policy({ customRules: [{ from: "nope", to: "https://x.test/" }, { from: "https://a.test/", to: "" }] }),
    );
    expect(rules.every((r) => r.from.startsWith("https://"))).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  /**
   * 设置页允许存下「填了一半」的规则（所见即所存，输入不会被吃掉），
   * 这两条钉住它的安全性：存得下，但绝不会误伤真实地址。
   */
  test("打字途中的半截前缀不会抢走真实地址（主机精确相等）", () => {
    const rules = policyRules(policy({ customRules: [{ from: "https://h", to: "https://x.test/" }] }));
    expect(applyMirrorRules("https://huggingface.co/o/r", rules)).toBeNull();
    expect(applyMirrorRules("https://h/a", rules)?.url).toBe("https://x.test/a");
  });

  test("两侧没填齐的规则存着也不参与改写", () => {
    const rules = policyRules(
      policy({
        customRules: [
          { from: "https://huggingface.co", to: "" },
          { from: "", to: "https://hf-mirror.com" },
          { from: "", to: "" },
        ],
      }),
    );
    // 三条死规则一条都不生效，内建 GitHub 规则照常
    expect(applyMirrorRules("https://huggingface.co/o/r/resolve/main/x.bin", rules)).toBeNull();
    expect(applyMirrorRules("https://github.com/o/r/archive/main.zip", rules)?.url).toBe(
      "https://ghfast.top/https://github.com/o/r/archive/main.zip",
    );
  });
});

describe("hasCredential", () => {
  test("Authorization/Cookie 头算凭据", () => {
    expect(hasCredential("https://raw.githubusercontent.com/o/r/a", { authorization: "Bearer x" })).toBe(true);
    expect(hasCredential("https://raw.githubusercontent.com/o/r/a", { Authorization: "Bearer x" })).toBe(true);
    expect(hasCredential("https://raw.githubusercontent.com/o/r/a", { Cookie: "a=b" })).toBe(true);
    expect(hasCredential("https://raw.githubusercontent.com/o/r/a", { Accept: "text/plain" })).toBe(false);
  });

  test("URL 里的 userinfo 与 token 类查询参数算凭据", () => {
    expect(hasCredential("https://u:p@raw.githubusercontent.com/o/r/a")).toBe(true);
    expect(hasCredential("https://raw.githubusercontent.com/o/r/a?token=abc")).toBe(true);
    expect(hasCredential("https://raw.githubusercontent.com/o/r/a?access_token=abc")).toBe(true);
    expect(hasCredential("https://raw.githubusercontent.com/o/r/a?page=2")).toBe(false);
    expect(hasCredential("not a url")).toBe(false);
  });
});

describe("mirrorUrl", () => {
  test("命中即改写", () => {
    const out = mirrorUrl("https://raw.githubusercontent.com/o/r/main/a.ts", policy());
    expect(out.url).toBe("https://ghfast.top/https://raw.githubusercontent.com/o/r/main/a.ts");
    expect(out.match).toBeTruthy();
  });

  test("带凭据的链接不改写（token 不出境）", () => {
    const url = "https://raw.githubusercontent.com/o/r/main/a.ts?token=secret";
    const out = mirrorUrl(url, policy());
    expect(out.url).toBe(url);
    expect(out.match).toBeUndefined();
    expect(out.skippedCredential).toBe(true);
  });

  test("未命中/非法 URL 原样返回，且不误报 skippedCredential", () => {
    const url = "https://example.com/a.zip";
    expect(mirrorUrl(url, policy()).url).toBe(url);
    expect(mirrorUrl(url, policy()).skippedCredential).toBeUndefined();
  });

  test("自定义规则改写的目标 URL 也受凭据保护", () => {
    const p = policy({ customRules: [{ from: "https://huggingface.co/", to: "https://hf-mirror.com/" }] });
    expect(mirrorUrl("https://huggingface.co/o/r/resolve/main/x.bin", p).url).toBe(
      "https://hf-mirror.com/o/r/resolve/main/x.bin",
    );
    const withToken = "https://huggingface.co/o/r/resolve/main/x.bin?token=hf_x";
    expect(mirrorUrl(withToken, p).url).toBe(withToken);
  });
});

describe("gitAccelEnv", () => {
  test("insteadOf 指向镜像前缀 + 原 github.com 地址", () => {
    expect(gitAccelEnv(policy())).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.https://ghfast.top/https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_0: "https://github.com/",
    });
  });

  test("前缀非法/为空时不给环境（退化成不加速）", () => {
    expect(gitAccelEnv(policy({ githubPrefix: "" }))).toBeNull();
    expect(gitAccelEnv(policy({ githubPrefix: "ghfast.top" }))).toBeNull();
  });
});

describe("shouldAccelerateGit", () => {
  test("读操作放行", () => {
    expect(shouldAccelerateGit("git clone https://github.com/o/r.git")).toBe(true);
    expect(shouldAccelerateGit("git fetch origin && git checkout main")).toBe(true);
  });

  test("命令里出现 push 一律跳过（写操作不走第三方镜像）", () => {
    expect(shouldAccelerateGit("git push origin main")).toBe(false);
    expect(shouldAccelerateGit("git clone x && git push")).toBe(false);
    expect(shouldAccelerateGit("git remote set-url --push origin x")).toBe(false);
  });

  test("非字符串命令不给加速", () => {
    expect(shouldAccelerateGit(undefined)).toBe(false);
    expect(shouldAccelerateGit(42)).toBe(false);
  });
});
