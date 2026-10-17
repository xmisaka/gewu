/**
 * 格物 · 财产清册 · HTML 模板
 *
 * 一份模板，三套样式（三套的差异全在 `styles.ts` 的 token 里）。
 *
 * ── 三条与打印引擎打交道的硬纪律 ──────────────────────────────
 * ① 每个单元格的内容必须包在 `<span class="c">` 里。少了它，长名字会折成两行，
 *    行高被撑开 → 实际能放的行数少于计划 → 多出来的行被 `overflow:hidden`
 *    **静默切掉**（2026-10-17 打样实测：34 行就吃满一页，而计划是 30 行）。
 *    `tests/inventory.test.mjs` 里有一条源码级断言专门守这件事：数 `<td>` 与 `class="c"`。
 * ② 页容器高度 296.5mm 而不是 297mm，末页不许 `break-after` —— 否则末尾多出空白页。
 * ③ 所有用户数据一律 `esc()`。物品名叫 `A<B`、备注里有 `&`，不转义会把后面整段吃掉，
 *    看起来只是「少了几行」。
 */

import { formatMoney } from '../format';
import type { InventoryModel } from './model';
import { buildDetailUnits, paginateDetails, type DetailUnit } from './paginate';
import {
  INVENTORY_STYLES,
  PAPER,
  extraPageCount,
  pageMetrics,
  type InventoryStyle,
  type InventoryStyleKey,
} from './styles';

export interface RenderOptions {
  /** 生成时刻，册子上的日期与文件名都用它 */
  generatedAt?: Date;
}

/** HTML 转义：`&` 必须第一个换，否则会把后面换出来的实体再转一遍 */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 金额：没记价格时给「—」，**绝不**用 0 顶替 —— 0 会看着像「这件不值钱」 */
export function moneyText(price: number | null): string {
  return price == null ? '—' : formatMoney(price);
}

