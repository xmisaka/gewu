#!/usr/bin/env node
/**
 * 格物 · 家庭财产清册：生成三套风格的样册 HTML（用于打印打样 / 回归）
 *
 * 为什么要有这个脚本
 * ------------------
 * 清册的排版正确性只能靠「真打出来看」验证：行数够不够、有没有截断、
 * 一页装多少行、页脚对不对。`tests/inventory.test.mjs` 只能断言
 * 「.pg 容器个数 == 声明的页数」「每页行数落在区间内」——它管不到
 * 浏览器实际的 FontMetrics（字宽、行高、border-collapse 的 0.264mm 增量）。
 *
 * 所以打样的正确流程是：
 *   1. 跑这个脚本 → 出 5 组样本 × 3 种风格的 HTML
 *   2. 用无头 Chrome 逐个打印成 PDF
 *   3. 数 PDF 里的 /Type /Page，和 HTML 里写的「共 N 页」比对
 *   4. 抽几页截图，肉眼确认没截断、没串列
 *
 * 样本刻意混入脏数据：超长名称、含 < & > 的名字、全角括号、
 * 缺购买日、缺价格、有数量（quantity>1）——这几种是最容易把
 * 表格撑爆或把金额算错的。
 *
 * 用法
 * ----
 *     node --experimental-strip-types scripts/make-inventory-samples.mjs
 *
 * （脚本自己会先 import tests/support/register.mjs，补上无扩展名 TS import 的解析，
 *   所以不用额外传 --import。）
 *
 * 产出目录：.workbuddy/tmp/print/（已在 .gitignore 里，不进仓库）
 *
 *   # 打印（Chrome 路径按自己机器改）
 *   for f in .workbuddy/tmp/print/*.html; do
 *     "<chrome>" --headless --disable-gpu --no-pdf-header-footer \
 *       --print-to-pdf="${f%.html}.pdf" "file://$(pwd)/$f"
 *   done
 *
 * ★★ 打印那一步**会静默失败**：Chrome 起不来时照样 exit 0、也不吐任何 stderr，
 *   只是没产出 PDF。所以跑完必须 `ls *.pdf` 看文件在不在、mtime 是不是刚才 ——
 *   只看退出码会拿到上一轮的旧 PDF，然后得出「页数还是对的」这种假绿结论。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// 源码按 bundler 约定写无扩展名 import，Node 的 ESM 解析要求显式后缀；
// 这个 hook 补上 .ts / .tsx，让下面的动态 import 能落地。
import '../tests/support/register.mjs';

const { buildInventory } = await import('../src/lib/inventory/model.ts');
const { renderInventoryHtml } = await import('../src/lib/inventory/html.ts');
const { INVENTORY_STYLE_ORDER, INVENTORY_STYLES, pageMetrics } = await import(
  '../src/lib/inventory/styles.ts'
);

const CATS = [
  '房产', '车辆', '贵金属', '数码', '家电', '服饰', '工具', '药品',
  '书籍', '厨房', '卫浴', '母婴', '宠物', '运动', '乐器', '收藏',
];
const CABINETS = ['客厅柜', '书房柜', '主卧衣柜', '储藏间', '阳台柜', '厨房吊柜', '书桌', '车库'];
const SLOTS = ['上层', '中层', '下层', '左抽屉', '右抽屉'];

// 固定种子：每次跑出同一份数据，改了排版才好比对
let seed = 20261017;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

/** @returns {import('../src/lib/types.ts').ItemView[]} */
function makeItems(n) {
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const cat = CATS[Math.floor(rnd() * CATS.length)];
    const hasLoc = rnd() > 0.12;
    const cab = hasLoc ? CABINETS[Math.floor(rnd() * CABINETS.length)] : null;
    const slot = hasLoc && rnd() > 0.3 ? SLOTS[Math.floor(rnd() * SLOTS.length)] : null;
    const style = i % 17;
    const name =
      style === 0
        ? '超长名称测试：西门子 iQ500 智能洗烘一体机 白色 10kg 带蒸汽除菌功能 含安装'
        : style === 1
          ? 'A<B & C>D 特殊字符'
          : style === 2
            ? `《万历十五年》增订纪念版（中华书局·精装）第 ${i} 册`
            : `${cat}用品 ${i}`;
    items.push({
      id: `id-${i}`,
      name,
      categoryName: cat,
      locationName: slot ?? cab,
      cabinetName: slot ? cab : null,
      purchaseDate:
        rnd() > 0.08
          ? `20${15 + Math.floor(rnd() * 10)}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`
          : null,
      price: rnd() > 0.17 ? Math.round(rnd() * 400000) / 100 : null,
      quantity: rnd() > 0.85 ? 1 + Math.floor(rnd() * 5) : null,
    });
  }
  return items;
}

const outDir = new URL('../.workbuddy/tmp/print/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const CASES = [
  ['one', 1], // 边界：只有一件
  ['small', 3],
  ['mid', 23], // 一页装不下，要翻页
  ['real', 137], // 典型家庭量级
  ['big', 400], // 大户/小店主
];

const generatedAt = new Date();
const rows = [];

for (const [label, n] of CASES) {
  const model = buildInventory(makeItems(n));
  for (const key of INVENTORY_STYLE_ORDER) {
    const r = renderInventoryHtml(model, key, { generatedAt });
    const file = new URL(`${label}-${key}.html`, outDir);
    writeFileSync(file, r.html, 'utf8');
    rows.push({
      样本: label,
      件数: model.totals.count,
      风格: key,
      每页行数: pageMetrics(INVENTORY_STYLES[key]).rowsPerPage,
      声明页数: r.pages,
    });
  }
}

console.table(rows);
console.log(`\n写好了 ${rows.length} 份 HTML → ${outDir.pathname}`);

/* ------------------------------------------------------------ 回读校验 */
/*
 * 加 `--check`：把同目录的 PDF 数一遍页，和 HTML 里印的「共 N 页」比对。
 * 这一步必须在**打印之后**单独跑，因为打印是外部命令、会静默失败（见文件头）。
 */
if (process.argv.includes('--check')) {
  const { countPdfPages } = await import('../src/lib/inventory/verify.ts');

  const bad = [];
  const report = [];
  for (const [label, n] of CASES) {
    for (const key of INVENTORY_STYLE_ORDER) {
      const htmlPath = new URL(`${label}-${key}.html`, outDir);
      const pdfPath = new URL(`${label}-${key}.pdf`, outDir);
      const declared = Number(
        (readFileSync(htmlPath, 'utf8').match(/共\s*(\d+)\s*页/) ?? [])[1],
      );
      let actual = 0;
      let note = '';
      try {
        actual = countPdfPages(new Uint8Array(readFileSync(pdfPath)));
      } catch {
        note = 'PDF 不在（还没打印，或那步静默失败了）';
      }
      const ok = actual > 0 && actual === declared;
      if (!ok) bad.push(`${label}-${key}`);
      report.push({
        样本: label,
        件数: n,
        风格: key,
        声明页数: declared,
        PDF页数: actual,
        结果: ok ? '一致' : note || '不一致',
      });
    }
  }

  console.table(report);
  if (bad.length > 0) {
    console.error(`\n✗ ${bad.length} 份对不上：${bad.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ ${report.length} 份全部一致：PDF 真实页数 = 册子里印的「共 N 页」`);
  }
}
