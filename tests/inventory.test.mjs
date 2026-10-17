/**
 * 家庭财产清册 · 纯逻辑守护
 *
 * 这个功能里「不报错但错」的地方比会报错的多得多，所以断言都盯具体数字：
 *   · 合计口径与首页 / 我的 / 统计不一致 → 用户看到两个数，从此不信任何数字；
 *   · 少了一行 `<span class="c">` → 长名字折行、行高被撑开、最后几行被静默裁掉；
 *   · 分组标题落在页末 → 标题与它的条目被拆到两页；
 *   · 册子里出现「估值」二字 → 那是我编样例时用的词，写错数字比没有数字更危险。
 *
 * 最后一条是源码级断言：`export.ts` 必须用 `listItems()`（过掉回收站），
 * 不能用 `listAllForExport()`（那个没有 deleted_at 过滤，备份要用它、导出不该用）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { buildInventory, formatPurchaseDate } = await import('../src/lib/inventory/model.ts');
const { buildDetailUnits, paginateDetails, totalPagesOf } = await import(
  '../src/lib/inventory/paginate.ts'
);
const { renderInventoryHtml, esc, moneyText } = await import('../src/lib/inventory/html.ts');
const { INVENTORY_STYLES, INVENTORY_STYLE_ORDER, pageMetrics, extraPageCount, PRINT_SIZE } =
  await import('../src/lib/inventory/styles.ts');
const { countPdfPages } = await import('../src/lib/inventory/verify.ts');
const { bookletBaseName, isBookletFile, BOOKLET_PREFIX } = await import(
  '../src/lib/inventory/naming.ts'
);
const { FAILURE_TEXT, classifyFailure, toFailure } = await import(
  '../src/lib/inventory/failure.ts'
);
const { summarize } = await import('../src/lib/stats.ts');

/* ------------------------------------------------------------ 夹具 */

/** 只带 buildInventory 用到的字段；运行时不需要完整 ItemView */
function item(over) {
  return {
    id: over.id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
    name: '无名',
    categoryName: null,
    locationName: null,
    cabinetName: null,
    purchaseDate: null,
    price: null,
    quantity: null,
    ...over,
  };
}

const FIXTURE = [
  item({
    id: 'a1',
    name: '住宅 阳光里 3-2-601',
    categoryName: '房产',
    locationName: '客厅',
    cabinetName: '客厅柜',
    purchaseDate: '2019-05-18',
    price: 1_860_000,
  }),
  item({
    id: 'a2',
    name: '车位 B-127',
    categoryName: '房产',
    locationName: null,
    cabinetName: null,
    purchaseDate: '2020-01-06',
    price: 120_000,
  }),
  item({
    id: 'b1',
    name: 'MacBook Pro 14 M3',
    categoryName: '数码',
    locationName: '书房',
    cabinetName: '书房柜',
    purchaseDate: '2023-11-02',
    price: 15_999,
  }),
  item({
    id: 'b2',
    name: '数据线',
    categoryName: '数码',
    locationName: '抽屉',
    cabinetName: '书桌',
    purchaseDate: '2024-03-01',
    price: 129,
    quantity: 3,
  }),
  item({ id: 'c1', name: '一本没记价的书', categoryName: '杂项' }),
  item({ id: 'c2', name: '另一本没记价的书', categoryName: null, price: null }),
];

/* ------------------------------------------------------------ 金额口径 */

test('合计与 stats.summarize() 逐字同源 —— 清册不能自己另算一套', () => {
  const model = buildInventory(FIXTURE);
  const summary = summarize(FIXTURE);
  assert.equal(model.totals.value, summary.totalValue);
  assert.equal(model.totals.pricedCount, summary.pricedCount);
  assert.equal(model.totals.value, 1_996_128);
});

