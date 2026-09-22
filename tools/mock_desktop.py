"""真机合成验证：把新图标贴回桌面截图，检查「格物」位置的实际观感。

截图 881x1920，「格物」图标位于底部 Dock 上方一排的第二个位置。
按实测坐标贴入，并用旁边「Expo Go」「贝壳找房」做同色系参照。
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PREVIEW = os.path.join(HERE, "preview")
SHOT = r"C:\Users\Administrator\.workbuddy\clipboard-images\clipboard-2026-09-21T06-23-23-357Z-e7f8b490.jpg"
ICON = os.path.join(ROOT, "assets", "images", "icon.png")

# 从截图里量出来的位置（881 宽的图）
CELL = 118          # 图标视觉边长
ROW_Y = 1455        # 该排顶部
COLS = {            # 列 -> 左边缘
    "expo": 48,
    "gewu": 200,
    "beike": 352,
}


def build():
    shot = Image.open(SHOT).convert("RGB")
    icon = Image.open(ICON).convert("RGBA").resize((CELL, CELL), Image.LANCZOS)

    # 1) 原图（对照）
    a = shot.copy()

    # 2) 换上新图标
    b = shot.copy()
    b.paste(icon, (COLS["gewu"], ROW_Y), icon)

    # 3) 并排
    W = a.width * 2 + 30
    c = Image.new("RGB", (W, a.height), (250, 248, 245))
    c.paste(a, (0, 0))
    c.paste(b, (a.width + 30, 0))

    # 4) 局部放大：格物 + 左右邻居
    x0 = COLS["expo"] - 14
    y0 = ROW_Y - 16
    x1 = COLS["beike"] + CELL + 14
    y1 = ROW_Y + CELL + 52
    crop = b.crop((x0, y0, x1, y1))
    k = 2.0
    crop = crop.resize((int(crop.width * k), int(crop.height * k)), Image.LANCZOS)

    os.makedirs(PREVIEW, exist_ok=True)
    p1 = os.path.join(PREVIEW, "mock_side.png")
    c.save(p1)
    p2 = os.path.join(PREVIEW, "mock_zoom.png")
    crop.save(p2)
    print("  ->", p1)
    print("  ->", p2)


if __name__ == "__main__":
    build()
