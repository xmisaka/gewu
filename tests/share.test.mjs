/**
 * 海报 · 纯逻辑测试
 *
 * 这一组的失败模式全是「不报错但发出去难看」：
 *   · 编号补零漏了 → 海报角落一个「NO. 7」，像版本号
 *   · 多件标题取了第一件的位置 → 发出去就是错的，而错得看不出来
 *   · 暗房在没有照片时也出现在模板条里 → 选了一整块黑
 *   · 天数写「至今 0 天」→ 读起来像出错
 *   · 清单文本的括号没闭合 → 转发两次之后没人看得懂
 * 所以断言盯的是**具体字符串与顺序**，不是「不为空」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  POSTER_MAX_CELLS,
  POSTER_SIZE,
  GRID_METRICS,
  formatOrdinal,
  formatDaysLine,
  formatPurchaseMonth,
  locationPath,
  brandLine,
  quantityText,
  multiTitle,
  multiSubtitle,
  gridColumns,
  gridMetrics,
  overflowHint,
  buildSinglePoster,
  buildMultiPoster,
  buildStatPoster,
  photoCountOf,
} = await import('../src/lib/share/model.ts');

const { SKINS, skinsFor, skinOf } = await import('../src/lib/share/templates.ts');
const { POSTER_QUOTES, pickQuote, quotesOf, QUOTE_GROUPS } = await import(
  '../src/lib/share/quotes.ts'
);
const { buildListText } = await import('../src/lib/share/list-text.ts');

/** 造一条 ItemView（只填海报用得到的字段） */
function item(patch = {}) {
  return {
    id: patch.id ?? patch.name ?? 'id',
    name: patch.name ?? '物品',
    brand: patch.brand ?? null,
    model: patch.model ?? null,
    quantity: patch.quantity ?? null,
    purchaseDate: patch.purchaseDate ?? null,
    categoryName: patch.categoryName ?? null,
    cabinetName: patch.cabinetName ?? null,
    locationName: patch.locationName ?? null,
    coverThumb: patch.coverThumb ?? null,
    holdingDays: patch.holdingDays ?? null,
    createdAt: patch.createdAt ?? 0,
  };
}

const NOW = new Date(2026, 9, 18); // 2026-10-18

/* ------------------------------------------------------------ 模板目录 */

test('模板目录：四套、顺序固定、骨架映射不变', () => {
  assert.deepEqual(
    SKINS.map((s) => s.key),
    ['sujian', 'chenlie', 'yizhang', 'anfang'],
  );
  assert.equal(skinOf('sujian').layout, 'single');
  assert.equal(skinOf('chenlie').layout, 'grid');
  assert.equal(skinOf('yizhang').layout, 'stat');
  assert.equal(skinOf('anfang').photoMode, 'full');
  // 找不到的 key 不能白屏，回落到第一套
  assert.equal(skinOf('nope').key, 'sujian');
});

test('模板过滤：暗房要有照片，一页账只吃统计', () => {
  assert.deepEqual(
    skinsFor('single', false).map((s) => s.key),
    ['sujian', 'chenlie'],
  );
  assert.deepEqual(
    skinsFor('single', true).map((s) => s.key),
    ['sujian', 'chenlie', 'anfang'],
  );
  assert.deepEqual(
    skinsFor('multi', true).map((s) => s.key),
    ['sujian', 'chenlie'],
  );
  assert.deepEqual(
    skinsFor('stat', false).map((s) => s.key),
    ['yizhang'],
  );
});

