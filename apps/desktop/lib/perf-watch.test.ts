// 回归：切走再切回来时的假冻结。
//
// 现象是 Windows 打包版「对话在跑着，窗口切到别的软件再切回来经常弹一次
// 界面卡住了」。成因是隐藏期间定时器被降频、回可见时逾期 tick 立刻补跑，
// 那一拍测到的是整段隐藏时长。判定函数必须把这种间隔判为不可测量。
import { describe, expect, it } from "bun:test";
import { installPerfWatch, isMeasureableGap, uninstallPerfWatch } from "./perf-watch";

describe("isMeasureableGap（漂移法可判定条件）", () => {
  it("时钟一直可信且页面可见有焦点：可判定", () => {
    expect(isMeasureableGap(1000, 0, false, true)).toBe(true);
  });

  it("此刻页面不可见：不可判定", () => {
    expect(isMeasureableGap(1000, 0, true, true)).toBe(false);
  });

  it("页面无焦点（被遮挡/切走但宿主仍报 visible）：不可判定", () => {
    // 这类窗口的定时器会被钳到分钟级，报出来正好是 60000 - 500 的「冻结」
    expect(isMeasureableGap(1000, 0, false, false)).toBe(false);
  });

  it("上一拍之后发生过可见性变化：不可判定（回焦首拍，降频时间不属于主线程）", () => {
    // prevTick=1000 是隐藏期间最后一次对齐，5000 时页面已回可见
    expect(isMeasureableGap(1000, 5000, false, true)).toBe(false);
  });

  it("同一毫秒的可见性变化也按不可判定处理（保守）", () => {
    expect(isMeasureableGap(5000, 5000, false, true)).toBe(false);
  });

  it("可见性变化发生在上一拍之前：不影响判定", () => {
    expect(isMeasureableGap(5000, 1000, false, true)).toBe(true);
  });
});

describe("installPerfWatch（焦点闸门接线）", () => {
  it("监听 focus/blur，uninstall 时移除", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const g = globalThis as any;
    const prevWindow = g.window;
    const prevRaf = g.requestAnimationFrame;
    const prevCaf = g.cancelAnimationFrame;
    g.window = {
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    };
    g.requestAnimationFrame = () => 1;
    g.cancelAnimationFrame = () => {};
    try {
      installPerfWatch();
      // 失焦/遮挡时 rAF 会停或降频；必须在焦点变化时踩「时钟不可信」，
      // 否则回焦首帧会把整段遮挡时间误报成渲染帧冻结。
      expect(added).toContain("focus");
      expect(added).toContain("blur");
    } finally {
      uninstallPerfWatch();
      g.window = prevWindow;
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCaf;
    }
    expect(removed).toContain("focus");
    expect(removed).toContain("blur");
  });
});
