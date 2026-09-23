"""圆桌候选：三套完整图标方案，同场对比。

T1 中宋「格」    —— 沿用界面衬线，气质最贴，但细笔画在 32px 会散
T2 雅黑粗「格」  —— 笔画结实，小尺寸最清楚，但丢了书斋的宋体骨架
T3 柜格几何      —— 不用文字，圆角轮廓 + 内部分格 + 格中一点，缩放最稳

同时给每个方案做一次「笔画加粗」处理，看能否两全。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PREVIEW = os.path.join(HERE, "preview")
PAPER = (247, 244, 239)
BROWN = (140, 90, 52)
DARK = (36, 30, 25)
S = 1024
SS = 4
WINF = r"C:\Windows\Fonts"


def make_mask(path, box_px, ch="格"):
    fs = 400
    font = ImageFont.truetype(path, fs)
    p = Image.new("L", (fs * 3, fs * 3), 0)
    ImageDraw.Draw(p).text((fs, fs), ch, font=font, fill=255)
    b = p.getbbox()
    cur = max(b[2] - b[0], b[3] - b[1])
    fs2 = int(fs * box_px / cur)
    f2 = ImageFont.truetype(path, fs2)
    big = fs2 * 3
    p2 = Image.new("L", (big, big), 0)
    ImageDraw.Draw(p2).text((big // 2, big // 2), ch, font=f2, fill=255)
    return p2.crop(p2.getbbox())


def fatten(mask, px):
    """笔画加粗：MaxFilter 膨胀，再用高斯回一点圆角。"""
    if px <= 0:
        return mask
    k = int(px) * 2 + 1
    m = mask.filter(ImageFilter.MaxFilter(k))
    return m.filter(ImageFilter.GaussianBlur(0.6))


def compose(painter, radius=0.2246, n=None):
    n = n or S * SS
    base = Image.new("RGBA", (n, n), tuple(PAPER) + (255,))
    painter(base, n)
    im = base.resize((S, S), Image.LANCZOS)
    mk = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mk).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * radius), fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(im, (0, 0), mk)
    return out


def char_painter(path, box, fat=0):
    def p(base, n):
        m = make_mask(path, n * box)
        if fat:
            m = fatten(m, fat * SS)
        layer = Image.new("RGBA", m.size, tuple(BROWN) + (255,))
        base.paste(layer, (int(n / 2 - m.width / 2), int(n / 2 - m.height / 2)), m)
    return p


def grid_painter(lw_ratio=0.072, box=0.60):
    """柜格：圆角方框 + 等分十字 + 右上格中央圆点。"""
    def p(base, n):
        d = ImageDraw.Draw(base)
        size = n * box
        half = size / 2
        cx = cy = n / 2
        lw = int(n * lw_ratio)
        x0, y0, x1, y1 = cx - half, cy - half, cx + half, cy + half
        r = int(size * 0.26)          # 外框圆角，呼应收纳柜的圆润
        d.rounded_rectangle([x0, y0, x1, y1], radius=r, outline=BROWN, width=lw)
        mx, my = cx, cy
        d.rounded_rectangle([x0 + lw / 2, my - lw / 2, x1 - lw / 2, my + lw / 2],
                            radius=lw / 2, fill=BROWN)
        d.rounded_rectangle([mx - lw / 2, y0 + lw / 2, mx + lw / 2, y1 - lw / 2],
                            radius=lw / 2, fill=BROWN)
        # 右上格中央一枚实心圆点
        qx = (mx + x1) / 2
        qy = (y0 + my) / 2
        rr = size * 0.088
        d.ellipse([qx - rr, qy - rr, qx + rr, qy + rr], fill=BROWN)
    return p


CAND = [
    ("T1 中宋", char_painter(os.path.join(WINF, "STZHONGS.TTF"), 0.44)),
    ("T1+ 中宋加粗", char_painter(os.path.join(WINF, "STZHONGS.TTF"), 0.44, fat=2.2)),
    ("T2 雅黑粗", char_painter(os.path.join(WINF, "msyhbd.ttc"), 0.44)),
    ("T3 柜格", grid_painter()),
]

# 并排：每个方案一行，尺寸 128/96/64/48/32
def build():
    os.makedirs(PREVIEW, exist_ok=True)
    sizes = (128, 96, 64, 48, 32, 24)
    rowgap = 28
    colw = 210
    W = 120 + colw * len(sizes) + 60
    H = len(CAND) * (128 + rowgap) + 80
    c = Image.new("RGB", (W, H), DARK)
    y = 56
    for name, painter in CAND:
        m = compose(painter)
        x = 40
        for sz in sizes:
            ic = m.resize((sz, sz), Image.LANCZOS)
            c.paste(ic, (x, y + (128 - sz) // 2), ic)
            x += sz + (colw - sz)
        y += 128 + rowgap
    p = os.path.join(PREVIEW, "v2_round.png")
    c.save(p)
    print("  ->", p)
    # 32px 放大 6x
    z = Image.new("RGB", (len(CAND) * 260 + 40, 300), DARK)
    x = 20
    for name, painter in CAND:
        m = compose(painter).resize((32, 32), Image.LANCZOS)
        b = m.resize((240, 240), Image.LANCZOS)
        z.paste(b, (x, 30), b)
        x += 260
    p2 = os.path.join(PREVIEW, "v2_round_zoom.png")
    z.save(p2)
    print("  ->", p2)


if __name__ == "__main__":
    build()