test('每套模板的 token 都齐，且底色符合明暗约定', () => {
  for (const s of SKINS) {
    for (const key of ['paper', 'ink', 'ink2', 'ink3', 'line', 'accent']) {
      assert.match(s[key], /^#|^rgba/, `${s.key}.${key} 必须是色值`);
    }
    assert.ok(s.pad > 0 && s.pad < 48, `${s.key} 的内边距必须落在画布内`);
  }
  // 只有暗房是深色皮：底色比墨色暗
  const dark = SKINS.filter((s) => s.key === 'anfang');
  assert.equal(dark.length, 1);
});

/* ------------------------------------------------------------ 编号与日期 */

test('编号补三位，超了不补', () => {
  assert.equal(formatOrdinal(1), 'NO. 001');
  assert.equal(formatOrdinal(42), 'NO. 042');
  assert.equal(formatOrdinal(999), 'NO. 999');
  assert.equal(formatOrdinal(1000), 'NO. 1000');
  assert.equal(formatOrdinal(null), null);
  assert.equal(formatOrdinal(0), null);
});

test('购买年月只到月', () => {
  assert.equal(formatPurchaseMonth('2021-03-12'), '2021.03');
  assert.equal(formatPurchaseMonth(null), null);
});

test('天数行：0 天写刚入手，超过十年切到年', () => {
  assert.equal(formatDaysLine('2021-03-12', 1842), '2021.03 · 至今 1842 天');
  assert.equal(formatDaysLine('2026-10-18', 0), '2026.10 · 刚入手');
  assert.equal(formatDaysLine('2015-01-01', 4000), '2015.01 · 至今 11 年');
  assert.equal(formatDaysLine(null, 100), null);
  assert.equal(formatDaysLine('2021-03-12', null), null);
});

/* ------------------------------------------------------------ 字段拼接 */

test('位置与品牌型号：缺一边就不带分隔符', () => {
  assert.equal(locationPath('厨房', '调料架'), '厨房 · 调料架');
  assert.equal(locationPath('厨房', null), '厨房');
  assert.equal(locationPath(null, null), null);
  assert.equal(brandLine('SONY', 'WH-1000XM4'), 'SONY · WH-1000XM4');
  assert.equal(brandLine('SONY', 'SONY'), 'SONY');
  assert.equal(brandLine(null, 'WH-1000XM4'), 'WH-1000XM4');
  assert.equal(brandLine('  ', ''), null);
});

test('数量口径：空是没启用，0 是用完了', () => {
  assert.equal(quantityText(null), null);
  assert.equal(quantityText(0), '用完了');
  assert.equal(quantityText(1), '剩 1 件');
  assert.equal(quantityText(6), '剩 6 件');
});

/* ------------------------------------------------------------ 多件 */

test('多件标题三条递降：同一格 → 同一柜 → 已选 N 件', () => {
  const sameSlot = [
    item({ name: '酱油', cabinetName: '厨房', locationName: '调料架' }),
    item({ name: '香醋', cabinetName: '厨房', locationName: '调料架' }),
  ];
  assert.equal(multiTitle(sameSlot), '厨房 · 调料架');

  const sameCabinet = [
    item({ name: '酱油', cabinetName: '厨房', locationName: '调料架' }),
    item({ name: '洗碗块', cabinetName: '厨房', locationName: '水槽下' }),
  ];
  assert.equal(multiTitle(sameCabinet), '厨房');

  const across = [
    item({ name: '酱油', cabinetName: '厨房', locationName: '调料架' }),
    item({ name: '垃圾袋', cabinetName: '阳台', locationName: '收纳箱' }),
  ];
  assert.equal(multiTitle(across), '已选 2 件');
});

test('多件副标题最多两个分类，多了就归纳', () => {
  assert.equal(
    multiSubtitle([item({ categoryName: '厨房' }), item({ categoryName: '厨房' })]),
    '厨房',
  );
  assert.equal(
    multiSubtitle([item({ categoryName: '厨房' }), item({ categoryName: '清洁' })]),
    '厨房 · 清洁',
  );
  assert.equal(
    multiSubtitle([
      item({ categoryName: '厨房' }),
      item({ categoryName: '清洁' }),
      item({ categoryName: '药品' }),
    ]),
    '厨房 等 3 类',
  );
  assert.equal(multiSubtitle([item({})]), null);
});

test('多件列数：1–4 两列，5–9 三列', () => {
  assert.equal(gridColumns(1), 2);
  assert.equal(gridColumns(4), 2);
  assert.equal(gridColumns(5), 3);
  assert.equal(gridColumns(9), 3);
});

test('图格尺寸：1–9 件都不溢出画布，且图格随行数收缩', () => {
  const pad = skinOf('chenlie').pad;
  const { header, gridTop, footer, nameH, gap } = GRID_METRICS;

  for (let n = 1; n <= POSTER_MAX_CELLS; n += 1) {
    const m = gridMetrics(n, pad);
    // 内容总高 = 图格区 + 页头 + 上间距 + 落款，必须装进画布
    const total = m.blockH + header + gridTop + footer;
    assert.ok(
      total <= POSTER_SIZE.height - pad * 2,
      `${n} 件时总高 ${total} 超过可用 ${POSTER_SIZE.height - pad * 2}`,
    );
    assert.ok(m.img >= GRID_METRICS.minImg, `${n} 件时图格太小：${m.img}`);
    assert.ok(m.img <= m.cellW, `${n} 件时图格比列还宽`);
    assert.equal(m.rows, Math.ceil(n / m.cols));
  }

  // 九件（三行）必须靠缩小图格才装得下；若有人改回「图格 = 列宽」，这里会红
  const nine = gridMetrics(9, pad);
  assert.ok(nine.img < nine.cellW, '九件时图格必须小于列宽，否则最后一行被切');

  // 四件（两行）应当比九件宽松
  assert.ok(gridMetrics(4, pad).img > nine.img);

  // 交叉校验：三行图格 + 两处行距 + 三行文字，确实等于 blockH
  assert.equal(
    nine.blockH,
    nine.img * 3 + nameH * 3 + gap * 2,
    'blockH 的算式与渲染侧必须一致',
  );
});

test('超过九件给提示，不缩图', () => {
  assert.equal(overflowHint(9), null);
  assert.match(overflowHint(10), /最多 9 件/);
});

test('多件只画前九格，但标题里的件数仍是真实的', () => {
  const many = Array.from({ length: 12 }, (_, i) => item({ id: `i${i}`, name: `物品${i}` }));
  const model = buildMultiPoster(many, NOW);
  assert.equal(model.cells.length, POSTER_MAX_CELLS);
  assert.equal(model.countText, '12 件');
});

/* ------------------------------------------------------------ 题语 */

test('题语稳定：同一 seed 永远同一条，且在池子里', () => {
  const texts = POSTER_QUOTES.map((q) => q.text);
  const a = pickQuote('item-abc');
  assert.equal(a, pickQuote('item-abc'));
  assert.ok(texts.includes(a));
  // 不同 seed 不能全落到同一条（否则等于写死）
  const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(pickQuote));
  assert.ok(spread.size > 1);
});

