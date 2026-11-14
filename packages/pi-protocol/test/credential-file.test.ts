import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialFileSecret,
  decryptCredentialValue,
  defaultCredentialFilePath,
  encryptCredentialValue,
  readCredentialFile,
  writeCredentialFile,
} from "../src/credential-file";

describe("credential-file", () => {
  test("默认路径：~/.kova/credentials.json，KOVA_CREDENTIALS_FILE 覆盖", () => {
    expect(defaultCredentialFilePath({} as NodeJS.ProcessEnv)).toMatch(/credentials\.json$/);
    expect(
      defaultCredentialFilePath({ KOVA_CREDENTIALS_FILE: "/tmp/x.json" } as NodeJS.ProcessEnv),
    ).toBe("/tmp/x.json");
    expect(defaultCredentialFilePath({ KOVA_CREDENTIALS_FILE: "  " } as NodeJS.ProcessEnv)).toMatch(
      /credentials\.json$/,
    );
  });

  test("值 roundtrip；不同 secret 解不开；非 kenc 前缀拒收", () => {
    const secret = credentialFileSecret({ KOVA_CREDENTIAL_SECRET: "s1" } as NodeJS.ProcessEnv);
    const enc = encryptCredentialValue("sk-abc123", secret);
    expect(enc.startsWith("kenc:v1:")).toBe(true);
    expect(decryptCredentialValue(enc, secret)).toBe("sk-abc123");

    const other = credentialFileSecret({ KOVA_CREDENTIAL_SECRET: "s2" } as NodeJS.ProcessEnv);
    expect(other).not.toBe(secret);
    expect(() => decryptCredentialValue(enc, other)).toThrow();

    expect(() => decryptCredentialValue("aes:v1:whatever", secret)).toThrow();
  });

  test("文件 roundtrip：明文入参 → 落盘密文 → 读回明文；0600 权限", () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-credfile-"));
    try {
      const path = join(dir, "nested", "credentials.json");
      const secret = "unit-secret";
      writeCredentialFile(
        path,
        {
          credentials: { zai: "key-1", deepseek: "key-2" },
          customProviders: [
            {
              id: "my-gateway",
              name: "Gateway",
              baseUrl: "https://gw.example.com",
              models: JSON.stringify([{ modelId: "gw-mini" }]),
              api: "openai-chat",
              enabled: true,
              autoDiscover: false,
              headers: "{}",
            },
          ],
          models: [
            {
              provider: "my-gateway",
              modelId: "gw-mini",
              name: "GW Mini",
              contextWindow: 128000,
              enabled: true,
            },
          ],
        },
        secret,
      );
      // 落盘的是密文，且权限 0600
      const raw = JSON.parse(readFileSync(path, "utf8")) as { credentials: Record<string, string> };
      expect(raw.credentials.zai.startsWith("kenc:v1:")).toBe(true);
      expect(raw.credentials.zai).not.toContain("key-1");
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const decoded = readCredentialFile(path, secret)!;
      expect(decoded.credentials).toEqual({ zai: "key-1", deepseek: "key-2" });
      expect(decoded.credentialErrors).toEqual([]);
      expect(decoded.customProviders[0]?.id).toBe("my-gateway");
      expect(decoded.models[0]?.modelId).toBe("gw-mini");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("缺文件返回 null；坏 secret 跳过该条并记错误；坏版本抛错", () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-credfile-"));
    try {
      expect(readCredentialFile(join(dir, "absent.json"), "s")).toBeNull();

      const path = join(dir, "credentials.json");
      writeCredentialFile(path, { credentials: { a: "ka" }, customProviders: [], models: [] }, "good");
      const bad = readCredentialFile(path, "wrong")!;
      expect(bad.credentials.a).toBeUndefined();
      expect(bad.credentialErrors.length).toBe(1);

      writeFileSync(join(dir, "v9.json"), JSON.stringify({ version: 9 }), "utf8");
      expect(() => readCredentialFile(join(dir, "v9.json"), "s")).toThrow(/version mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("原子性：写后无 tmp 残留", () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-credfile-"));
    try {
      const path = join(dir, "credentials.json");
      writeCredentialFile(path, { credentials: {}, customProviders: [], models: [] }, "s");
      const entries = readdirSync(dir);
      expect(entries.every((e) => !e.includes(".tmp-"))).toBe(true);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