function pctText(value: number, total: number): string {
  if (total <= 0) return '—';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function cnDate(d: Date): string {
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function dotDate(d: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/* ------------------------------------------------------------ 样式表 */

function fontStack(style: InventoryStyle): string {
  return style.family === 'serif'
    ? '"Noto Serif CJK SC","Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,serif'
    : '"Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif';
}

function buildCss(style: InventoryStyle, rowsPerPage: number): string {
  const { pad, header, thead, row } = style;
  const headRule =
    style.key === 'dossier'
      ? `border-bottom:2.2pt double ${style.rule}`
      : `border-bottom:.5pt solid ${style.rule}`;
  const rowRule = style.key === 'ledger' ? `.4pt solid ${style.rule}` : `.3pt solid ${style.rule}`;

  return `
@page{size:A4;margin:0}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{margin:0;padding:0;background:#FFFFFF /* theme-color-ok */}
body{
  font-family:${fontStack(style)};
  color:${style.ink};font-size:${style.fontSize}pt;
  -webkit-font-smoothing:antialiased;
}
.pg{
  position:relative;
  width:${PAPER.width}mm;height:${PAPER.height}mm;
  padding:${pad.top}mm ${pad.right}mm ${pad.bottom}mm ${pad.left}mm;
  overflow:hidden;
  break-after:page;page-break-after:always;
}
.pg:last-child{break-after:auto;page-break-after:auto}

/* 页眉：flex 居中，别用 line-height —— 两行文字会互相顶 */
.hd{
  display:flex;align-items:center;justify-content:space-between;
  height:${header}mm;${headRule};
  font-size:7.4pt;color:${style.ink2};letter-spacing:.04em;
  margin-bottom:2mm;
}
.hd .r{color:${style.accent}}

/* 页脚绝对定位，不占正文流高 */
.ft{
  position:absolute;left:${pad.left}mm;right:${pad.right}mm;bottom:${pad.bottom * 0.42}mm;
  display:flex;align-items:baseline;justify-content:space-between;
  font-size:7pt;color:${style.ink2};
}

table{width:100%;border-collapse:collapse;table-layout:fixed}
th{
  height:${thead}mm;line-height:${thead}mm;padding:0;
  font-size:7pt;font-weight:500;letter-spacing:.08em;color:${style.ink2};
  text-align:left;border-bottom:.5pt solid ${style.rule};
}
/* 相邻表头之间留一道缝：右对齐的「购置价」与下一个「序列号」会贴成一串 */
th:not(:first-child){padding-left:2mm}
th.r{padding-right:1.2mm}
td{height:${row}mm;line-height:${row}mm;padding:0;overflow:hidden;border-bottom:${rowRule}}
/* ★ 这一条是整册的命门：单行截断，见文件头第 ① 条 */
.c{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.r{text-align:right}
.num{font-variant-numeric:tabular-nums}

/* 分组标题行：与数据行等高（分页要把标题算成一行），靠底色与字重区分 */
.gh td{background:${style.tint};font-weight:600}
.gh .c{letter-spacing:.02em}
.gh .sub{color:${style.ink2};font-weight:400}

/* ×N：件数标记。放行首，避免被省略号吃掉 */
.q{display:inline-block;min-width:5.4mm;margin-right:1.2mm;padding:0 .8mm;
  background:${style.tint};color:${style.accent};font-size:7.2pt;text-align:center}
.no{color:${style.ink2}}

/* 封面 */
.cv{padding-top:6mm}
.cv-eyebrow{font-size:8pt;letter-spacing:.28em;color:${style.ink2}}
.cv-title{font-size:26pt;font-weight:500;letter-spacing:.1em;margin:6mm 0 0}
.cv-sub{margin-top:3mm;font-size:9pt;color:${style.ink2};letter-spacing:.04em}
.cv-rule{margin:7mm 0 8mm;border-top:1.4pt solid ${style.rule}}
.cv-metrics{display:flex;gap:0;margin-bottom:9mm}
.cv-metrics > div{flex:1;border-left:.5pt solid ${style.rule};padding-left:5mm}
.cv-metrics > div:first-child{border-left:0;padding-left:0}
.cv-metrics b{display:block;font-size:17pt;font-weight:500;line-height:1.3}
.cv-metrics span{font-size:7.6pt;color:${style.ink2};letter-spacing:.08em}
.cv-cats{margin-top:2mm}
.cv-note{margin-top:9mm;padding-top:4mm;border-top:.5pt solid ${style.rule};
  font-size:8pt;line-height:1.9;color:${style.ink2}}
.cv-note b{color:${style.ink};font-weight:600}
.cv-note p{margin:0 0 1.6mm}

/* 末页：标题 / 说明 / 表格 / 签署 */
.sec-t{font-size:13pt;font-weight:500;letter-spacing:.12em;margin:4mm 0 3mm;
  padding-bottom:2mm;border-bottom:.8pt solid ${style.rule}}
.lede{font-size:8pt;line-height:1.85;color:${style.ink2};margin:0 0 4mm}
.sign{margin-top:12mm;font-size:8.4pt;color:${style.ink2}}
.sign-row{display:flex;align-items:baseline;gap:2mm;margin-bottom:11mm}
.sign-row span{width:16mm;color:${style.ink}}
.sign-row i{flex:1;border-bottom:.4pt solid ${style.rule};height:5mm}
.sign-row em{font-style:normal;width:8mm}
.sign-foot{font-size:7.4pt;color:${style.ink2};line-height:1.8;margin-top:6mm}

/* 留白填写行（账簿的登记页 / 活页的应急联）：横线是给人写的 */
.fill-row{display:flex;align-items:baseline;gap:3mm;height:15mm;
  border-bottom:.4pt solid ${style.rule};font-size:8.4pt}
.fill-row span{width:38mm;color:${style.ink2}}
.fill-row i{flex:1;height:1px}
/* 朱印：账簿版封面那一方「格物」。不用图片 —— 打印时图片要额外解码，
   一枚纯 CSS 的方印在任何 ROM 上都不会缺失 */
.seal{
  position:absolute;right:${pad.right}mm;top:${pad.top + 6}mm;width:21mm;height:21mm;
  border:1pt solid ${style.seal};color:${style.seal};
  display:flex;align-items:center;justify-content:center;
  font-size:9.5pt;letter-spacing:.22em;text-indent:.22em;
  border-radius:1.6mm;transform:rotate(-3deg);opacity:.88;
}
${style.key === 'binder' ? `.bind{position:absolute;left:6.4mm;top:0;bottom:0;width:6mm}
.bind i{position:absolute;left:0;width:3.4mm;height:3.4mm;border:.4pt solid ${style.rule};border-radius:50%}
.bind i:nth-child(1){top:26%}.bind i:nth-child(2){top:50%}.bind i:nth-child(3){top:74%}` : ''}
/* 每页行数：${rowsPerPage}（仅注释用，实际分页在 paginate.ts） */
`.trim();
}

/* ------------------------------------------------------------ 片段 */

function wrapPage(
  body: string,
  options: {
    style: InventoryStyle;
    pageNo: number;
    total: number;
    headerLeft?: string;
    headerRight?: string;
    footerLeft: string;
    footerRight: string;
  },
): string {
  const { style, pageNo, total } = options;
  const bind = style.key === 'binder' ? '<div class="bind"><i></i><i></i><i></i></div>' : '';
  const head = options.headerLeft
    ? `<div class="hd"><span>${esc(options.headerLeft)}</span><span class="r">${esc(
        options.headerRight ?? '',
      )}</span></div>`
    : '';
  return (
    `<div class="pg">${bind}${head}${body}` +
    `<div class="ft"><span>${esc(options.footerLeft)}</span><span>${esc(
      options.footerRight || `第 ${pageNo} 页 / 共 ${total} 页`,
    )}</span></div></div>`
  );
}

function coverBody(model: InventoryModel, style: InventoryStyle, now: Date): string {
  // 分类表封顶 12 行：再多的分类一律并成「其余 N 类」。
  // 封面高度是固定的，分类条数不封顶 → 分类一多，说明段被顶出页外（且不报错）。
  const TOP = 12;
  const shown = model.sections.slice(0, TOP);
  const rest = model.sections.slice(TOP);
  const restCount = rest.reduce((s, x) => s + x.count, 0);
  const restValue = rest.reduce((s, x) => s + x.value, 0);

  const rows = shown
    .map(
      (s) =>
        `<tr><td><span class="c">${esc(s.name)}</span></td>` +
        `<td class="r num"><span class="c">${s.count}</span></td>` +
        `<td class="r num"><span class="c">${moneyText(s.value)}</span></td>` +
        `<td class="r num"><span class="c">${pctText(s.value, model.totals.value)}</span></td></tr>`,
    )
    .join('');

  const restRow =
    rest.length > 0
      ? `<tr><td><span class="c">其余 ${rest.length} 类</span></td>` +
        `<td class="r num"><span class="c">${restCount}</span></td>` +
        `<td class="r num"><span class="c">${moneyText(restValue)}</span></td>` +
        `<td class="r num"><span class="c">${pctText(restValue, model.totals.value)}</span></td></tr>`
      : '';

  const seal = style.key === 'ledger' ? '<div class="seal">格物</div>' : '';

  return `
<div class="cv">
  <div class="cv-eyebrow">格物 · 家庭财产清册</div>
  <h1 class="cv-title">家庭财产清册</h1>
  <div class="cv-sub">共 ${model.totals.count} 件 · ${model.sections.length} 个分类 · ${cnDate(now)}</div>
  <div class="cv-rule"></div>
  <div class="cv-metrics">
    <div><b>${model.totals.count}</b><span>件物品</span></div>
    <div><b>${model.sections.length}</b><span>个分类</span></div>
    <div><b>${moneyText(model.totals.value)}</b><span>购置价合计</span></div>
  </div>
  <table class="cv-cats">
    <colgroup><col><col style="width:18mm"><col style="width:28mm"><col style="width:18mm"></colgroup>
    <thead><tr><th>分类</th><th class="r">件数</th><th class="r">购置价</th><th class="r">占比</th></tr></thead>
    <tbody>${rows}${restRow}</tbody>
  </table>
  <div class="cv-note">
    <p><b>口径。</b>金额为<b>购置价合计，不是现值</b>——本册不估算折旧，也不替代保险公司的核定。</p>
    <p>${model.totals.count} 件中 <b>${model.totals.pricedCount} 件</b>记了价格，另有 <b>${
      model.totals.unpriced
    } 件</b>未记价格，未计入合计。</p>
    <p>数量大于 1 者按单件价计，行首以 ×N 标出。回收站中的物品不计入本册。</p>
    <p>位置写到柜子与格位。本册由格物在这台手机上生成，未上传任何数据。</p>
  </div>
  ${seal}
</div>`;
}

function detailBody(units: readonly DetailUnit[], style: InventoryStyle): string {
  const body = units
    .map((unit) => {
      if (unit.kind === 'group') {
        const s = unit.section;
        return (
          `<tr class="gh"><td colspan="6"><span class="c">${esc(s.name)}` +
          `<span class="sub">　${s.count} 件 · ${moneyText(s.value)}</span></span></td></tr>`
        );
      }
      const e = unit.entry;
      const q = e.quantity != null ? `<span class="q">×${e.quantity}</span>` : '';
      return (
        `<tr>` +
        `<td><span class="c no">${pad2(e.no)}</span></td>` +
        `<td><span class="c">${q}${esc(e.name)}</span></td>` +
        `<td><span class="c">${esc(e.category)}</span></td>` +
        `<td><span class="c">${esc(e.location)}</span></td>` +
        `<td><span class="c num">${esc(e.purchase)}</span></td>` +
        `<td class="r"><span class="c num">${moneyText(e.price)}</span></td>` +
        `</tr>`
      );
    })
    .join('');

  return `
<table class="dt">
  <colgroup>
    <col style="width:11mm"><col><col style="width:16mm">
    <col style="width:32mm"><col style="width:15mm"><col style="width:22mm">
  </colgroup>
  <thead><tr>
    <th>编号</th><th>名称</th><th>分类</th><th>位置</th><th>购入</th><th class="r">购置价</th>
  </tr></thead>
  <tbody>${body}</tbody>
</table>`;
}

function sectionTable(model: InventoryModel, title: string): string {
  const rows = model.sections
    .map(
      (s) =>
        `<tr><td><span class="c">${esc(s.name)}</span></td>` +
        `<td class="r num"><span class="c">${s.count}</span></td>` +
        `<td class="r num"><span class="c">${s.pricedCount}</span></td>` +
        `<td class="r num"><span class="c">${moneyText(s.value)}</span></td>` +
        `<td class="r num"><span class="c">${pctText(s.value, model.totals.value)}</span></td></tr>`,
    )
    .join('');
  return `
<div class="sec-t">${esc(title)}</div>
<table>
  <colgroup><col><col style="width:16mm"><col style="width:16mm"><col style="width:26mm"><col style="width:16mm"></colgroup>
  <thead><tr><th>分类</th><th class="r">件数</th><th class="r">有价</th><th class="r">购置价</th><th class="r">占比</th></tr></thead>
  <tbody>${rows}
    <tr class="gh"><td><span class="c">合计</span></td>
      <td class="r num"><span class="c">${model.totals.count}</span></td>
      <td class="r num"><span class="c">${model.totals.pricedCount}</span></td>
      <td class="r num"><span class="c">${moneyText(model.totals.value)}</span></td>
      <td class="r num"><span class="c">${pctText(model.totals.value, model.totals.value)}</span></td></tr>
  </tbody>
</table>`;
}

/** 卷宗：归类合计 + 口径 + 签署栏 */
function signatureBody(model: InventoryModel, style: InventoryStyle, now: Date): string {
  return `
${sectionTable(model, '归 类 合 计')}
<p class="lede" style="margin-top:6mm">
  本册所列金额为<b>购置价</b>，非现值；${model.totals.count} 件中 ${
    model.totals.pricedCount
  } 件记有价格，
  其余 ${model.totals.unpriced} 件未计入合计。数量大于 1 的行按单件价计。
  位置只写到柜子与格位，不含任何账号、证件与密码。
</p>
<div class="sign">
  <div class="sign-row"><span>制表人</span><i></i><em>日期</em><i style="flex:.6"></i></div>
  <div class="sign-row"><span>核对人</span><i></i><em>日期</em><i style="flex:.6"></i></div>
</div>
<div class="sign-foot">
  制表：格物 · ${dotDate(now)}　|　共 ${model.totals.count} 件<br>
  复核时请以本页合计与本金册明细逐类对账；若当日有新增或处置，请在「异动录」页面登记。
</div>`;
}

/** 账簿：高价值品登记（序列号 / 保单号留白手填） */
function registerBody(model: InventoryModel): string {
  const rows = model.highValue
    .map(
      (e) =>
        `<tr><td><span class="c no">${pad2(e.no)}</span></td>` +
        `<td><span class="c">${esc(e.name)}</span></td>` +
        `<td class="r"><span class="c num">${moneyText(e.price)}</span></td>` +
        `<td><span class="c"></span></td></tr>`,
    )
    .join('');
  // 补足到 18 行：账簿一页的行区约能放 19 行，写死 10 行会让下半页空着 ——
  // 而这页本来就是「还有空位让人继续写」的，空着等于白印
  const blanks = Math.max(0, 18 - model.highValue.length);
  const blankRows = Array.from(
    { length: blanks },
    () => `<tr><td><span class="c"></span></td><td><span class="c"></span></td><td><span class="c"></span></td><td><span class="c"></span></td></tr>`,
  ).join('');

  return `
<div class="sec-t">高 价 值 品 登 记</div>
<p class="lede">
  下列按购置价取前 ${Math.min(8, model.highValue.length)} 件。序列号与保单号<b>不在格物里</b>，
  也不该随手存在手机里——请用笔补在留白处，并把这一页单独复印一份与保单放在一起。
</p>
<table>
  <colgroup><col style="width:12mm"><col><col style="width:26mm"><col style="width:52mm"></colgroup>
  <thead><tr><th>编号</th><th>名称</th><th class="r">购置价</th><th>序列号 / 保单号</th></tr></thead>
  <tbody>${rows}${blankRows}</tbody>
</table>`;
}

/** 账簿：异动录（手写登记后续变化） */
function changesBody(): string {
  const blanks = Array.from(
    { length: 18 },
    () =>
      `<tr><td><span class="c"></span></td><td><span class="c"></span></td>` +
      `<td><span class="c"></span></td><td><span class="c"></span></td></tr>`,
  ).join('');
  return `
<div class="sec-t">异 动 录</div>
<p class="lede">
  新买、卖出、赠送、报废都记在这里。下一次重新生成本册时，先照这一页对账，
  再决定哪些行要改——比翻遍整本找不同快得多。
</p>
<table>
  <colgroup><col style="width:24mm"><col><col style="width:24mm"><col style="width:22mm"></colgroup>
  <thead><tr><th>日期</th><th>事项</th><th>增减金额</th><th>经手</th></tr></thead>
  <tbody>${blanks}</tbody>
</table>`;
}

/** 活页：按存放位置汇总 */
function locationsBody(model: InventoryModel): string {
  const TOP = 30;
  const shown = model.locations.slice(0, TOP);
  const rest = model.locations.slice(TOP);
  const restCount = rest.reduce((s, x) => s + x.count, 0);
  const restValue = rest.reduce((s, x) => s + x.value, 0);

  const rows = shown
    .map(
      (l) =>
        `<tr><td><span class="c">${esc(l.name)}</span></td>` +
        `<td class="r num"><span class="c">${l.count}</span></td>` +
        `<td class="r num"><span class="c">${moneyText(l.value)}</span></td>` +
        `<td class="r num"><span class="c">${pctText(l.value, model.totals.value)}</span></td></tr>`,
    )
    .join('');
  const restRow =
    rest.length > 0
      ? `<tr><td><span class="c">其余 ${rest.length} 个位置</span></td>` +
        `<td class="r num"><span class="c">${restCount}</span></td>` +
        `<td class="r num"><span class="c">${moneyText(restValue)}</span></td>` +
        `<td class="r num"><span class="c">${pctText(restValue, model.totals.value)}</span></td></tr>`
      : '';

  return `
<div class="sec-t">按 存 放 位 置 汇 总</div>
<p class="lede">
  这张表回答的不是「我有什么」，而是「东西在哪」。清点与投保时，按位置看比按类别看快；
  也能一眼看出价值集中在哪个柜子——那也是火灾与失窃时最该先清点的位置。
</p>
<table>
  <colgroup><col><col style="width:18mm"><col style="width:28mm"><col style="width:18mm"></colgroup>
  <thead><tr><th>位置</th><th class="r">件数</th><th class="r">购置价</th><th class="r">占比</th></tr></thead>
  <tbody>${rows}${restRow}
    <tr class="gh"><td><span class="c">合计</span></td>
      <td class="r num"><span class="c">${model.totals.count}</span></td>
      <td class="r num"><span class="c">${moneyText(model.totals.value)}</span></td>
      <td class="r num"><span class="c">${pctText(model.totals.value, model.totals.value)}</span></td></tr>
  </tbody>
</table>`;
}

/** 活页：应急联（手填保单 / 电话 / 钥匙位置） */
function emergencyBody(model: InventoryModel, now: Date): string {
  const fields = [
    '保险公司',
    '保单号',
    '报案电话',
    '房屋地址',
    '物业与门禁',
    '紧急联系人',
    '备用钥匙位置',
    '重要证件存放处',
  ];
  const rows = fields
    .map((f) => `<div class="fill-row"><span>${esc(f)}</span><i></i></div>`)
    .join('');
  // 剩下三行留给「备注」：出事时最容易被想起的往往是上面列不进去的那条
  const spare = Array.from(
    { length: 3 },
    () => `<div class="fill-row"><span></span><i></i></div>`,
  ).join('');
  return `
<div class="sec-t">应 急 联</div>
<p class="lede">
  出事时只抽这一页。格物里不存保单号与电话——那类信息不该跟着一个 App 走。
  请在此手填，并单独复印一份随身带上。
</p>
${rows}${spare}
<div class="sign-foot" style="margin-top:10mm">
  本册 ${model.totals.count} 件 · 购置价合计 ${moneyText(model.totals.value)} · 生成于 ${dotDate(now)}<br>
  若已投保，请按保单上的「重置价值」另行核定，本册金额不作申报依据。
</div>`;
}

/* ------------------------------------------------------------ 入口 */

export interface InventoryRender {
  html: string;
  /** 预期页数（自己算的，不是 printToFileAsync 的估算） */
  pages: number;
  rowsPerPage: number;
}

export function renderInventoryHtml(
  model: InventoryModel,
  styleKey: InventoryStyleKey,
  options: RenderOptions = {},
): InventoryRender {
  const style = INVENTORY_STYLES[styleKey];
  const now = options.generatedAt ?? new Date();
  const metrics = pageMetrics(style);
  const detailPages = paginateDetails(buildDetailUnits(model), metrics.rowsPerPage);

  const bodies: string[] = [];
  const kinds: ('cover' | 'detail' | 'extra')[] = [];

  bodies.push(coverBody(model, style, now));
  kinds.push('cover');

  for (const page of detailPages) {
    bodies.push(detailBody(page, style));
    kinds.push('detail');
  }

  const extra: string[] = [];
  if (style.extra === 'signature') {
    extra.push(signatureBody(model, style, now));
  } else if (style.extra === 'register') {
    extra.push(registerBody(model), changesBody());
  } else {
    extra.push(locationsBody(model), emergencyBody(model, now));
  }
  for (const body of extra) {
    bodies.push(body);
    kinds.push('extra');
  }

  const total = bodies.length;
  // 页数必须与常量表里的预期一致：多一页少一页都说明 extraPageCount 与上面的分支对不上
  const expected = 1 + detailPages.length + extraPageCount(style);
  if (total !== expected) {
    throw new Error(`清册页数不自洽：实际 ${total}，预期 ${expected}`);
  }

  const pagesHtml = bodies.map((body, index) => {
    const kind = kinds[index];
    const pageNo = index + 1;
    if (kind === 'cover') {
      return wrapPage(body, {
        style,
        pageNo,
        total,
        footerLeft: `格物 · ${dotDate(now)}`,
        // 封面也编号：这本册子要交出去、要归档，少一张封面时得要看得出来
        footerRight: `第 ${pageNo} 页 / 共 ${total} 页`,
      });
    }
    return wrapPage(body, {
      style,
      pageNo,
      total,
      headerLeft: '家庭财产清册',
      headerRight: `${style.name} · ${dotDate(now)}`,
      footerLeft: '格物 · 家庭财产清册',
      footerRight: `第 ${pageNo} 页 / 共 ${total} 页`,
    });
  });

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>格物 · 家庭财产清册</title>
<style>${buildCss(style, metrics.rowsPerPage)}</style>
</head><body>${pagesHtml.join('')}</body></html>`;

  return { html, pages: total, rowsPerPage: metrics.rowsPerPage };
}