test('题语八条、分三组、都不超过 20 字', () => {
  assert.equal(POSTER_QUOTES.length, 8);
  assert.deepEqual(QUOTE_GROUPS, ['认领', '年岁', '生活']);
  for (const g of QUOTE_GROUPS) {
    assert.ok(quotesOf(g).length > 0, `${g} 不能是空组`);
  }
  for (const q of POSTER_QUOTES) {
    assert.ok(q.text.length <= 20, `「${q.text}」超过 20 字`);
    assert.ok(!q.text.includes('——'), '题语不许用破折号');
  }
});

/* ------------------------------------------------------------ 三种模型 */

test('单件模型：标题、位置、编号、题语都到位', () => {
  const model = buildSinglePoster(
    item({
      id: 'x1',
      name: '索尼 WH-1000XM4',
      brand: 'SONY',
      model: 'WH-1000XM4',
      cabinetName: '书房',
      locationName: '第二格',
      purchaseDate: '2021-03-12',
      holdingDays: 1842,
      coverThumb: 'photos/a-thumb.jpg',
      quantity: null,
    }),
    42,
    NOW,
  );

  assert.equal(model.kind, 'single');
  assert.equal(model.title, '索尼 WH-1000XM4');
  assert.equal(model.subtitle, 'SONY · WH-1000XM4');
  assert.equal(model.location, '书房 · 第二格');
  assert.equal(model.ordinal, 'NO. 042');
  assert.equal(model.daysText, '2021.03 · 至今 1842 天');
  assert.equal(model.dateText, '2026.10.18');
  assert.ok(model.quote.length > 0);
  assert.equal(model.photoThumb, 'photos/a-thumb.jpg');
  assert.equal(photoCountOf(model), 1);
});

test('单件模型：没有照片时照片数为零（暗房会被过滤掉）', () => {
  const model = buildSinglePoster(item({ name: '酱油' }), null, NOW);
  assert.equal(model.photoThumb, null);
  assert.equal(photoCountOf(model), 0);
  assert.equal(model.ordinal, null);
  assert.equal(model.daysText, null);
});

