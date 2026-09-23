"""把 docs/releases/<tag>.md 渲染成「模拟 GitHub Release 页」，用于发布前确认排版。

Release 页解析不了仓库相对路径，图片必须走绝对 URL —— 这个渲染器照真实行为处理：
把 <img src="https://github.com/...?raw=true"> 原样保留（离线渲染时图是裂的，属正常，
真正发布后在 Release 页能显示）。
"""
import io
import os
import re
import sys

import markdown

HERE = os.path.dirname(os.path.abspath(__file__))
# 本脚本在 <repo>/tools/ 下，往上一级就是仓库根
REPO = os.path.abspath(os.path.join(HERE, ".."))


def render_body(md):
    """按 GitHub 的规则渲染正文。

    ★ 关键差异：python-markdown 的 `md_in_html` 要求 `<details markdown="1">` 才会
    解析其内部，而 **GitHub 不需要** —— `<summary>` 后面的空行会结束 HTML 块，
    之后的 markdown 照常解析（这正是折叠区里能放表格、列表的原因）。
    所以这里手工把 `<details>` 拆出来：容器标签原样保留，内部内容单独走 markdown。
    不这么处理，预览里折叠区的表格与列表会变成一堆裸 `|---` 和 `-`。
    """
    pattern = re.compile(r"<details>\s*<summary>(.*?)</summary>(.*?)</details>", re.S)
    out, pos = [], 0
    for m in pattern.finditer(md):
        out.append(("md", md[pos:m.start()]))
        out.append(("raw", "<details><summary>%s</summary>" % m.group(1).strip()))
        out.append(("md", m.group(2)))
        out.append(("raw", "</details>"))
        pos = m.end()
    out.append(("md", md[pos:]))

    chunks = []
    for kind, text in out:
        if kind == "raw":
            chunks.append(text)
        else:
            chunks.append(
                markdown.markdown(
                    text, extensions=["tables", "fenced_code", "md_in_html", "sane_lists"]
                )
            )
    return "\n".join(chunks)


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "v1.3.1"
    name = sys.argv[2] if len(sys.argv) > 2 else "格物 v1.3.1"
    assets = sys.argv[3:]  # 形如 "gewu-v1.3.1-arm64.apk|46.06 MB|格物 v1.3.1 · arm64 安装包"

    md_path = os.path.join(REPO, "docs", "releases", "%s.md" % tag)
    body = io.open(md_path, encoding="utf-8").read()

    html_body = render_body(body)

    rows = []
    for a in assets:
        parts = a.split("|")
        fn, size, label = parts[0], parts[1], parts[2] if len(parts) > 2 else ""
        rows.append(
            '<div class="asset"><span class="an">%s</span>'
            '<span class="sz">%s</span><span class="lb">%s</span></div>'
            % (fn, size, label)
        )
    assets_html = "\n".join(rows)

    page = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>%s</title><style>
:root{--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--accent:#0969da;--btn:#f6f8fa;}
*{box-sizing:border-box}
body{margin:0;padding:0;background:#fff;color:var(--fg);
  font:16px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",Helvetica,Arial,sans-serif;}
.topbar{background:#f6f8fa;border-bottom:1px solid var(--line);padding:10px 24px;
  font-size:13px;color:var(--muted);display:flex;gap:8px;align-items:center}
.repo{color:var(--accent);font-weight:600}
.tagpill{background:#ddf4ff;color:#0969da;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600}
.wrap{max-width:1012px;margin:0 auto;padding:24px}
h1.release{font-size:32px;line-height:1.25;margin:8px 0 4px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.sub{color:var(--muted);font-size:13px;margin:0 0 20px}
.body h1{font-size:24px;margin:28px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.body h2{font-size:20px;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.body h3{font-size:16px;margin:20px 0 8px}
.body img{vertical-align:top}
.body p{margin:10px 0}
.body a{color:var(--accent);text-decoration:none}
.body a:hover{text-decoration:underline}
.body code{background:rgba(129,139,152,.12);border-radius:4px;padding:.2em .4em;font-size:85%%;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.body pre{background:#f6f8fa;border-radius:6px;padding:14px;overflow:auto}
.body pre code{background:none;padding:0;font-size:13px}
.body blockquote{margin:12px 0;padding:0 1em;color:var(--muted);border-left:3px solid var(--line)}
.body table{border-collapse:collapse;display:block;overflow:auto;max-width:100%%;margin:12px 0}
.body table th,.body table td{border:1px solid var(--line);padding:6px 13px;text-align:left}
.body table th{background:#f6f8fa;font-weight:600}
.body details{border:1px solid var(--line);border-radius:6px;padding:10px 14px;margin:12px 0;background:#fff}
.body details summary{cursor:pointer;font-weight:600}
.body details[open]{background:#fbfcfd}
.body hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.body img{max-width:100%%}
.body p[align="center"] img{margin:0 2px}
.assets{margin-top:32px;padding-top:16px;border-top:2px solid var(--line)}
.assets h2{font-size:16px;margin:0 0 10px}
.asset{border:1px solid var(--line);border-radius:6px;padding:10px 14px;margin-bottom:8px;
  display:flex;gap:12px;align-items:baseline;background:#fff}
.asset .an{font-weight:600;font-family:ui-monospace,Consolas,monospace;font-size:14px}
.asset .sz{color:var(--muted);font-size:13px}
.asset .lb{color:var(--muted);font-size:13px;margin-left:auto}
.note{margin-top:26px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body>

<div class="topbar">
  <span class="repo">xmisaka/gewu</span>
  <span>&rsaquo; Releases</span>
  <span>&rsaquo;</span>
  <span class="tagpill">%s</span>
  <span style="margin-left:auto">Latest</span>
</div>

<div class="wrap">
  <h1 class="release">%s</h1>
  <p class="sub">模拟预览 · 发布前确认排版用 · 与真实 Release 页布局基本一致</p>
  <div class="body">
%s
  </div>

  <div class="assets">
    <h2>Assets</h2>
%s
  </div>

  <div class="note">此页由 docs/releases/%s.md 渲染，仅供发布前核对。图片为绝对 URL，
  离线打开时显示为裂图属正常 —— 发布后在 Release 页可正常显示。</div>
</div>
</body></html>
""" % (name, tag, name, html_body, assets_html, tag)

    out = os.path.join(REPO, "_build", "release-preview.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    io.open(out, "w", encoding="utf-8").write(page)
    print("已生成: %s" % out)


if __name__ == "__main__":
    main()
