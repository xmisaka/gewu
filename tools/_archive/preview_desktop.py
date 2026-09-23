"""把 E1/E2 图标贴进真实桌面截图位置，验证实际观感。"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "assets", "images")
PREVIEW = os.path.join(HERE, "preview")
SHOT = r"E:\WorkBuddy\Storage\_icon-research\full.png"

# 截图网格：5 列 x 6 行。第 5 行第 3 列（原神位）与第 6 行第 3 列作为替换位
# 单元格尺寸约 212px，起点 (88, 240)
CELL = 212
X0, Y0 = 88, 240
COLS, ROWS = 5, 6


def cell_pos(r, c):
    return X0 + c * CELL, Y0 + r * CELL


def paste_icon(base, icon, r, c, size=190):
    x, y = cell_pos(r, c)
    ic = icon.resize((size, size), Image.LANCZOS)
    ox = x + (CELL - size) // 2
    oy = y + (CELL - size) // 2
    base.paste(ic, (ox, oy), ic)


def main():
    base = Image.open(SHOT).convert("RGBA")
    # 原神（4行2列）、学车不（4行2列下方）、知识星球（5行1列）等位置替换
    targets = [(3, 2), (4, 2), (5, 2), (0, 0), (1, 0), (2, 0)]

    for style in ("E1", "E2"):
        canvas = base.copy()
        icon = Image.open(os.path.join(OUT, f"icon_{style}.png")).convert("RGBA")
        for (r, c) in targets:
            paste_icon(canvas, icon, r, c)
        p = os.path.join(PREVIEW, f"desktop_{style}.png")
        canvas.convert("RGB").save(p)
        print("->", p)


if __name__ == "__main__":
    main()
