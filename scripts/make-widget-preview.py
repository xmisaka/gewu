#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
格物 · 生成桌面小组件在选择器里的预览图

产出：android/app/src/main/res/drawable-nodpi/widget_gewu_preview.png

为什么要有这张图：Android 12 起，小组件选择器会给每个 provider 画一张预览。
没给 previewImage / previewLayout 时它只能拿 initialLayout 当预览 —— 而那份布局
里所有文字都是空的（文案由 Kotlin 在渲染时填），于是用户看到的是一个
**空白卡片**，根本不知道装上去长什么样。

为什么是手画而不是截真机：这张图要在**装机之前**就存在（它是打包资源），
而设计稿里那几张示意图正是照着真机参数（276×220dp、字体 10.5~14sp、
圆角 24dp）画的，直接按同一套数字重画一遍，两边不会分叉。

★ 用 2 倍图（552×440）放在 drawable-nodpi：不参与密度缩放，
  由选择器自己缩放到需要的尺寸。
★ 示例数据与 docs/widget-plan.html 的图注一致，改设计稿时一起改这里。

用法：
    python scripts/make-widget-preview.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- 尺寸与配色

SCALE = 2                    # 2 倍图
W_DP, H_DP = 276, 220        # 4×2 的真实可用尺寸（官方公式 73n-16 × 118m-16）
RADIUS_DP = 24
PAD_DP = 14
ROW_H_DP = 40
ROW_GAP_DP = 4

# 素笺（默认主题）。★ 与 src/constants/theme.ts 的 sujian 同源 ——
# 预览图用哪套主题是个选择题，选默认那套最不意外。
SURFACE = "#FFFFFF"
INK = "#2B241F"
INK3 = "#9A8D80"
INK4 = "#C9BEB0"
LINE3 = "#F1ECE4"
LINE = "#E3DCD1"
BRAND = "#8C5A34"
CLAY = "#AA523D"
CLAY_BG = "#F9EAE5"
AMBER = "#926521"
AMBER_BG = "#FBF1DF"

FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"

# 示例数据：与设计稿图注同一份
ROWS = [
    ("布洛芬缓释胶囊", "药箱", "过期 8 天", CLAY, CLAY_BG),
    ("免洗洗手液", "镜柜", "过期 4 天", CLAY, CLAY_BG),
    ("深海鱼油软胶囊", "厨房吊柜 第三层", "剩 1", AMBER, AMBER_BG),
]
COUNT = "共 4 件"
FOOT_LEFT = "还有 1 件 · 截至今天 09:12"
FOOT_RIGHT = "打开格物"

HEADER = "格物 · 待办"


def px(dp: float) -> int:
    return int(round(dp * SCALE))


def font(path: str, sp: float) -> ImageFont.FreeTypeFont:
    """sp 与 dp 在 1 倍屏幕上是同一个数；这里是 2 倍图，所以一起乘 SCALE"""
    return ImageFont.truetype(path, px(sp))


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    out = root / "android/app/src/main/res/drawable-nodpi/widget_gewu_preview.png"
    out.parent.mkdir(parents=True, exist_ok=True)

    w, h = px(W_DP), px(H_DP)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 卡片。★ 加一圈极淡的描边：这张图是透底的，而选择器的底色可能是浅色的，
    # 纯白卡片在浅底上会「消失」—— 一圈 line 色的描边就把它钉住了。
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=px(RADIUS_DP), fill=SURFACE, outline=LINE, width=px(1))

    pad = px(PAD_DP)
    content_w = w - pad * 2

    # 页眉
    # ★ 字重必须与布局里的实际设定对上，否则预览图和真机不一致 ——
    #   而用户是先看预览图、再装上去的，两者差一点都会被看出来。
    #   实际：页眉「格物 · 待办」与页脚「打开格物」都是常规体（布局里没设 textStyle），
    #   只有物品名是 sans-serif-medium（对应设计稿的 font-weight:500）。
    f_head = font(FONT_REG, 12)
    f_count = font(FONT_REG, 11)
    head_y = pad - px(2)
    d.text((pad, head_y), HEADER, font=f_head, fill=BRAND)
    cw = d.textlength(COUNT, font=f_count)
    d.text((w - pad - cw, head_y + px(2)), COUNT, font=f_count, fill=INK3)

    # 页眉下的分隔线
    rule_y = pad + px(20)
    d.rectangle([pad, rule_y, w - pad - 1, rule_y + px(0.5)], fill=LINE3)

    # 三行
    # ★ 名字用粗体字重顶替 sans-serif-medium：Windows 上没有「中黑」这一档可用
    #   （msyh 只有 Regular/Bold，msyhl 是 Light）。取舍是——宁可让预览图略重，
    #   也不要让它比真机**轻**：轻了会让人以为名字是灰的，重了只是显得挺一点。
    f_name = font(FONT_BOLD, 14)
    f_place = font(FONT_REG, 11)
    f_pill = font(FONT_REG, 11)
    row_top = rule_y + px(7)
    for name, place, status, fg, bg in ROWS:
        cy = row_top + px(9)
        # 状态圆点 6dp
        dot = px(3)
        d.ellipse([pad, cy - dot, pad + dot * 2, cy + dot], fill=fg)

        tx = pad + px(6) + px(8)
        d.text((tx, row_top + px(1)), name, font=f_name, fill=INK)
        d.text((tx, row_top + px(20)), place, font=f_place, fill=INK3)

        # 胶囊：量出文字宽度再加内距，右对齐 —— 与 Kotlin 侧现画底图同一套算法
        tw = d.textlength(status, font=f_pill)
        ph = px(20)
        pw = tw + px(7) * 2 + px(2)
        px0 = w - pad - pw
        py0 = row_top
        d.rounded_rectangle([px0, py0, px0 + pw, py0 + ph], radius=px(6), fill=bg)
        d.text((px0 + px(7), py0 + px(2)), status, font=f_pill, fill=fg)

        row_top += px(ROW_H_DP + ROW_GAP_DP)

    # 页脚
    foot_rule = h - pad - px(21)
    d.rectangle([pad, foot_rule, w - pad - 1, foot_rule + px(0.5)], fill=LINE3)

    f_foot = font(FONT_REG, 10.5)
    f_cta = font(FONT_REG, 11)
    fy = foot_rule + px(7)
    d.text((pad, fy), FOOT_LEFT, font=f_foot, fill=INK4)
    cw = d.textlength(FOOT_RIGHT, font=f_cta)
    d.text((w - pad - cw, fy), FOOT_RIGHT, font=f_cta, fill=BRAND)

    img.save(out)
    print(f"写出 {out}  ({w}×{h}px, {SCALE}x)")


if __name__ == "__main__":
    main()
