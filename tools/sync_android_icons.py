"""
安卓原生图标资源同步器（Python 版）

为什么不用 Node 脚本：
  @expo/image-utils 的 borderRadius 依赖 sharp；本机 sharp 不可用，
  会降级到 Jimp，而 Jimp 的 circleAsync 在方形画布上并不能正确裁圆
  （实测 ic_launcher_round.webp 仍是方形）。
  故改用 PIL 精确绘制圆角遮罩，产出可控且与设计稿一致。

产出与 Expo prebuild 的目录/命名/尺寸完全对齐：
  mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/
    ic_launcher.webp            legacy 方形，48 * scale
    ic_launcher_round.webp      legacy 圆形，48 * scale
    ic_launcher_foreground.webp adaptive 前景，108 * scale（透明）
    ic_launcher_monochrome.webp adaptive 单色，108 * scale（透明）
  drawable-{...}/splashscreen_logo.png
"""
import os
import sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
IMAGES = os.path.join(ROOT, "assets", "images")
PREVIEW = os.path.join(HERE, "preview")

BG = (247, 244, 239)          # #F7F4EF，与 app.json / colors.xml 一致
SS = 4                        # 超采样倍数

DPI = [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)]
LEGACY_BASE = 48
ADAPTIVE_BASE = 108
SPLASH = {"mdpi": 288, "hdpi": 432, "xhdpi": 576, "xxhdpi": 864, "xxxhdpi": 1152}


def rounded(img, size, radius_ratio):
    """把 img 缩放为 size×size，套圆角遮罩，底色 BG。"""
    n = size * SS
    base = Image.new("RGBA", (n, n), BG + (255,))
    fitted = img.resize((n, n), Image.LANCZOS)
    base.alpha_composite(fitted)

    if radius_ratio <= 0:
        return base.resize((size, size), Image.LANCZOS)

    r = n * radius_ratio
    if radius_ratio >= 0.5:
        r = n / 2  # 正圆
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1],
                                           radius=int(r), fill=255)
    out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def plain(img, size, transparent=True):
    """等比缩放到 size×size；transparent=True 时保留源图透明度，不填底。"""
    n = size * SS
    fitted = img.resize((n, n), Image.LANCZOS)
    if transparent:
        return fitted.resize((size, size), Image.LANCZOS)
    base = Image.new("RGBA", (n, n), BG + (255,))
    base.alpha_composite(fitted)
    return base.resize((size, size), Image.LANCZOS)


def main():
    icon = Image.open(os.path.join(IMAGES, "icon.png")).convert("RGBA")
    fg = Image.open(os.path.join(IMAGES, "android-icon-foreground.png")).convert("RGBA")
    mono = Image.open(os.path.join(IMAGES, "android-icon-monochrome.png")).convert("RGBA")
    splash = Image.open(os.path.join(IMAGES, "splash-icon.png")).convert("RGBA")

    print(f"底色 #F7F4EF  超采样 {SS}x")
    print()

    for key, scale in DPI:
        d = os.path.join(RES, f"mipmap-{key}")
        os.makedirs(d, exist_ok=True)
        legacy = round(LEGACY_BASE * scale)
        adapt = round(ADAPTIVE_BASE * scale)

        # legacy 方形（微圆角 22.46%，与设计稿一致；启动器会再裁）
        rounded(icon, legacy, 0.2246).save(os.path.join(d, "ic_launcher.webp"))
        # legacy 圆形
        rounded(icon, legacy, 0.5).save(os.path.join(d, "ic_launcher_round.webp"))
        # 自适应前景 / 单色（透明）
        plain(fg, adapt, transparent=True).save(
            os.path.join(d, "ic_launcher_foreground.webp"))
        plain(mono, adapt, transparent=True).save(
            os.path.join(d, "ic_launcher_monochrome.webp"))

        print(f"  mipmap-{key:9s} launcher {legacy:>3}px  圆 {legacy:>3}px  "
              f"前景 {adapt:>3}px  单色 {adapt:>3}px")

    print()
    for key, size in SPLASH.items():
        d = os.path.join(RES, f"drawable-{key}")
        os.makedirs(d, exist_ok=True)
        plain(splash, size, transparent=True).save(
            os.path.join(d, "splashscreen_logo.png"))
        print(f"  drawable-{key:8s} splashscreen_logo {size:>4}px")

    # 校验图：圆形 + 方形 + 前景
    os.makedirs(PREVIEW, exist_ok=True)
    d196 = os.path.join(RES, "mipmap-xhdpi")
    tiles = [
        Image.open(os.path.join(d196, "ic_launcher.webp")).convert("RGBA"),
        Image.open(os.path.join(d196, "ic_launcher_round.webp")).convert("RGBA"),
        Image.open(os.path.join(d196, "ic_launcher_foreground.webp")).convert("RGBA"),
    ]
    K = 3
    W = sum(t.width * K + 24 for t in tiles) + 24
    H = max(t.height for t in tiles) * K + 48
    c = Image.new("RGB", (W, H), (36, 30, 25))
    x = 24
    for t in tiles:
        b = t.resize((t.width * K, t.height * K), Image.NEAREST)
        c.paste(b, (x, 24), b)
        x += b.width + 24
    c.save(os.path.join(PREVIEW, "native_check.png"))
    print(f"\n校验图 -> {os.path.join(PREVIEW, 'native_check.png')}")
    print("完成。")


if __name__ == "__main__":
    main()
