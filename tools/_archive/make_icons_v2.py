"""
格物 App 图标生成器 · v2（米白底「格」字）

设计要点（针对桌面截图反馈重做）：
  1. 底色 #F7F4EF 暖米白 —— 与 App 内 paper 色一致，比纯白多点纸感，
     在深色壁纸上靠自身形状立住，在浅色壁纸上靠棕字拉开对比。
  2. 主体「格」字，墨迹外接框只占画布 44%（旧版 58%，桌面偏满）。
  3. 笔画不加粗、不加内框，保证 48px 仍能认出结构。
  4. 输出 G1/G2/G3/G4 四档字号候选供挑选，另出 G1 的完整素材组。

字形：华文中宋 STZHONGS.TTF（与界面衬线标题一致）
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "images")
PREVIEW = os.path.join(HERE, "preview")

PAPER = (247, 244, 239)      # #F7F4EF 暖米白
BROWN = (140, 90, 52)        # #8C5A34 赭石棕
WHITE = (255, 255, 255)
DARK = (36, 30, 25)

SERIF = r"C:\Windows\Fonts\STZHONGS.TTF"

S = 1024
SS = 4

# 字号候选：墨迹外接框边长 / 1024
CANDIDATES = {
    "G1": 0.44,   # 推荐：留白足，桌面不挤
    "G2": 0.48,   # 稍大，接近主流文字类图标
    "G3": 0.40,   # 更克制，偏印鉴留白
    "G4": 0.52,   # 上限，仍明显小于旧版 0.58
}


def glyph_layer(ch, box, color):
    """按墨迹外接框精确居中，返回 (RGBA图层, 外框宽, 外框高)。"""
    fs = 400
    font = ImageFont.truetype(SERIF, fs)
    probe = Image.new("L", (fs * 2, fs * 2), 0)
    ImageDraw.Draw(probe).text((fs // 2, fs // 2), ch, font=font, fill=255)
    b = probe.getbbox()
    cur = max(b[2] - b[0], b[3] - b[1])
    fs2 = int(fs * box / cur)

    font2 = ImageFont.truetype(SERIF, fs2)
    big = fs2 * 2
    probe2 = Image.new("L", (big, big), 0)
    ImageDraw.Draw(probe2).text((big // 2, big // 2), ch, font=font2, fill=255)
    b2 = probe2.getbbox()
    glyph = probe2.crop(b2)
    layer = Image.new("RGBA", glyph.size, tuple(color) + (255,))
    return layer, glyph


def render_char(bg, fg, box, ch="格", transparent=False, over=1.0,
                radius_ratio=0.0, square=False):
    """底色 bg / 字色 fg / 字框 box（占画布比例）"""
    n = S * SS
    base = Image.new("RGBA", (n, n), (0, 0, 0, 0) if transparent else tuple(bg) + (255,))

    box_px = n * box * over
    layer, mask = glyph_layer(ch, box_px, fg)
    # 透明前景（自适应图标）时字保持不变，只是画布放大 over 倍后被裁
    gx = int(n / 2 - layer.width / 2)
    gy = int(n / 2 - layer.height / 2)
    base.paste(layer, (gx, gy), mask)

    im = base.resize((S, S), Image.LANCZOS)

    if transparent:
        return im
    if square:
        return im
    if radius_ratio > 0:
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle(
            [0, 0, S - 1, S - 1], radius=int(S * radius_ratio), fill=255)
        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        out.paste(im, (0, 0), m)
        return out
    return im


# ---------------------------------------------------------------- 预览图

def sheet(key, box):
    """一张对比图：深色壁纸行 + 浅色壁纸行，档位 128/96/64/48/32。"""
    master = render_char(PAPER, BROWN, box, radius_ratio=0.2246)
    W, H = 1240, 640
    canvas = Image.new("RGB", (W, H), (250, 248, 245))
    d = ImageDraw.Draw(canvas)
    d.rectangle([36, 36, W - 36, 316], fill=DARK)
    x = 84
    for sz in (128, 96, 64, 48, 32):
        ic = master.resize((sz, sz), Image.LANCZOS)
        canvas.paste(ic, (x, 56 + (128 - sz) // 2), ic)
        x += sz + 52
    d.rectangle([36, 344, W - 36, 604], fill=(232, 228, 222))
    x = 84
    for sz in (128, 96, 64, 48, 32):
        ic = master.resize((sz, sz), Image.LANCZOS)
        canvas.paste(ic, (x, 364 + (128 - sz) // 2), ic)
        x += sz + 52
    os.makedirs(PREVIEW, exist_ok=True)
    p = os.path.join(PREVIEW, f"v2_{key}.png")
    canvas.save(p)
    return p


def draw_drawers(im, cx, cy, size, lw, color):
    """E2 双屉（仅用于并排对比）"""
    d = ImageDraw.Draw(im)
    w = size * 1.02
    h = size * 0.375
    gap = size * 0.13
    r = h * 0.40
    top = cy - h - gap / 2
    bot = cy + gap / 2
    d.rounded_rectangle([cx - w / 2, top, cx + w / 2, top + h], radius=r, fill=color)
    d.rounded_rectangle([cx - w / 2, bot, cx + w / 2, bot + h], radius=r, fill=color)


def compare_all():
    """四档字号并排，深色壁纸上从 128 到 32 一起看。"""
    W, H = 1240, 700
    canvas = Image.new("RGB", (W, H), DARK)
    x = 60
    for key, box in CANDIDATES.items():
        master = render_char(PAPER, BROWN, box, radius_ratio=0.2246)
        col = Image.new("RGB", (240, 640), DARK)
        y = 40
        for sz in (128, 96, 64, 48, 32):
            ic = master.resize((sz, sz), Image.LANCZOS)
            col.paste(ic, (60, y), ic)
            y += sz + 40
        canvas.paste(col, (x, 30))
        x += 290
    os.makedirs(PREVIEW, exist_ok=True)
    p = os.path.join(PREVIEW, "v2_compare.png")
    canvas.save(p)
    return p


# ---------------------------------------------------------------- 交付素材

def deliver(key="G1"):
    """按选定档位产出整套素材（替换项目内文件）。"""
    box = CANDIDATES[key]
    os.makedirs(OUT, exist_ok=True)
    made = []

    # 1. iOS / 通用主图标：米白底，圆角 22.46%
    master = render_char(PAPER, BROWN, box, radius_ratio=0.2246)
    p = os.path.join(OUT, "icon.png")
    master.save(p); made.append(p)
    master.resize((64, 64), Image.LANCZOS).convert("RGB").save(
        os.path.join(OUT, "favicon.png"))

    # 2. 安卓自适应前景：透明底 + 棕色字，字框按 0.62 放大以适配 66.7% 安全区
    render_char(PAPER, BROWN, box, transparent=True, over=0.62).save(
        os.path.join(OUT, "android-icon-foreground.png"))
    # 3. 安卓主题图标：黑色单色，系统自行着色
    render_char(PAPER, (0, 0, 0), box, transparent=True, over=0.62).save(
        os.path.join(OUT, "android-icon-monochrome.png"))

    # 4. 启动图：米白底，字略小
    sp = render_char(PAPER, BROWN, box * 0.78)
    sp.save(os.path.join(OUT, "splash-icon.png"))

    # 5. 备选档位预览
    for k, bx in CANDIDATES.items():
        if k == key:
            continue
        render_char(PAPER, BROWN, bx, radius_ratio=0.2246).save(
            os.path.join(OUT, f"icon_{k}.png"))
    return made


if __name__ == "__main__":
    print("生成候选预览…")
    print("  ->", compare_all())
    for k, v in CANDIDATES.items():
        print(f"  {k} box={v} ->", sheet(k, v))
    print("完成（未覆盖项目文件，等待确认档位）")
