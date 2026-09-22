"""字形横评：同一个「格」字，不同字体 + 不同字号，看小尺寸辨识度。

结论要看两组：
  A 组 48px / 32px —— 桌面真实观感
  B 组 同字体四档字号 —— 判断字形本身的胖瘦是否合适
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PREVIEW = os.path.join(HERE, "preview")
PAPER = (247, 244, 239)
BROWN = (140, 90, 52)
DARK = (36, 30, 25)

WINFONTS = r"C:\Windows\Fonts"

FONTS = [
    ("中宋", os.path.join(WINFONTS, "STZHONGS.TTF"), 0),
    ("宋体", os.path.join(WINFONTS, "simsun.ttc"), 0),
    ("宋体粗", os.path.join(WINFONTS, "simsunb.ttf"), 0),
    ("雅黑", os.path.join(WINFONTS, "msyh.ttc"), 0),
    ("雅黑粗", os.path.join(WINFONTS, "msyhbd.ttc"), 0),
    ("黑体", os.path.join(WINFONTS, "simhei.ttf"), 0),
    ("楷体", os.path.join(WINFONTS, "STKAITI.TTF"), 0),
    ("仿宋", os.path.join(WINFONTS, "STFANGSO.TTF"), 0),
]

S = 1024
SS = 4


def load(path, size, index):
    """index=0 时按普通字体加载（ttc 用 index=0 取第一个字面）。"""
    if index:
        return ImageFont.truetype(path, size, index=index)
    return ImageFont.truetype(path, size)


def glyph_mask(path, index, box_px, ch="格"):
    """按墨迹外接框精确缩放到 box_px，返回 L 通道蒙版。"""
    fs = 400
    font = load(path, fs, index)
    probe = Image.new("L", (fs * 3, fs * 3), 0)
    ImageDraw.Draw(probe).text((fs, fs), ch, font=font, fill=255)
    b = probe.getbbox()
    if not b:
        return None
    cur = max(b[2] - b[0], b[3] - b[1])
    fs2 = int(fs * box_px / cur)

    font2 = load(path, fs2, index)
    big = fs2 * 3
    p2 = Image.new("L", (big, big), 0)
    ImageDraw.Draw(p2).text((big // 2, big // 2), ch, font=font2, fill=255)
    b2 = p2.getbbox()
    return p2.crop(b2)


def render(path, index, box, radius=0.2246):
    n = S * SS
    m = glyph_mask(path, index, n * box)
    base = Image.new("RGBA", (n, n), tuple(PAPER) + (255,))
    if m is not None:
        layer = Image.new("RGBA", m.size, tuple(BROWN) + (255,))
        base.paste(layer, (int(n / 2 - m.width / 2), int(n / 2 - m.height / 2)), m)
    im = base.resize((S, S), Image.LANCZOS)
    mk = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mk).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * radius), fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(im, (0, 0), mk)
    return out


def build():
    os.makedirs(PREVIEW, exist_ok=True)
    box = 0.44
    colw = 250
    W = colw * len(FONTS) + 40
    H = 460
    c = Image.new("RGB", (W, H), DARK)
    d = ImageDraw.Draw(c)
    for i, (name, path, idx) in enumerate(FONTS):
        x = 40 + i * colw
        try:
            ic48 = render(path, idx, box).resize((48, 48), Image.LANCZOS)
            ic32 = render(path, idx, box).resize((32, 32), Image.LANCZOS)
        except Exception as e:
            print("  !!", name, e)
            continue
        c.paste(ic48, (x + 40, 60), ic48)
        c.paste(ic32, (x + 48, 140), ic32)
        # 放大 4x 的 32px 供肉眼判断
        big = ic32.resize((128, 128), Image.NEAREST)
        c.paste(big, (x + 40, 210), big)
    c.save(os.path.join(PREVIEW, "v2_fonts.png"))
    print("  -> v2_fonts.png")


if __name__ == "__main__":
    build()
