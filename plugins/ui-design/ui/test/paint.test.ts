/**
 * 填充 → leafer paint 转换单测（回归钉：径向/线性渐变画布不显示的根因）。
 *
 * leafer 的 AroundHelper.toPoint 只有当 from/to 点显式带 type:"percent" 时才把
 * 0~1 归一化坐标乘盒子宽高；缺标记则按绝对像素处理，渐变半径塌缩到 ~1px，
 * 画布上整块只剩末色标纯色（原型预览走 CSS radial-gradient 不受影响）。
 * 因此渐变两式的 from/to 必须恒带 type:"percent"，这里把格式钉死。
 */
import { describe, expect, test } from "bun:test";
import type { Fill } from "../src/doc";
import { fillToPaint } from "../src/leafer/scene";

const pctPoint = (v: unknown) => {
  expect(typeof v).toBe("object");
  const p = v as Record<string, unknown>;
  expect(p.type).toBe("percent"); // 缺这个标记 = 画布渐变塌缩的回归
  return p;
};

describe("fillToPaint 渐变格式", () => {
  test("radial：from/to 带 type:percent，from=center、to=center+(0.5,0.5)，stops 映射 {offset,color}", () => {
    const paint = fillToPaint({
      type: "radial",
      center: { x: 0.3, y: 0.6 },
      stops: [
        { at: 0, color: "#cfcfcf" },
        { at: 1, color: "#fafafa" },
      ],
    } as Fill)!;
    expect(paint.type).toBe("radial");
    expect(pctPoint(paint.from)).toMatchObject({ x: 0.3, y: 0.6 });
    expect(pctPoint(paint.to)).toMatchObject({ x: 0.8, y: 1.1 });
    expect(paint.stops).toEqual([
      { offset: 0, color: "#cfcfcf" },
      { offset: 1, color: "#fafafa" },
    ]);
  });

  test("radial：center 缺省 (0.5,0.5)", () => {
    const paint = fillToPaint({ type: "radial", stops: [{ at: 0, color: "#fff" }] } as Fill)!;
    expect(pctPoint(paint.from)).toMatchObject({ x: 0.5, y: 0.5 });
    expect(pctPoint(paint.to)).toMatchObject({ x: 1, y: 1 });
  });

  test("linear：from/to 带 type:percent；文档角 0=自上而下（from 顶、to 底），缺省 angle=0 同此", () => {
    const paint = fillToPaint({
      type: "linear",
      stops: [
        { at: 0, color: "#000" },
        { at: 1, color: "#fff" },
      ],
    } as Fill)!;
    expect(paint.type).toBe("linear");
    expect(pctPoint(paint.from)).toMatchObject({ x: 0.5, y: 0 });
    expect(pctPoint(paint.to)).toMatchObject({ x: 0.5, y: 1 });
  });

  test("linear：angle=90 顺时针 → 自右向左（与 css.ts 180+θ=270deg 同向）", () => {
    const paint = fillToPaint({ type: "linear", angle: 90, stops: [{ at: 0, color: "#000" }] } as Fill)!;
    expect(pctPoint(paint.from).x).toBeCloseTo(1, 9);
    expect(pctPoint(paint.from).y).toBeCloseTo(0.5, 9);
    expect(pctPoint(paint.to).x).toBeCloseTo(0, 9);
    expect(pctPoint(paint.to).y).toBeCloseTo(0.5, 9);
  });

  test("linear：angle=270 → 自左向右", () => {
    const paint = fillToPaint({ type: "linear", angle: 270, stops: [{ at: 0, color: "#000" }] } as Fill)!;
    expect(pctPoint(paint.from).x).toBeCloseTo(0, 9);
    expect(pctPoint(paint.from).y).toBeCloseTo(0.5, 9);
    expect(pctPoint(paint.to).x).toBeCloseTo(1, 9);
    expect(pctPoint(paint.to).y).toBeCloseTo(0.5, 9);
  });

  test("fill.opacity 折进颜色 alpha（leafer paint.opacity 字段会被忽略 → 半透明白条画成不透明白，遮住下方 home 指示条）", () => {
    expect(fillToPaint({ type: "solid", color: "#ffffff", opacity: 0.62 } as Fill)).toEqual({
      type: "solid",
      color: "rgba(255,255,255,0.62)",
    });
    expect(fillToPaint({ type: "solid", color: "#000000", opacity: 0.3 } as Fill)).toEqual({
      type: "solid",
      color: "rgba(0,0,0,0.3)",
    });
    // 色带 alpha 与 fill.opacity 相乘；渐变 stops 同样折算，paint 上不再挂 opacity
    const grad = fillToPaint({
      type: "linear",
      angle: 180,
      opacity: 0.5,
      stops: [
        { at: 0, color: "#ff000080" },
        { at: 1, color: "rgb(0,255,0)" },
      ],
    } as Fill)!;
    expect(grad.opacity).toBeUndefined();
    const stops = grad.stops as { offset: number; color: string }[];
    expect(stops[0]!.color).toBe("rgba(255,0,0,0.251)");
    expect(stops[1]!.color).toBe("rgba(0,255,0,0.5)");
    // 不透明：颜色原样透传；命名色解析失败 → 颜色不动、退回 opacity 字段（leafer 会忽略，好过丢色）
    expect(fillToPaint({ type: "solid", color: "#abc" } as Fill)).toEqual({ type: "solid", color: "#abc" });
    expect(fillToPaint({ type: "solid", color: "red", opacity: 0.5 } as Fill)).toEqual({
      type: "solid",
      color: "red",
      opacity: 0.5,
    });
    // image 填充保留 paint.opacity（走 leafer 图片管线，不吃颜色 alpha）
    expect(fillToPaint({ type: "image", src: "a.png", opacity: 0.8 } as Fill)).toBeNull(); // 无 ctx 仍兜底 null
    expect(fillToPaint({ type: "solid", color: "#abc", visible: false } as Fill)).toBeNull();
    expect(fillToPaint({ type: "image", src: "a.png" } as Fill)).toBeNull();
  });
});
