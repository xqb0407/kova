import { beforeEach, describe, expect, test } from "vitest";
import {
  addComposerChip,
  clearComposerChips,
  composerDirectiveText,
  nextComposerChipId,
  parseDirective,
  removeComposerChip,
  splitMessageDirectives,
} from "./composer-chips";

describe("指令芯片台账", () => {
  beforeEach(() => clearComposerChips());

  test("挂载/去重/移除/发送文本", () => {
    addComposerChip({ id: nextComposerChipId(), kind: "agent", name: "Explorer", directive: ":agent[Explorer]{name=agent:Explorer}" });
    addComposerChip({ id: nextComposerChipId(), kind: "skill", name: "doc", directive: ":skill[doc]{name=skill:doc}" });
    // 同 directive 去重
    addComposerChip({ id: nextComposerChipId(), kind: "agent", name: "Explorer", directive: ":agent[Explorer]{name=agent:Explorer}" });
    expect(composerDirectiveText()).toBe(
      ":agent[Explorer]{name=agent:Explorer} :skill[doc]{name=skill:doc}",
    );
  });

  test("remove 只摘掉点名那枚；clear 全清", () => {
    const a = nextComposerChipId();
    addComposerChip({ id: a, kind: "agent", name: "Explorer", directive: ":agent[Explorer]{name=agent:Explorer}" });
    addComposerChip({ id: nextComposerChipId(), kind: "skill", name: "doc", directive: ":skill[doc]{name=skill:doc}" });
    removeComposerChip(a);
    expect(composerDirectiveText()).toBe(":skill[doc]{name=skill:doc}");
    clearComposerChips();
    expect(composerDirectiveText()).toBe("");
  });

  test("parseDirective 认技能/子智能体，其余回 null", () => {
    expect(parseDirective(":skill[anxin-ppt]{name=skill:anxin-ppt}")).toEqual({ kind: "skill", name: "anxin-ppt" });
    expect(parseDirective(":agent[Explorer]{name=agent:Explorer}")).toEqual({ kind: "agent", name: "Explorer" });
    expect(parseDirective(":tool[server:tool]{name=tool:server:tool}")).toBeNull();
    expect(parseDirective("plain text")).toBeNull();
  });
});


describe("消息里的指令芯片（渲染用摘除）", () => {
  test("指令在前、正文在后（真实转录样本）", () => {
    const r = splitMessageDirectives(
      ":agent[Explorer]{name=agent:Explorer} 目录下有啥",
    );
    expect(r.chips).toEqual([{ type: "agent", label: "Explorer" }]);
    expect(r.text).toBe("目录下有啥");
  });

  test("多枚芯片 + 中间正文", () => {
    const r = splitMessageDirectives(
      ":skill[doc]{name=skill:doc} 用这个写一页，再配 :agent[Fixer]{name=agent:Fixer} 收尾",
    );
    expect(r.chips.map((c) => c.label)).toEqual(["doc", "Fixer"]);
    expect(r.text).toBe("用这个写一页，再配 收尾");
  });

  test("没有指令时原样返回（不改一个字符）", () => {
    const r = splitMessageDirectives("普通的一句话 :not-a-directive");
    expect(r.chips).toEqual([]);
    expect(r.text).toBe("普通的一句话 :not-a-directive");
  });

  test("纯指令消息正文为空", () => {
    const r = splitMessageDirectives(":skill[canvas]{name=skill:canvas}");
    expect(r.chips).toHaveLength(1);
    expect(r.text).toBe("");
  });
});