test('数量大于 1 不乘进合计，只标 ×N', () => {
  const model = buildInventory(FIXTURE);
  // 数据线 129 × 3 = 387；若乘进去，合计会变成 1_996_386
  assert.equal(model.totals.value, 1_996_128);
  const cable = model.entries.find((e) => e.name === '数据线');
  assert.equal(cable.quantity, 3);
  // 单件物品不挂 ×1
  const mac = model.entries.find((e) => e.name === 'MacBook Pro 14 M3');
  assert.equal(mac.quantity, null);
});

test('没记价格的件数单独算出来，且不进合计', () => {
  const model = buildInventory(FIXTURE);
  assert.equal(model.totals.count, 6);
  assert.equal(model.totals.pricedCount, 4);
  assert.equal(model.totals.unpriced, 2);
});

test('分类按价值降序，组内按价格降序、无价沉底', () => {
  const model = buildInventory(FIXTURE);
  const names = model.sections.map((s) => s.name);
  // 前两名按价值排；「杂项」与「未分类」都是 0 元，谁先谁后由拼音定，
  // 这里只钉住「它们在后面」这一件事，别把 tie 的规则写死进断言
  assert.deepEqual(names.slice(0, 2), ['房产', '数码']);
  assert.deepEqual(new Set(names), new Set(['房产', '数码', '杂项', '未分类']));
  const digital = model.entries.filter((e) => e.category === '数码').map((e) => e.name);
  assert.deepEqual(digital, ['MacBook Pro 14 M3', '数据线']);
});

test('编号按打印顺序连续，1..N 一个不跳', () => {
  const model = buildInventory(FIXTURE);
  assert.deepEqual(
    model.entries.map((e) => e.no),
    [1, 2, 3, 4, 5, 6],
  );
  // 编号顺序必须与**打印顺序**一致（分组按价值排序后 1..N 不能跳）
  const printed = buildDetailUnits(model)
    .filter((u) => u.kind === 'item')
    .map((u) => u.entry.no);
  assert.deepEqual(printed, [1, 2, 3, 4, 5, 6]);
});

/* ------------------------------------------------------------ 位置 */

test('位置拼成「柜 › 格」，位置本身就是柜子时只给柜名', () => {
  const model = buildInventory(FIXTURE);
  const byName = new Map(model.entries.map((e) => [e.name, e]));
  assert.equal(byName.get('MacBook Pro 14 M3').location, '书房柜 › 书房');
  assert.equal(byName.get('MacBook Pro 14 M3').cabinet, '书房柜');
  assert.equal(byName.get('住宅 阳光里 3-2-601').location, '客厅柜 › 客厅');
  assert.equal(byName.get('车位 B-127').location, '—');
});

test('位置汇总把没有位置的东西归到「未指定位置」，且排最后', () => {
  const model = buildInventory(FIXTURE);
  const last = model.locations[model.locations.length - 1];
  assert.equal(last.name, '未指定位置');
  // 车位、两本没记价的书：都没有位置
  assert.equal(last.count, 3);
  assert.equal(model.locations[0].name, '客厅柜');
});

test('购入日期收成 年月，空值给「—」', () => {
  assert.equal(formatPurchaseDate('2019-05-18'), '2019.05');
  assert.equal(formatPurchaseDate(null), '—');
});

/* ------------------------------------------------------------ 分页 */

test('分组标题绝不落在页末 —— 否则标题与条目被拆到两页', () => {
  // 造 40 件、每 10 件一个分类：rowsPerPage=6 时标题一定会被挤到页底
  const many = [];
  for (let g = 0; g < 4; g += 1) {
    for (let i = 0; i < 10; i += 1) {
      many.push(item({ name: `物品 ${g}-${i}`, categoryName: `类 ${g}`, price: 100 - i }));
    }
  }
  const model = buildInventory(many);
  const pages = paginateDetails(buildDetailUnits(model), 6);
  for (const [index, page] of pages.entries()) {
    const last = page[page.length - 1];
    if (!last) continue;
    assert.equal(
      last.kind,
      'item',
      `第 ${index + 1} 页的最后一行是分组标题（${last.section?.name}），会被拆到下一页`,
    );
  }
});

