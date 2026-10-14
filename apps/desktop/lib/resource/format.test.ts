import { describe, expect, test } from "bun:test";
import {
  diskUsedPct,
  formatBytes,
  formatClock,
  formatPct,
  sharePct,
  shortenHome,
} from "./format";

describe("shortenHome", () => {
  test("三平台的主目录前缀都缩成 ~", () => {
    expect(shortenHome("/Users/herther/.kova/mcp.json")).toBe("~/.kova/mcp.json");
    expect(shortenHome("/home/me/.kova")).toBe("~/.kova");
    expect(shortenHome("C:\\Users\\me\\.kova")).toBe("~\\.kova");
  });

  test("不在主目录下的路径原样返回", () => {
    expect(shortenHome("/Applications/Kova.app")).toBe("/Applications/Kova.app");
    expect(shortenHome("/var/log/app.log")).toBe("/var/log/app.log");
  });
});

describe("sharePct（存储表里每行那根小条）", () => {
  test("按占应用总量的比例算", () => {
    expect(sharePct(250, 1000)).toBeCloseTo(25, 5);
    expect(sharePct(1000, 1000)).toBe(100);
  });

  test("零与异常输入不会算出 NaN 或负数", () => {
    expect(sharePct(0, 1000)).toBe(0);
    expect(sharePct(100, 0)).toBe(0);
    expect(sharePct(-5, 1000)).toBe(0);
  });

  test("超过总量时封顶 100（估算口径下可能出现）", () => {
    expect(sharePct(1200, 1000)).toBe(100);
  });
});

describe("diskUsedPct", () => {
  test("按已用/总量计算，取不到容量时为 0", () => {
    expect(diskUsedPct({ total: 100, free: 25 })).toBeCloseTo(75, 5);
    expect(diskUsedPct({ total: 0, free: 0 })).toBe(0);
  });

  test("异常输入不会算出负值或超过 100", () => {
    expect(diskUsedPct({ total: 100, free: 200 })).toBe(0);
  });
});

describe("formatPct", () => {
  test("一位小数；极小非零值显示 0.1% 而不是 0.0%", () => {
    expect(formatPct(5.53)).toBe("5.5%");
    expect(formatPct(0)).toBe("0.0%");
    expect(formatPct(-1)).toBe("0.0%");
    expect(formatPct(0.02)).toBe("0.1%");
  });
});

describe("formatClock / formatBytes", () => {
  test("时刻为两位时分", () => {
    const ts = new Date(2026, 9, 12, 9, 5).getTime();
    expect(formatClock(ts)).toMatch(/^09:05$/);
    expect(formatClock(0)).toBe("-");
  });

  test("字节沿用仓库统一的 1024 进制格式", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
