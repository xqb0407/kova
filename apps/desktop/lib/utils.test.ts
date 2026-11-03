import { describe, expect, test } from "bun:test";

import { cn } from "./utils";

describe("cn 字号档合并", () => {
  test("text-2xs/text-3xs 被当作字号类，不会吃掉文字颜色", () => {
    // 回归：自定义 text-mini 会被 cn 误判成文字颜色，拼上
    // text-muted-foreground 时会把颜色整条吃掉。
    expect(cn("text-muted-foreground text-2xs")).toBe(
      "text-muted-foreground text-2xs",
    );
    expect(cn("text-xs text-2xs text-secondary-foreground")).toBe(
      "text-2xs text-secondary-foreground",
    );
    expect(cn("text-sm text-3xs text-muted-foreground")).toBe(
      "text-3xs text-muted-foreground",
    );
  });
});
