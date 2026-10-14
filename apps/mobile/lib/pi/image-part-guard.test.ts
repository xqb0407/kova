/**
 * 图片渲染守卫单测：落盘图不被 scheme 卡死（此前只认 data:，file:// 会被静默丢弃
 * → 白屏）；内联图仍按 data:/file: 收窄；两路都过 mime 白名单。
 */
import { describe, expect, test } from "vitest";
import { isRenderableImagePart } from "./image-part-guard";

describe("图片渲染守卫", () => {
  test("落盘图（materialized）信任 uri，不卡 scheme", () => {
    expect(
      isRenderableImagePart({
        src: "file:///var/mobile/Containers/Data/Application/x/Caches/ImageManipulator/a.png",
        mimeType: "image/png",
        materialized: true,
      }),
    ).toBe(true);
    // 隧道阶段的远端引用同样放行（同一标记）
    expect(
      isRenderableImagePart({
        src: "https://gw.example.com/media/abc?sig=x&exp=1",
        mimeType: "image/jpeg",
        materialized: true,
      }),
    ).toBe(true);
    // 标记在但 src 空/非字符串 → 拒绝
    expect(isRenderableImagePart({ src: "", mimeType: "image/png", materialized: true })).toBe(false);
    expect(isRenderableImagePart({ mimeType: "image/png", materialized: true })).toBe(false);
  });

  test("内联图只放行 data:/file:", () => {
    expect(
      isRenderableImagePart({ src: "data:image/png;base64,AAAA", mimeType: "image/png" }),
    ).toBe(true);
    expect(
      isRenderableImagePart({ src: "file:///tmp/a.png", mimeType: "image/png" }),
    ).toBe(true);
    expect(
      isRenderableImagePart({ src: "http://evil/x.png", mimeType: "image/png" }),
    ).toBe(false);
    expect(isRenderableImagePart({ src: "", mimeType: "image/png" })).toBe(false);
  });

  test("mime 白名单两路都生效", () => {
    expect(
      isRenderableImagePart({ src: "data:image/svg+xml;base64,AA", mimeType: "image/svg+xml" }),
    ).toBe(false);
    expect(
      isRenderableImagePart({ src: "file:///tmp/a.svg", mimeType: "image/svg+xml", materialized: true }),
    ).toBe(false);
    expect(isRenderableImagePart(undefined)).toBe(false);
  });
});