test('分页不丢行：所有条目恰好出现一次', () => {
  const many = [];
  for (let i = 0; i < 57; i += 1) {
    many.push(item({ name: `物品 ${i}`, categoryName: i % 3 === 0 ? '甲' : '乙', price: i }));
  }
  const model = buildInventory(many);
  const units = buildDetailUnits(model);
  const pages = paginateDetails(units, 9);
  const flat = pages.flat();
  assert.equal(flat.length, units.length);
  assert.equal(flat.filter((u) => u.kind === 'item').length, 57);
  // 每页都不超容
  for (const page of pages) assert.ok(page.length <= 9);
});

test('三套样式：整册页数 = 封面 1 + 明细 + 附页', () => {
  const model = buildInventory(FIXTURE);
  for (const key of INVENTORY_STYLE_ORDER) {
    const style = INVENTORY_STYLES[key];
    const metrics = pageMetrics(style);
    const detail = paginateDetails(buildDetailUnits(model), metrics.rowsPerPage).length;
    const expected = totalPagesOf(detail, extraPageCount(style));
    const rendered = renderInventoryHtml(model, key, {
      generatedAt: new Date('2026-10-17T10:00:00+08:00'),
    });
    assert.equal(rendered.pages, expected, `${key} 的页数对不上`);
    // 页容器数量必须与页数一致：多一个容器 = 多一张空白纸
    const containers = rendered.html.match(/<div class="pg">/g) ?? [];
    assert.equal(containers.length, expected, `${key} 的页容器数量对不上`);
  }
});

test('每页行数落在合理区间：卷宗 28~31、账簿 18~21、活页 34~37', () => {
  assert.ok(pageMetrics(INVENTORY_STYLES.dossier).rowsPerPage >= 28);
  assert.ok(pageMetrics(INVENTORY_STYLES.dossier).rowsPerPage <= 31);
  assert.ok(pageMetrics(INVENTORY_STYLES.ledger).rowsPerPage >= 18);
  assert.ok(pageMetrics(INVENTORY_STYLES.ledger).rowsPerPage <= 21);
  assert.ok(pageMetrics(INVENTORY_STYLES.binder).rowsPerPage >= 34);
  assert.ok(pageMetrics(INVENTORY_STYLES.binder).rowsPerPage <= 37);
});

test('印花页尺寸是 A4（595×842），不是 Letter（612×792）', () => {
  assert.deepEqual(PRINT_SIZE, { width: 595, height: 842 });
});

/* ------------------------------------------------------------ 产物内容 */

test('转义：名字里的尖括号不能破坏整页结构', () => {
  const nasty = buildInventory([
    item({ name: '</td></tr><script>alert(1)</script>', categoryName: 'x', price: 1 }),
  ]);
  const { html } = renderInventoryHtml(nasty, 'dossier');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;/td&gt;'));
  assert.equal(esc(`a&b<c>"d"'e`), 'a&amp;b&lt;c&gt;&quot;d&quot;&#39;e');
});

test('每个单元格的内容都包在 class="c" 里 —— 少了它长名字会折行、行被静默裁掉', () => {
  const model = buildInventory(FIXTURE);
  for (const key of INVENTORY_STYLE_ORDER) {
    const { html } = renderInventoryHtml(model, key, {
      generatedAt: new Date('2026-10-17T10:00:00+08:00'),
    });
    const cells = html.match(/<td[ >]/g) ?? [];
    const clipped = html.match(/class="c[ "]/g) ?? [];
    assert.ok(cells.length > 0, `${key} 里一个单元格都没有？`);
    assert.equal(clipped.length, cells.length, `${key} 有单元格没包 class="c"`);
  }
});

