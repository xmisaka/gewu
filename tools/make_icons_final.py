"""
格物 App 图标生成器 · 定稿版（米白底 + 赭石棕「格」字）

方案：STSong / 华文中宋「格」字，笔画做 2.2px（@1024 尺度）膨胀加粗。

为什么加粗：
  中宋笔画细，缩到 48px 以下会散架。MaxFilter 膨胀能在不改变字形骨架
  （横细竖粗、撇捺出锋）的前提下把笔画压实，小尺寸辨识度接近黑体，
  同时保住宋体的书斋气质。

为什么字框 44%：
  旧版 58% 在桌面上太满、四周无留白。44% 是实测下限 —— 再小则 32px
  无法辨认结构，且视觉上会显得图标「空」。

底色 #F7F4EF：
  与 App 内 Palette.paper 一致。暖米白比纯白更耐看，也能与桌面上一众
  纯白图标拉开层次，不会连成一片。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "images")
PREVIEW = os.path.join(HERE, "preview")

PAPER = (247, 244, 239)      # #F7F4EF 暖米白（= Palette.paper）
BROWN = (140, 90, 52)        # #8C5A34 赭石棕（= Palette.brand）
DARK = (36, 30, 25)

SERIF = r"C:\Windows\Fonts\STZHONGS.TTF"   # 华文中宋

S = 1024
SS = 4

BOX = 0.44        # 「格」字墨迹外接框 / 画布
FAT = 2.2         # 笔画加粗量（@1024 尺度，px）
RADIUS = 0.2246   # 四角半径比例（主流启动器遮罩）


def glyph_mask(box_px, ch="格"):
    """生成按墨迹外接框精确居中的 L 蒙版。"""
    fs = 400
    font = ImageFont.truetype(SERIF, fs)
    p = Image.new("L", (fs * 3, fs * 3), 0)
    ImageDraw.Draw(p).text((fs, fs), ch, font=font, fill=255)
    b = p.getbbox()
    cur = max(b[2] - b[0], b[3] - b[1])
    fs2 = int(fs * box_px / cur)

    f2 = ImageFont.truetype(SERIF, fs2)
    big = fs2 * 3
    p2 = Image.new("L", (big, big), 0)
    ImageDraw.Draw(p2).text((big // 2, big // 2), ch, font=f2, fill=255)
    m = p2.crop(p2.getbbox())

    if FAT > 0:
        m = m.filter(ImageFilter.MaxFilter(int(FAT * SS) * 2 + 1))
        m = m.filter(ImageFilter.GaussianBlur(0.6))
    return m


def render(bg, fg, box=None, transparent=False, over=1.0, radius=RADIUS,
           square=False, ch="格"):
    """bg 底色 / fg 字色；transparent=True 时输出透明底（安卓自适应用）。"""
    box = box or BOX
    n = int(S * SS * (over if transparent else 1.0))
    # 透明前景：画布放大 over 倍，字框同比放大，最后裁到中央 66.7% 安全区
    canvas_n = int(S * SS)
    base = Image.new("RGBA", (canvas_n, canvas_n),
                     (0, 0, 0, 0) if transparent else tuple(bg) + (255,))

    box_px = canvas_n * box * (over if transparent else 1.0)
    m = glyph_mask(box_px, ch)
    layer = Image.new("RGBA", m.size, tuple(fg) + (255,))
    base.paste(layer, (int(canvas_n / 2 - m.width / 2),
                       int(canvas_n / 2 - m.height / 2)), m)

    im = base.resize((S, S), Image.LANCZOS)
    if transparent or square:
        return im
    mk = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mk).rounded_rectangle([0, 0, S - 1, S - 1],
                                         radius=int(S * radius), fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(im, (0, 0), mk)
    return out


def contact(rows=None):
    """验收图：深色壁纸 + 浅色壁纸两行，128→24 全档。"""
    master = render(PAPER, BROWN)
    W, H = 1200, 700
    c = Image.new("RGB", (W, H), (250, 248, 245))
    d = ImageDraw.Draw(c)
    d.rectangle([36, 36, W - 36, 320], fill=DARK)
    x = 74
    for sz in (128, 96, 64, 48, 32, 24):
        ic = master.resize((sz, sz), Image.LANCZOS)
        c.paste(ic, (x, 56 + (128 - sz) // 2), ic)
        x += sz + 42
    d.rectangle([36, 348, W - 36, 664], fill=(232, 228, 222))
    x = 74
    for sz in (128, 96, 64, 48, 32, 24):
        ic = master.resize((sz, sz), Image.LANCZOS)
        c.paste(ic, (x, 368 + (128 - sz) // 2), ic)
        x += sz + 42
    os.makedirs(PREVIEW, exist_ok=True)
    p = os.path.join(PREVIEW, "final_contact.png")
    c.save(p)
    return p


def deliver():
    """产出整套素材，替换项目内文件。"""
    os.makedirs(OUT, exist_ok=True)
    print("定稿：中宋「格」字 · 米白底 · 字框 44% · 笔画加粗 2.2")

    # 1. 主图标（iOS / 通用）
    master = render(PAPER, BROWN)
    master.save(os.path.join(OUT, "icon.png"))
    print("  icon.png                    1024  主图标")

    # 2. favicon
    master.resize((64, 64), Image.LANCZOS).convert("RGB").save(
        os.path.join(OUT, "favicon.png"))
    print("  favicon.png                   64  网页图标")

    # 3. 安卓自适应前景（透明底棕字）
    render(PAPER, BROWN, transparent=True, over=0.62).save(
        os.path.join(OUT, "android-icon-foreground.png"))
    print("  android-icon-foreground.png 1024  自适应前景（透明）")

    # 4. 安卓主题图标（单色黑）
    render(PAPER, (0, 0, 0), transparent=True, over=0.62).save(
        os.path.join(OUT, "android-icon-monochrome.png"))
    print("  android-icon-monochrome.png 1024  主题图标（单色）")

    # 5. 启动图（米白底，字略小）
    render(PAPER, BROWN, box=BOX * 0.78).save(
        os.path.join(OUT, "splash-icon.png"))
    print("  splash-icon.png             1024  启动图")

    # 6. 清理上一版（E1/E2）的备选文件
    for f in os.listdir(OUT):
        if f.endswith(("_E1.png", "_E2.png")):
            os.remove(os.path.join(OUT, f))
            print("  清理旧备选", f)


if __name__ == "__main__":
    print("->", contact())
    deliver()
    print("完成")