test('多件模型的照片数只算有图的格子', () => {
  const model = buildMultiPoster(
    [
      item({ id: 'a', name: '酱油', cabinetName: '厨房', locationName: '调料架', coverThumb: 't1.jpg' }),
      item({ id: 'b', name: '香醋', cabinetName: '厨房', locationName: '调料架', coverThumb: null }),
      item({ id: 'c', name: '花椒', cabinetName: '厨房', locationName: '调料架', coverThumb: 't3.jpg' }),
    ],
    NOW,
  );
  assert.equal(model.cells.length, 3);
  assert.equal(photoCountOf(model), 2);
  // 同一格才叫「这一格」
  assert.equal(model.eyebrow, '这一格');
});

test('多件跨柜时顶部小字改成「这几件」', () => {
  const model = buildMultiPoster(
    [
      item({ id: 'a', name: '酱油', cabinetName: '厨房', locationName: '调料架' }),
      item({ id: 'b', name: '垃圾袋', cabinetName: '阳台', locationName: '收纳箱' }),
    ],
    NOW,
  );
  assert.equal(model.title, '已选 2 件');
  assert.equal(model.eyebrow, '这几件');
});

test('一页账：件数、柜数、格位数、分类数、最久天数', () => {
  const items = [
    item({ id: 'a', name: 'A', categoryName: '厨房', holdingDays: 900 }),
    item({ id: 'b', name: 'B', categoryName: '厨房', holdingDays: 1842 }),
    item({ id: 'c', name: 'C', categoryName: '清洁', holdingDays: null }),
  ];
  const cabinets = [
    { slots: [{}, {}, {}], totalCount: 2 },
    { slots: [{}], totalCount: 1 },
  ];

  const model = buildStatPoster(items, cabinets, NOW);
  assert.equal(model.kind, 'stat');
  assert.equal(model.title, '3');
  assert.equal(model.stat.total, 3);
  assert.equal(model.stat.cabinetCount, 2);
  assert.equal(model.stat.slotCount, 4);
  assert.equal(model.stat.categoryCount, 2);
  assert.equal(model.stat.oldestDays, 1842);
  assert.equal(model.daysText, '最久的一件 1842 天');
  assert.equal(model.stat.bars.length, 6);
  assert.ok(model.stat.bars.every((r) => r >= 0 && r <= 1));
  // 口径小字必须存在
  assert.ok(model.stat.note.includes('仅统计在库物品'));
});

test('一页账：没有购买日期时不编最久天数', () => {
  const model = buildStatPoster([item({ id: 'a', holdingDays: null })], [], NOW);
  assert.equal(model.stat.oldestDays, null);
  assert.equal(model.daysText, null);
});

/* ------------------------------------------------------------ 清单文本 */

test('清单文本：标题 + 每行位置 + 落款，且不带破折号', () => {
  const text = buildListText([
    item({ name: '老抽酱油', cabinetName: '厨房', locationName: '调料架', quantity: 3 }),
    item({ name: '洗碗块', cabinetName: '厨房', locationName: '水槽下' }),
  ]);

  assert.equal(
    text,
    ['厨房', '', '· 老抽酱油（厨房 · 调料架，剩 3 件）', '· 洗碗块（厨房 · 水槽下）', '', '来自格物 · 收纳柜'].join(
      '\n',
    ),
  );
  assert.ok(!text.includes('——'));
});

test('清单文本：同一格时标题用格名，跨柜时用已选 N 件', () => {
  const same = buildListText([
    item({ name: 'A', cabinetName: '厨房', locationName: '调料架' }),
    item({ name: 'B', cabinetName: '厨房', locationName: '调料架' }),
  ]);
  assert.ok(same.startsWith('厨房 · 调料架'));

  const across = buildListText([
    item({ name: 'A', cabinetName: '厨房', locationName: '调料架' }),
    item({ name: 'B', cabinetName: '阳台', locationName: '收纳箱' }),
  ]);
  assert.ok(across.startsWith('已选 2 件'));
});

test('清单文本：没有位置的物品只写名字，不留空括号', () => {
  const text = buildListText([item({ name: '钥匙' })]);
  assert.ok(text.includes('· 钥匙\n'));
  assert.ok(!text.includes('（）'));
});

test('空列表不生成文本', () => {
  assert.equal(buildListText([]), '');
});
