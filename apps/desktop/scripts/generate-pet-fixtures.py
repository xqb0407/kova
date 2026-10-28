"""生成桌宠模块的动图 fixture 到 apps/desktop/public/pet-fixtures/。

产物（dev-preview/pet 预览页 ② 区使用）：
- boil.apng       —— APNG：呼吸起伏的圆豆，8 帧循环
- bounce.webp     —— 动图 WebP：弹跳小球，8 帧循环
- atlas-sheet.webp —— 8×9 静态图集占位（验「外部图集 URL」通道，非动图）

跑法：python3 apps/desktop/scripts/generate-pet-fixtures.py
需要 Pillow（支持 APNG / 动图 WebP 保存）。产物是演示素材，可随时重新生成。
"""

import math
import pathlib

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "pet-fixtures"

BODY = (246, 168, 33, 255)
OUTLINE = (138, 90, 16, 255)
EYE = (34, 34, 34, 255)


def blob_frame(size: int, phase: float) -> Image.Image:
    """呼吸圆豆的一帧：phase ∈ [0,1) 控制起伏与眨眼。"""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    squish = 1 + 0.06 * math.sin(phase * math.pi * 2)
    w = size * 0.56 * squish
    h = size * 0.68 / squish
    x0, y0 = (size - w) / 2, (size - h) / 2 + size * 0.06
    d.ellipse([x0, y0, x0 + w, y0 + h], fill=BODY, outline=OUTLINE, width=3)
    # 眼睛（第 5 帧眨眼）
    eye_h = size * 0.045 * (0.25 if abs(phase - 4 / 8) < 0.06 else 1)
    for side in (-1, 1):
        cx = size / 2 + side * size * 0.11
        cy = y0 + h * 0.38
        d.ellipse([cx - size * 0.045, cy - eye_h, cx + size * 0.045, cy + eye_h], fill=(255, 255, 255, 255))
        d.ellipse([cx - size * 0.02, cy - eye_h / 2, cx + size * 0.02, cy + eye_h / 2], fill=EYE)
    # 嘴
    my = y0 + h * 0.62
    d.arc([size / 2 - size * 0.06, my - size * 0.03, size / 2 + size * 0.06, my + size * 0.04], 20, 160, fill=OUTLINE, width=3)
    return im


def ball_frame(size: int, phase: float) -> Image.Image:
    """弹跳小球的一帧：抛物线高度 + 触地压扁。"""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    t = abs(math.sin(phase * math.pi))  # 0 地面 → 1 最高
    r = size * 0.18
    sq = 1 - 0.25 * (1 - t)  # 近地压扁
    cx = size / 2
    ground = size * 0.86
    cy = ground - r - (ground - 2 * r - size * 0.08) * t
    d.ellipse([cx - r * (2 - sq), cy - r * sq, cx + r * (2 - sq), cy + r * sq], fill=(74, 163, 255, 255), outline=(20, 60, 130, 255), width=3)
    return im


def atlas_sheet(size: int) -> Image.Image:
    """8×9 占位图集：每行帧号递增的小方块，验外部图集加载与行切换（非动图）。"""
    cols, rows = 8, 9
    im = Image.new("RGBA", (cols * size, rows * size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for row in range(rows):
        shade = 40 + row * 24
        for col in range(cols):
            x0, y0 = col * size, row * size
            d.rectangle([x0 + 8, y0 + 8 + col * 4, x0 + size - 8, y0 + size - 8], fill=(shade, 120 + col * 8, 200 - col * 10, 255), outline=(20, 20, 20, 255), width=2)
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    frames = [blob_frame(112, i / 8) for i in range(8)]
    frames[0].save(OUT / "boil.apng", save_all=True, append_images=frames[1:], duration=140, loop=0)
    ball = [ball_frame(112, i / 8) for i in range(8)]
    ball[0].save(OUT / "bounce.webp", save_all=True, append_images=ball[1:], duration=120, loop=0, format="WEBP")
    atlas_sheet(192).save(OUT / "atlas-sheet.webp", format="WEBP")
    for p in sorted(OUT.iterdir()):
        print(f"{p.name}: {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
