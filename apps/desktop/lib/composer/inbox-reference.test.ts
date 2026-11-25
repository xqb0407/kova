import { beforeEach, describe, expect, it } from "bun:test";
import {
  buildInboxAgentContext,
  buildInboxChip,
  buildInboxContextBlock,
  buildInboxDirectiveId,
  parseInboxDirectiveId,
  saveInboxAgentContext,
  type InboxAgentContext,
} from "./inbox-reference";

/** bun test 的 happy-dom/localStorage 环境：拿不到就用内存桩 */
const memoryStore = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => memoryStore.get(key) ?? null,
      setItem: (key: string, value: string) => void memoryStore.set(key, value),
      removeItem: (key: string) => void memoryStore.delete(key),
    },
    configurable: true,
  });
}

const sampleContext = (): InboxAgentContext =>
  buildInboxAgentContext({
    itemId: "external:linear:HER-5",
    providerLabel: "Linear",
    typeLabel: "Issue",
    key: "HER-5",
    title: "123",
    url: "https://linear.app/team/issue/HER-5",
    status: "In Progress",
    assignee: "Herther",
    body: "先做 A，再做 B。",
    comments: [{ author: "Tom", body: "收到，周一看。" }],
  });

describe("收件箱事项引用（「交给 Agent」芯片）", () => {
  beforeEach(() => {
    memoryStore.clear();
  });

  it("buildInboxDirectiveId ↔ parseInboxDirectiveId 回环（含特殊字符 id）", () => {
    const itemId = "external:github:owner/repo#1";
    const id = buildInboxDirectiveId(itemId);
    expect(id.startsWith("inbox:")).toBe(true);
    expect(parseInboxDirectiveId(id)).toEqual({ itemId });
  });

  it("buildInboxChip：label 超长截断，id 保持可解析", () => {
    const ctx = { ...sampleContext(), title: "很".repeat(80) };
    const chip = buildInboxChip(ctx);
    expect(chip).toContain("{name=inbox:");
    const label = chip.slice(":inbox[".length, chip.indexOf("]{name="));
    expect(label.length).toBeLessThanOrEqual(61);
  });

  it("buildInboxContextBlock：芯片 → 隐藏块含标题/链接/正文/评论；芯片本身不动", () => {
    saveInboxAgentContext(sampleContext());
    const chip = buildInboxChip(sampleContext());
    const userText = `${chip}\n\n请先阅读上面的上下文。`;
    const block = buildInboxContextBlock(userText, "bd1");
    expect(block).toContain("[[inbox-ctx:bd1]]");
    expect(block).toContain("[[/inbox-ctx:bd1]]");
    expect(block).toContain("### Linear Issue HER-5");
    expect(block).toContain("标题：123");
    expect(block).toContain("正文：");
    expect(block).toContain("- Tom: 收到，周一看。");
    // 芯片在正文里原样保留（气泡渲染成芯片，编辑重发拿回芯片）
    expect(userText).toContain(chip);
  });

  it("无芯片的文本返回 null；上下文缺失的条目降级为「已失效」", () => {
    expect(buildInboxContextBlock("普通问题", "bd2")).toBeNull();
    const orphan = buildInboxContextBlock(
      ":inbox[x]{name=inbox:missing-id}",
      "bd3",
    );
    expect(orphan).toContain("上下文已失效");
  });

  it("save 淘汰最旧条目，避免 localStorage 无限膨胀", () => {
    for (let i = 0; i < 30; i += 1) {
      saveInboxAgentContext({
        ...sampleContext(),
        itemId: `item-${i}`,
      });
    }
    const block = buildInboxContextBlock(
      ":inbox[x]{name=inbox:item-0}",
      "bd4",
    );
    expect(block).toContain("上下文已失效");
    const kept = buildInboxContextBlock(
      ":inbox[x]{name=inbox:item-29}",
      "bd5",
    );
    expect(kept).toContain("标题：123");
  });
});