test('页脚有页码，且「共 N 页」就是算出来的那一版', () => {
  const model = buildInventory(FIXTURE);
  const { html, pages } = renderInventoryHtml(model, 'dossier', {
    generatedAt: new Date('2026-10-17T10:00:00+08:00'),
  });
  assert.ok(html.includes(`第 2 页 / 共 ${pages} 页`));
  assert.ok(html.includes('第 1 页 / 共'), '封面也要有页码 — 否则抽走一页看不出来');
});

test('册子上不出现「估值」二字：金额只有购置价一种口径', () => {
  const model = buildInventory(FIXTURE);
  for (const key of INVENTORY_STYLE_ORDER) {
    const { html } = renderInventoryHtml(model, key, {
      generatedAt: new Date('2026-10-17T10:00:00+08:00'),
    });
    assert.ok(!html.includes('估值'), `${key} 里出现了「估值」`);
    assert.ok(html.includes('购置价'), `${key} 缺少「购置价」口径说明`);
  }
});

test('缺价格的件数写进了封面，不是只藏在代码里', () => {
  const model = buildInventory(FIXTURE);
  const { html } = renderInventoryHtml(model, 'dossier', {
    generatedAt: new Date('2026-10-17T10:00:00+08:00'),
  });
  assert.ok(html.includes('4 件'));
  assert.ok(html.includes('2 件'));
  assert.ok(html.includes('未记价格'), '封面必须写明有几件没记价格');
});

test('没记价格的格子显示「—」，不显示 0', () => {
  assert.equal(moneyText(null), '—');
  assert.equal(moneyText(1200), '¥1,200');
});

test('分类超过 12 个时封面收成「其余 N 类」，不把说明段顶出页外', () => {
  const many = [];
  for (let i = 0; i < 20; i += 1) {
    many.push(item({ name: `物 ${i}`, categoryName: `类 ${String(i).padStart(2, '0')}`, price: 1000 - i }));
  }
  const model = buildInventory(many);
  const { html } = renderInventoryHtml(model, 'dossier', {
    generatedAt: new Date('2026-10-17T10:00:00+08:00'),
  });
  assert.ok(html.includes('其余 8 类'));
});

/* ------------------------------------------------------------ PDF 自检 */

test('数 PDF 页数：排除 /Type /Pages 这个目录节点', () => {
  const bytes = new Uint8Array(
    Buffer.from('/Type /Pages /Kids[1 0 R] >> /Type /Page >> /Type\n/Page >>', 'latin1'),
  );
  assert.equal(countPdfPages(bytes), 2);
  assert.equal(countPdfPages(new Uint8Array(Buffer.from('/Type /Page', 'latin1'))), 1);
  assert.equal(countPdfPages(new Uint8Array(0)), 0);
});

/* ------------------------------------------------------------ 取数口径 */

test('清册取数必须用 listItems()，不许走 listAllForExport()', () => {
  const raw = readFileSync(new URL('../src/lib/inventory/export.ts', import.meta.url), 'utf8');
  // 注释里提到名字是对的（要解释为什么不许用），断言只看**代码**
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(source.includes('listItems('), '清册应使用 listItems()');
  assert.ok(
    !source.includes('listAllForExport'),
    'listAllForExport() 没有 deleted_at 过滤，会把回收站里的东西印进册子',
  );
});

/* ------------------------------------------------------------ 两个出口 */

