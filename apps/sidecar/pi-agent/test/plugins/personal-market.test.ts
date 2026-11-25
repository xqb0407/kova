/** Codex personal marketplace 自动发现的纯函数部分。 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPersonalMarketplace } from "../../src/plugins/registry";
import { marketplaceRootFromManifestPath } from "../../src/plugins/marketplaces";

describe("Codex personal marketplace", () => {
  test("检测 $HOME/.agents/plugins/marketplace.json，source 根回退 $HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-personal-"));
    try {
      const marketDir = join(home, ".agents", "plugins");
      mkdirSync(marketDir, { recursive: true });
      const manifest = join(marketDir, "marketplace.json");
      writeFileSync(manifest, JSON.stringify({ name: "personal", plugins: [] }));

      expect(marketplaceRootFromManifestPath(manifest)).toBe(home);
      expect(codexPersonalMarketplace(home)).toMatchObject({
        id: "codex-personal",
        name: "personal",
        type: "directory",
        path: marketDir,
        sourceBase: home,
        builtin: true,
      });
      expect(codexPersonalMarketplace(join(home, "nope"))).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
