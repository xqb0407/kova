import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, db } from "./storage";
import {
  getModels,
  normalizeApi,
  registerCustomProvider,
  loadCustomProviders,
  getCurrentModelKey,
  setCurrentModelKey,
  defaultModel,
} from "./model-catalog";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-catalog-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
});

describe("normalizeApi", () => {
  test("keeps known kinds", () => {
    expect(normalizeApi("openai-chat")).toBe("openai-chat");
    expect(normalizeApi("openai-responses")).toBe("openai-responses");
    expect(normalizeApi("anthropic-messages")).toBe("anthropic-messages");
  });

  test("falls back to openai-chat", () => {
    expect(normalizeApi(undefined)).toBe("openai-chat");
    expect(normalizeApi("weird")).toBe("openai-chat");
  });
});

describe("registerCustomProvider", () => {
  test("registers models with normalized baseUrl", () => {
    registerCustomProvider({
      id: "mc-p1",
      name: "MC P1",
      base_url: "https://api.example.com/v1/",
      models: JSON.stringify([
        { id: "m1", name: "Model One", contextWindow: 8_000 },
        { id: "   " }, // 空白 id 会被过滤
      ]),
      api: "openai-chat",
    });
    const m = getModels().getModel("mc-p1", "m1")!;
    expect(m.baseUrl).toBe("https://api.example.com/v1"); // 去尾部斜杠
    expect(m.contextWindow).toBe(8_000);
    expect(m.provider).toBe("mc-p1");
    expect(getModels().getModel("mc-p1", "   ")).toBeUndefined();
  });
});

describe("loadCustomProviders", () => {
  test("registers enabled rows only", () => {
    const now = new Date().toISOString();
    db.query(
      "INSERT INTO custom_providers (id, name, base_url, models, api, enabled) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("mc-on", "On", "https://on.io", JSON.stringify([{ id: "a" }]), "openai-chat", 1);
    db.query(
      "INSERT INTO custom_providers (id, name, base_url, models, api, enabled) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("mc-off", "Off", "https://off.io", JSON.stringify([{ id: "b" }]), "openai-chat", 0);

    loadCustomProviders();
    expect(getModels().getModel("mc-on", "a")).toBeDefined();
    expect(getModels().getModel("mc-off", "b")).toBeUndefined();
  });
});

describe("currentModelKey", () => {
  test("get/set roundtrip", () => {
    expect(getCurrentModelKey()).toBeNull();
    setCurrentModelKey({ provider: "p", modelId: "m" });
    expect(getCurrentModelKey()).toEqual({ provider: "p", modelId: "m" });
    setCurrentModelKey(null);
    expect(getCurrentModelKey()).toBeNull();
  });
});

describe("defaultModel", () => {
  test("returns undefined when nothing is configured", async () => {
    expect(await defaultModel()).toBeUndefined();
  });
});
