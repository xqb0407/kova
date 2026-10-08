import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProviderImports } from "../../../src/model/import/scan";

/** 注入临时 home + 空 env，验证路径探测与"文件不存在静默跳过" */
let home: string;
const ENV = {} as Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kova-import-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const write = (rel: string, text: string) => {
  const path = join(home, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
};

describe("scanProviderImports", () => {
  test("空目录：四个来源都报「文件不存在」，且不算错误", () => {
    const scan = scanProviderImports({ home, env: ENV });
    expect(scan.candidates).toEqual([]);
    expect(scan.sources).toHaveLength(4);
    for (const status of scan.sources) {
      expect(status.foundPath).toBeNull();
      expect(status.count).toBe(0);
      // 没装对应工具是常态，不该被报成失败
      expect(status.error).toBeNull();
      expect(status.paths.length).toBeGreaterThan(0);
    }
  });

  test("扫到 opencode：只认 ~/.config/opencode 下的配置", () => {
    const path = write(
      ".config/opencode/opencode.json",
      JSON.stringify({
        provider: { go: { name: "Go", options: { baseURL: "https://go.example/v1", apiKey: "k" } } },
      }),
    );
    const scan = scanProviderImports({ home, env: ENV });
    const status = scan.sources.find((s) => s.source === "opencode")!;
    expect(status.foundPath).toBe(path);
    expect(status.count).toBe(1);
    expect(scan.candidates[0].name).toBe("Go");
  });

  test("XDG_CONFIG_HOME 覆盖 opencode 的查找位置", () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-xdg-"));
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ provider: { x: { options: { baseURL: "https://x.example/v1" } } } }),
      "utf8",
    );
    try {
      const scan = scanProviderImports({ home, env: { XDG_CONFIG_HOME: dir } });
      expect(scan.candidates.map((c) => c.sourceKey)).toEqual(["x"]);
      expect(scan.sources.find((s) => s.source === "opencode")?.foundPath).toBe(
        join(dir, "opencode.json"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("扫到 Codex：config.toml + auth.json 一起生效", () => {
    write(".codex/config.toml", '[model_providers.custom]\nbase_url = "https://cx.example/v1"\n');
    write(".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: "sk-cx" }));
    const scan = scanProviderImports({ home, env: ENV });
    const status = scan.sources.find((s) => s.source === "codex")!;
    expect(status.count).toBe(1);
    expect(scan.candidates[0].apiKey).toBe("sk-cx");
    expect(scan.candidates[0].name).toBe("cx.example");
  });

  test("扫到 ZCode：v2 优先，缺失时回退 cli", () => {
    write(
      ".zcode/cli/config.json",
      JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [{ providerId: "cli", config: { api: { baseUrl: "https://cli.example/v1" } } }],
          },
        },
      }),
    );
    expect(scanProviderImports({ home, env: ENV }).candidates[0].sourceKey).toBe("cli");

    write(
      ".zcode/v2/provider_config.json",
      JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [{ providerId: "v2", config: { api: { baseUrl: "https://v2.example/v1" } } }],
          },
        },
      }),
    );
    const scan = scanProviderImports({ home, env: ENV });
    expect(scan.candidates.map((c) => c.sourceKey)).toEqual(["v2"]);
  });

  test("一个来源的坏文件只影响它自己，其余来源照常扫出", () => {
    write(".config/opencode/opencode.json", "{ 这不是 json");
    write(
      ".zcode/v2/provider_config.json",
      JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [{ providerId: "ok", config: { api: { baseUrl: "https://ok.example/v1" } } }],
          },
        },
      }),
    );
    const scan = scanProviderImports({ home, env: ENV });
    expect(scan.candidates.map((c) => c.sourceKey)).toEqual(["ok"]);
    const opencode = scan.sources.find((s) => s.source === "opencode")!;
    expect(opencode.count).toBe(0);
    // 失败要如实带原因，不能悄悄吞掉
    expect(opencode.error).toBeTruthy();
    expect(scan.sources.find((s) => s.source === "zcode")?.error).toBeNull();
  });

  test("来源顺序固定为 opencode → codex → zcode → ccswitch，候选按同序拼接", () => {
    write(".config/opencode/opencode.json", JSON.stringify({
      provider: { a: { options: { baseURL: "https://a.example/v1" } } },
    }));
    write(".codex/config.toml", '[model_providers.b]\nbase_url = "https://b.example/v1"\n');
    write(".zcode/v2/provider_config.json", JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [{ providerId: "c", config: { api: { baseUrl: "https://c.example/v1" } } }],
        },
      },
    }));
    const scan = scanProviderImports({ home, env: ENV });
    expect(scan.sources.map((s) => s.source)).toEqual(["opencode", "codex", "zcode", "ccswitch"]);
    expect(scan.candidates.map((c) => c.source)).toEqual(["opencode", "codex", "zcode"]);
  });
});

describe("scanProviderImports · cc-switch", () => {
  /** 建一个只有 providers 表的最小 cc-switch 库 */
  const writeDb = (rows: { id: string; app_type: string; name: string; settings: unknown }[]) => {
    const path = join(home, ".cc-switch", "cc-switch.db");
    mkdirSync(join(home, ".cc-switch"), { recursive: true });
    const db = new Database(path, { create: true });
    db.exec(
      "CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, sort_index INTEGER)",
    );
    const insert = db.query(
      "INSERT INTO providers (id, app_type, name, settings_config, sort_index) VALUES (?, ?, ?, ?, ?)",
    );
    rows.forEach((r, i) =>
      insert.run(r.id, r.app_type, r.name, JSON.stringify(r.settings), i),
    );
    db.close();
    return path;
  };

  test("读 providers 表并归类到 ccswitch 来源", () => {
    const path = writeDb([
      {
        id: "c1",
        app_type: "claude",
        name: "阿里",
        settings: {
          env: {
            ANTHROPIC_AUTH_TOKEN: "sk-x",
            ANTHROPIC_BASE_URL: "https://coding.example.com/apps/anthropic",
            ANTHROPIC_MODEL: "glm-5",
          },
        },
      },
      {
        id: "o1",
        app_type: "opencode",
        name: "OC",
        settings: { options: { baseURL: "https://oc.example/v1", apiKey: "sk-y" } },
      },
    ]);
    const scan = scanProviderImports({ home, env: ENV });
    const status = scan.sources.find((s) => s.source === "ccswitch")!;
    expect(status.foundPath).toBe(path);
    expect(status.count).toBe(2);
    expect(scan.candidates.map((c) => c.sourceKey)).toEqual(["claude:c1", "opencode:o1"]);
    // opencode 分支也必须归到 ccswitch，不能混进 opencode 分组
    expect(new Set(scan.candidates.map((c) => c.source))).toEqual(new Set(["ccswitch"]));
  });

  test("库文件不存在时静默跳过，不算错误", () => {
    const scan = scanProviderImports({ home, env: ENV });
    const status = scan.sources.find((s) => s.source === "ccswitch")!;
    expect(status.foundPath).toBeNull();
    expect(status.error).toBeNull();
  });

  test("库坏掉（不是 SQLite）时报错但不影响其它来源", () => {
    write(".config/opencode/opencode.json", JSON.stringify({
      provider: { ok: { options: { baseURL: "https://ok.example/v1" } } },
    }));
    write(".cc-switch/cc-switch.db", "这不是数据库");
    const scan = scanProviderImports({ home, env: ENV });
    expect(scan.candidates.map((c) => c.sourceKey)).toEqual(["ok"]);
    const status = scan.sources.find((s) => s.source === "ccswitch")!;
    expect(status.error).toBeTruthy();
  });
});