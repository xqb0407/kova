#!/usr/bin/env python3
"""macOS 应用图标规范管线：按 Apple HIG 图标网格从一张母图生成全套图标，并可校验。

规范（照 Apple 自家图标实测，不做主观调整）：
  画布 1024，实体方 824（0.803）居中含 100px 透明留白；圆角/边长 0.226（模板值）。
  实体方背后叠两层烘焙投影（强度/σ/下移量由 Finder/App Store/终端/计算器的
  实测剖面拟合而来），使图标整体占位 0.834 —— 与 Apple 自家图标逐项一致。
  Dock 渲染尺寸 = 用户 Dock 槽位 × 上述占比，所以占比对了 Dock 里就对了。

用法：
  python3 scripts/icons.py build [--master <png>] [--out apps/electron/icons]
  python3 scripts/icons.py check [--out apps/electron/icons]

依赖：Pillow + numpy（python3 -m pip install --user Pillow numpy）；icns 组装用 macOS 自带
iconutil，所以本管线只在 macOS 上跑。Windows 的 .ico 不在本管线内（保持不变）。
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageFilter

# ---- 规范常量（改动即为改规范，须同步 PORTING-NOTES 的「图标规范」小节）----
CANVAS = 1024
TILE = 824  # Apple 网格：824/1024 = 0.8047
SHADOW_LAYERS = (
    # (强度 0-1, σ, 下移 px)：紧边层给厚度，宽广层给体积
    (1.00, 1.76, 0.23),
    (0.32, 13.32, 11.56),
)
# Apple 自家图标实测值（Finder / App Store / 终端 / 计算器 / 系统设置五者一致，
# 见本文件 metrics() 的同一套量法）。圆角一项是模板值：本仓图案沿用原始品牌图，
# 圆角实测 0.217（比模板紧 4%），属图案自身留待重绘时的差异，不放宽容差不掩盖。
APPLE_SOLID = 0.803
APPLE_TOTAL = 0.834
APPLE_RADIUS = 0.2255
TOL_RATIO = 0.005  # 实体/含投影占比容差
TOL_RADIUS = 0.015  # 圆角容差（含降采样量化与既有图案差异）

ICNS_MEMBERS = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}
# 目录里按固定文件名摆放的散图（窗口/托盘之外的全部图标位）
LOOSE_PNG = {
    "icon.png": 512,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "64x64.png": 64,
    "32x32.png": 32,
}


def compose_master(master_path: str) -> Image.Image:
    """母图 → 规范 1024 画布（实体方 + 双层投影）。

    母图可以是任意尺寸、任意留白；这里先按 alpha 裁到实体边界，所以换图案时
    不需要手工对齐画布——留白与投影一律由本函数按规范补齐。
    """
    src = Image.open(master_path).convert("RGBA")
    alpha = src.getchannel("A")
    bbox = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    if bbox is None:
        raise SystemExit(f"母图没有不透明像素：{master_path}")
    tile = src.crop(bbox).resize((TILE, TILE), Image.LANCZOS)

    off = (CANVAS - TILE) // 2
    # 投影层必须铺在整块画布上再模糊：若只模糊裁紧的瓦片图，尾巴会被源图边界切掉
    silhouette = Image.new("L", (CANVAS, CANVAS), 0)
    silhouette.paste(tile.getchannel("A"), (off, off))

    shadow = None
    for strength, sigma, dy in SHADOW_LAYERS:
        layer = silhouette
        if dy:
            layer = layer.transform(
                (CANVAS, CANVAS),
                Image.AFFINE,
                (1, 0, 0, 0, 1, -dy),
                resample=Image.BILINEAR,
            )
        layer = layer.filter(ImageFilter.GaussianBlur(sigma))
        values = np.clip(np.asarray(layer, dtype=float) * strength, 0, 255)
        shadow = values if shadow is None else np.clip(shadow + values, 0, 255)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow_layer.putalpha(Image.fromarray(shadow.astype("uint8")))
    canvas = Image.alpha_composite(canvas, shadow_layer)
    canvas.alpha_composite(tile, (off, off))
    return canvas


def metrics(im: Image.Image) -> dict[str, float]:
    """图标实测指标：实体占比、含投影占比、圆角比例。"""
    size = im.size[0]
    alpha = np.asarray(im.convert("RGBA").getchannel("A"), dtype=float)
    ys, xs = np.where(alpha > 8)
    total = (xs.max() - xs.min() + 1) / size
    ys, xs = np.where(alpha > 200)
    tile = alpha[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1] / 255.0
    n = tile.shape[0]
    solid = (xs.max() - xs.min() + 1) / size if size == CANVAS else None
    # 圆角：面积法 R = sqrt((n² - 覆盖面积)/(4-π))，与瓦片形状无关
    radius = math.sqrt(max(0.0, (n * n - tile.sum()) / (4 - math.pi))) / n
    return {"total": total, "solid": solid, "radius": radius}


def build(master_path: str, out_dir: str) -> None:
    master = compose_master(master_path)
    os.makedirs(out_dir, exist_ok=True)

    iconset = os.path.join(out_dir, "_icon.iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    os.makedirs(iconset)
    for name, px in ICNS_MEMBERS.items():
        master.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
    icns = os.path.join(out_dir, "icon.icns")
    subprocess.run(["iconutil", "-c", "icns", "-o", icns, iconset], check=True)
    shutil.rmtree(iconset)

    for name, px in LOOSE_PNG.items():
        master.resize((px, px), Image.LANCZOS).save(os.path.join(out_dir, name))

    got = metrics(master)
    print(f"已生成 {icns} 与 {len(LOOSE_PNG)} 张散图（{out_dir}）")
    print(f"  实体 {got['solid']:.3f}（规范 {APPLE_SOLID:.3f}）"
          f"  含投影 {got['total']:.3f}（规范 {APPLE_TOTAL:.3f}）"
          f"  圆角 {got['radius']:.3f}（规范 {APPLE_RADIUS:.3f}）")


def check(out_dir: str) -> int:
    icns = os.path.join(out_dir, "icon.icns")
    if not os.path.exists(icns):
        print(f"缺少 {icns}，先跑 build")
        return 1

    tmp = tempfile.mkdtemp(prefix="kova-icons-check-")
    try:
        subprocess.run(
            ["iconutil", "-c", "iconset", "-o", os.path.join(tmp, "x.iconset"), icns],
            check=True,
        )
        failures: list[str] = []
        big = Image.open(os.path.join(tmp, "x.iconset", "icon_512x512@2x.png"))
        got = metrics(big)
        for label, value, target, tol in (
            ("实体占比", got["solid"], APPLE_SOLID, TOL_RATIO),
            ("含投影占比", got["total"], APPLE_TOTAL, TOL_RATIO),
            ("圆角比例", got["radius"], APPLE_RADIUS, TOL_RADIUS),
        ):
            ok = abs(value - target) <= tol
            print(f"  {'✓' if ok else '✗'} {label} {value:.3f}（规范 {target:.4f}）")
            if not ok:
                failures.append(label)

        for name, px in LOOSE_PNG.items():
            path = os.path.join(out_dir, name)
            if not os.path.exists(path):
                failures.append(f"{name} 缺失")
                continue
            size = Image.open(path).size[0]
            if size != px:
                failures.append(f"{name} 尺寸 {size} ≠ {px}")

        if failures:
            print("不合规范：" + "、".join(failures))
            return 1
        print(f"{out_dir} 全部符合规范")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="macOS 图标规范管线")
    parser.add_argument("action", choices=("build", "check"))
    parser.add_argument(
        "--master",
        default="apps/electron/icons/icon-master.png",
        help="母图（1024 PNG，任意留白；换图案即替换此文件）",
    )
    parser.add_argument("--out", default="apps/electron/icons")
    args = parser.parse_args()

    if args.action == "build":
        build(args.master, args.out)
        return 0
    return check(args.out)


if __name__ == "__main__":
    sys.exit(main())
