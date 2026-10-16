// 回归：切走再切回来时的假冻结。
//
// 现象是 Windows 打包版「对话在跑着，窗口切到别的软件再切回来经常弹一次
// 界面卡住了」。成因是隐藏期间定时器被降频、回可见时逾期 tick 立刻补跑，
// 那一拍测到的是整段隐藏时长。判定函数必须把这种间隔判为不可测量。
import { describe, expect, it } from "bun:test";
import { isMeasureableGap } from "./perf-watch";

describe("isMeasureableGap（漂移法可判定条件）", () => {
  it("时钟一直可信且页面可见：可判定", () => {
    expect(isMeasureableGap(1000, 0, false)).toBe(true);
  });

  it("此刻页面不可见：不可判定", () => {
    expect(isMeasureableGap(1000, 0, true)).toBe(false);
  });

  it("上一拍之后发生过可见性变化：不可判定（回焦首拍，降频时间不属于主线程）", () => {
    // prevTick=1000 是隐藏期间最后一次对齐，5000 时页面已回可见
    expect(isMeasureableGap(1000, 5000, false)).toBe(false);
  });

  it("同一毫秒的可见性变化也按不可判定处理（保守）", () => {
    expect(isMeasureableGap(5000, 5000, false)).toBe(false);
  });

  it("可见性变化发生在上一拍之前：不影响判定", () => {
    expect(isMeasureableGap(5000, 1000, false)).toBe(true);
  });
});