/** 去掉注释再搜：注释里会解释「为什么不用 X」，全文匹配会误伤自己 */
function code(file) {
  return readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('★ 不做「直接打印」：两个出口都只是把文件交出去', () => {
  const exp = code('lib/inventory/export.ts');
  assert.ok(
    !exp.includes('printAsync'),
    '不该调 Print.printAsync —— 页边距交给打印机驱动决定，我们算的每页行数会装不下',
  );
  assert.ok(exp.includes('shareInventoryPdf(') && exp.includes('shareInventoryHtml('));

  const sheet = code('components/domain/InventorySheet.tsx');
  assert.ok(!sheet.includes('直接打印'), '第二个出口应是「发送 HTML」，不是打印');
  assert.ok(!sheet.includes('printInventory'), '不该 import 打印函数');
});

test('★★ 交出去的 HTML 必须是「一个文件」：不许图片、外链样式、外链字体', () => {
  const model = buildInventory(FIXTURE);
  for (const key of INVENTORY_STYLE_ORDER) {
    const { html } = renderInventoryHtml(model, key, {
      generatedAt: new Date('2026-10-17T20:00:00+08:00'),
    });
    assert.ok(!/<img\b/i.test(html), `${key}：不能引用图片`);
    assert.ok(!/\ssrc=/i.test(html), `${key}：不能有 src=`);
    assert.ok(!/url\(/i.test(html), `${key}：不能有 url(...)`);
    assert.ok(!/https?:\/\//i.test(html), `${key}：不能有 http(s) 外链`);
    // 本地 .html 没有 HTTP 头，字符集只能靠 meta；漏了中文系统的浏览器会按 GBK 猜 → 满屏乱码
    assert.ok(/<meta charset="utf-8">/i.test(html), `${key}：必须自己声明 utf-8`);
  }
});

test('★ 两个出口的 mimeType 都要写死 —— 猜错会让收件方打开是一坨源码', () => {
  const exp = code('lib/inventory/export.ts');
  assert.ok(exp.includes("'application/pdf'"));
  assert.ok(exp.includes("'text/html'"), 'HTML 必须显式 text/html，不许省');
  assert.ok(
    exp.includes('`${base}.pdf`') && exp.includes('`${base}.html`'),
    '两个文件必须是同一个时间戳主干 + 各自的扩展名',
  );
});

/* ------------------------------------------------- 2026-10-17 真机故障回归 */

test('★★★ 改名必须走 move(overwrite)，不许用 rename(name)', () => {
  const exp = code('lib/inventory/export.ts');
  assert.ok(
    !/\.rename\(/.test(exp),
    'rename(name) 把新名字拼到**源文件所在目录**（cache/Print），不是 cache 根 —— 同一分钟第二次就撞名',
  );
  assert.ok(
    /move\(\s*pdf\s*,\s*\{\s*overwrite:\s*true\s*\}\s*\)/.test(exp),
    '必须显式 move 到我们构造的目标，并带 overwrite',
  );
  // 交出去的四个值必须来自 move 之后**同一个对象**，而不是另外 new 出来的路径
  assert.ok(exp.includes('uri: pdf.uri') && exp.includes('htmlUri: html.uri'));
  assert.ok(exp.includes('bytes: pdf.size') && exp.includes('htmlBytes: html.size'));
  assert.ok(exp.includes('fileName: pdf.name'));
});

test('★★ 文件名精确到秒：同一分钟内连打两次也不撞', () => {
  const a = bookletBaseName(new Date('2026-10-17T21:39:01'));
  const b = bookletBaseName(new Date('2026-10-17T21:39:02'));
  assert.notEqual(a, b, '只到分钟就会撞名 —— 这正是那次 FileAlreadyExistsException');
  assert.equal(a, '格物-家庭财产清册-20261017-213901');
  assert.ok(a.startsWith(BOOKLET_PREFIX));
  assert.equal(bookletBaseName(new Date('2026-01-02T03:04:05')), '格物-家庭财产清册-20260102-030405');
});

test('★ 清册文件靠前缀认领，不能按时间猜', () => {
  assert.ok(isBookletFile('格物-家庭财产清册-20261017-213901.pdf'));
  assert.ok(isBookletFile('格物-家庭财产清册-20261017-213901.html'));
  assert.ok(!isBookletFile('格物-备份.zip'));
  assert.ok(!isBookletFile('IMG_0001.JPG'));
});

test('★★★ 任何失败都只允许出现一句人话，不许把原生异常甩给用户', () => {
  const raw = new Error(
    "Call to function 'FileSystemFile.rename' has been rejected.\n" +
      '→ Caused by: java.nio.file.FileAlreadyExistsException: ' +
      '/data/user/0/com.gewu.app/cache/Print/格物-家庭财产清册-20261017-2139.pdf',
  );
  const failure = toFailure('save', raw);
  assert.equal(failure.code, 'save');
  assert.ok(
    !/java\.|FileSystemFile|data\/user|Caused by|rejected/i.test(failure.message),
    `文案里漏了技术细节：${failure.message}`,
  );
  assert.ok(failure.message.length <= 30, '失败文案要能一眼读完');
  assert.equal(failure.detail, raw, '原始异常要留给日志，别丢');
});

test('★ 症状优先于环节：空间不足 / 文件被清掉 各说各的', () => {
  assert.equal(classifyFailure('save', new Error('ENOSPC: No space left on device')), 'nospace');
  assert.equal(classifyFailure('save', new Error('ENOENT: No such file or directory')), 'save');
  assert.equal(
    classifyFailure('share', new Error('ENOENT: No such file or directory')),
    'missing',
    '分享时说「文件没了」，与生成时说「存不下」是两回事',
  );
  assert.equal(classifyFailure('share', new Error('something odd')), 'share');
  assert.equal(classifyFailure('layout', new Error('WebView crashed')), 'layout');
});

test('每条失败文案都是中文、互不相同、不夹英文', () => {
  const texts = Object.values(FAILURE_TEXT);
  assert.equal(new Set(texts).size, texts.length, '两条失败不能共用一句话');
  for (const text of texts) {
    assert.ok(/[\u4e00-\u9fa5]/.test(text), `没有中文：${text}`);
    assert.ok(!/[A-Za-z]{3,}/.test(text), `混了英文：${text}`);
    assert.ok(text.endsWith('。'), `没写完：${text}`);
  }
});

test('★★ 生成后必须把两个文件分别列出来，各带自己的发送', () => {
  const sheet = code('components/domain/InventorySheet.tsx');
  assert.ok(sheet.includes('tag="PDF"') && sheet.includes('tag="HTML"'), '两个文件要分别列出');
  assert.ok(sheet.includes('runSharePdf') && sheet.includes('runShareHtml'));
  assert.ok(sheet.includes('重新生成一份'));
  // 按钮文案不许再只说 PDF —— 一次生成的是两个文件
  assert.ok(!sheet.includes('生成 PDF'), '按钮写「生成 PDF」，产物却是两个文件');
});

test('★ 入口写的就是两个格式，不许只写 PDF', () => {
  const mine = code('app/(tabs)/mine.tsx');
  assert.ok(
    /label="生成家庭财产清册"\s*\n\s*value="PDF · HTML"/.test(mine),
    '入口的说明要和实际产物一致',
  );
});

test('★★ 清册入口按档位拦：免费档打开的是门控浮层，不是配置弹层', () => {
  /*
   * 2026-10-17 重新划档时清册从免费转成了支持者功能。
   * ★ 漏掉这一处不会报错 —— 入口照常打开、清册照常生成，只是这道付费墙等于不存在，
   *   而且没有人会去测「我明明没买，为什么还能用」。
   * ★ 行**不藏**：藏掉之后免费用户不知道有这项、也不知道支持者档买的是什么。
   */
  const mine = code('app/(tabs)/mine.tsx');
  assert.match(
    mine,
    /if \(entitled\) setInventoryOpen\(true\);\s*\n\s*else setGateFeature\('inventory'\)/,
    '清册入口没有按档位分流 —— 免费档应当弹 `inventory` 门控浮层',
  );
  assert.ok(
    !/onPress=\{\(\) => setInventoryOpen\(true\)\}/.test(mine),
    '清册入口又变回无条件打开了 —— 那等于取消这项付费',
  );
  /* CSV 导出必须仍然是免费的：卖的是版式与打印品相，不是「把你的数据带走」这件事本身 */
  assert.ok(
    /label="导出物品清单"[\s\S]{0,220}onPress=\{runExport\}/.test(mine),
    'CSV 导出不该被一起挡住 —— 用户自己的数据不能按次收费',
  );
});
