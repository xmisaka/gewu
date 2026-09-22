"""
格物 App 图标生成器
候选方案：
  E1 柜格     —— 圆角方框 + 等分十字 + 右上格圆点
  E2 双屉     —— 两层实心圆角抽屉条
  F2 白底棕字 —— 「格」字，华文中宋
风格：白底 + 单色，匹配主流扁平图标语言。
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "assets", "images")
PREVIEW = os.path.join(HERE, "preview")

BROWN = (140, 90, 52)
WHITE = (255, 255, 255)
PAPER = (251, 249, 246)
DARK = (32, 27, 23)

SERIF = r"C:\Windows\Fonts\STZHONGS.TTF"   # 华文中宋

S = 1024
SS = 4


def _seg(d, ax, ay, bx, by, lw, color):
    R = lw / 2
    d.line([ax, ay, bx, by], fill=color, width=int(lw))
    d.ellipse([ax - R, ay - R, ax + R, ay + R], fill=color)
    d.ellipse([bx - R, by - R, bx + R, by + R], fill=color)


def draw_grid(im, cx, cy, size, lw, color):
    """柜格：圆角方框 + 等分十字梁，右上格中央一枚圆点。"""
    d = ImageDraw.Draw(im)
    half = size / 2
    x0, y0, x1, y1 = cx - half, cy - half, cx + half, cy + half
    inset = lw / 2
    ax0, ay0, ax1, ay1 = x0 + inset, y0 + inset, x1 - inset, y1 - inset
    _seg(d, ax0, ay0, ax1, ay0, lw, color)
    _seg(d, ax0, ay1, ax1, ay1, lw, color)
    _seg(d, ax0, ay0, ax0, ay1, lw, color)
    _seg(d, ax1, ay0, ax1, ay1, lw, color)
    mx, my = (ax0 + ax1) / 2, (ay0 + ay1) / 2
    _seg(d, ax0, my, ax1, my, lw, color)
    _seg(d, mx, ay0, mx, ay1, lw, color)
    cxx = (mx + ax1) / 2
    cyy = (ay0 + my) / 2
    r = (my - ay0 - lw) * 0.24
    d.ellipse([cxx - r, cyy - r, cxx + r, cyy + r], fill=color)


def draw_drawers(im, cx, cy, size, lw, color):
    """双屉：两层实心圆角抽屉条。size = 整体高度。"""
    d = ImageDraw.Draw(im)
    w = size * 1.02
    h = size * 0.375
    gap = size * 0.13
    r = h * 0.40
    top = cy - h - gap / 2
    bot = cy + gap / 2
    d.rounded_rectangle([cx - w / 2, top, cx + w / 2, top + h], radius=r, fill=color)
    d.rounded_rectangle([cx - w / 2, bot, cx + w / 2, bot + h], radius=r, fill=color)


def draw_char(im, cx, cy, size, lw, color, ch="格"):
    """
    白底棕字：单字居中，按墨迹外接框精确对齐。
    size = 目标墨迹外接框边长。
    """
    fs = 400
    font = ImageFont.truetype(SERIF, fs)
    probe = Image.new("L", (fs * 2, fs * 2), 0)
    ImageDraw.Draw(probe).text((fs // 2, fs // 2), ch, font=font, fill=255)
    b = probe.getbbox()
    cur = max(b[2] - b[0], b[3] - b[1])
    fs2 = int(fs * size / cur)

    font2 = ImageFont.truetype(SERIF, fs2)
    big = fs2 * 2
    probe2 = Image.new("L", (big, big), 0)
    ImageDraw.Draw(probe2).text((big // 2, big // 2), ch, font=font2, fill=255)
    b2 = probe2.getbbox()
    glyph = probe2.crop(b2)
    ox = int(cx - glyph.width / 2)
    oy = int(cy - glyph.height / 2)
    layer = Image.new("RGBA", glyph.size, color + (255,))
    im.paste(layer, (ox, oy), glyph)


STYLES = {
    "E1": dict(fn=draw_grid, size=0.70, name="柜格"),
    "E2": dict(fn=draw_drawers, size=0.40, name="双屉"),
    "F2": dict(fn=draw_char, size=0.66, name="白底棕字"),
}


def render(style, bg, fg, transparent=False, over=1.0, radius_ratio=0.0):
    n = S * SS
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0) if transparent else bg + (255,))
    cfg = STYLES[style]
    cfg["fn"](im, n / 2, n / 2, n * cfg["size"] * over, n * 0.063 * over, fg)
    im = im.resize((S, S), Image.LANCZOS)
    if radius_ratio > 0:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, S - 1, S - 1], radius=int(S * radius_ratio), fill=255)
        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        out.paste(im, (0, 0), mask)
        return out
    return im


def contact_sheet(style):
    master = render(style, WHITE, BROWN, radius_ratio=0.2246)
    W, H = 1200, 620
    canvas = Image.new("RGB", (W, H), (250, 248, 245))
    d = ImageDraw.Draw(canvas)
    d.rectangle([40, 40, W - 40, 300], fill=DARK)
    x = 90
    for sz in (128, 96, 64, 48, 32):
        ic = master.resize((sz, sz), Image.LANCZOS)
        canvas.paste(ic, (x, 60 + (128 - sz) // 2), ic)
        x += sz + 46
    d.rectangle([40, 330, W - 40, 580], fill=(238, 234, 228))
    x = 90
    for sz in (128, 96, 64, 48, 32, 24):
        ic = master.resize((sz, sz), Image.LANCZOS)
        canvas.paste(ic, (x, 350 + (128 - sz) // 2), ic)
        x += sz + 46
    os.makedirs(PREVIEW, exist_ok=True)
    p = os.path.join(PREVIEW, f"sheet_{style}.png")
    canvas.save(p)
    print("  preview ->", p)


def main():
    os.makedirs(OUT, exist_ok=True)
    for style in ("E1", "E2", "F2"):
        cfg = STYLES[style]
        print(f"生成 {style} · {cfg['name']}")
        master = render(style, WHITE, BROWN, radius_ratio=0.2246)
        master.save(os.path.join(OUT, f"icon_{style}.png"))
        render(style, WHITE, BROWN, transparent=True, over=0.62).save(
            os.path.join(OUT, f"android-icon-foreground_{style}.png"))
        render(style, WHITE, (0, 0, 0), transparent=True, over=0.62).save(
            os.path.join(OUT, f"android-icon-monochrome_{style}.png"))

        sp = Image.new("RGB", (S, S), PAPER)
        cfg["fn"](sp, S / 2, S / 2, S * cfg["size"] * 0.78, S * 0.049, BROWN)
        sp.save(os.path.join(OUT, f"splash-icon_{style}.png"))

        master.resize((64, 64), Image.LANCZOS).convert("RGB").save(
            os.path.join(OUT, f"favicon_{style}.png"))
        contact_sheet(style)


if __name__ == "__main__":
    main()
