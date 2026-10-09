/**
 * 统计聚合纯逻辑测试。
 *
 * 这一组的失败模式几乎全是「不报错但数不对」：
 *   · 排行条按占比而不是按最大值归一 → 全是小类目时每根条都短得看不出差别
 *   · 「其余 N 类」被算进 max → 榜首满格基准被汇总项顶掉，整排条全变短
 *   · 日均排行把「有价格没日期」的算成 0 元/天 → 榜尾一串 ¥0.00
 *   · 柜子按件数排而不是按占用率 → 最大的柜子永远第一，但那条不是「该收拾了」
 *   · 月度分组用购买日期 → 大量为空的字段让趋势缺一大块，看着像「买得很少」
 * 所以断言盯的是**具体顺序、条数与数值**，不是「不为空」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  summarize,
  buildValueBars,
  rankDailyCost,
  rankCabinets,
  buildMonthSeries,
  monthRatios,
  describePeak,
} = await import('../src/lib/stats.ts');

/** 造一条 ItemView（只填这一页用得到的字段） */
function item(patch) {
  return {
    id: patch.id ?? patch.name,
    name: patch.name ?? '物品',
    categoryName: patch.categoryName ?? null,
    price: patch.price ?? null,
    purchaseDate: patch.purchaseDate ?? null,
    createdAt: patch.createdAt ?? 0,
    dailyCost: patch.dailyCost ?? null,
    holdingDays: patch.holdingDays ?? null,
  };
}

/** 造一个柜子视图 */
function cabinet({ id, name, slots, occupiedSlots, totalCount }) {
  return {
    id,
    name,
    totalSlots: slots,
    occupiedSlots,
    totalCount: totalCount ?? occupiedSlots,
    slots: Array.from({ length: slots }, (_, i) => ({
      slot: { id: `${id}-s${i}` },
      itemCount: i < occupiedSlots ? 1 : 0,
      thumbs: [],
    })),
  };
}

/* ------------------------------------------------------------ 总览 */

test('总览：总价值只算有价格的，日均合计只算两个字段齐备的', () => {
  const s = summarize([
    item({ name: 'a', price: 100, dailyCost: 1, holdingDays: 100 }),
    item({ name: 'b', price: 200, purchaseDate: '2026-01-01', dailyCost: 2, holdingDays: 100 }),
    item({ name: 'c', price: null, dailyCost: null }),
    // 有价格、没日期：进得了总价值，进不了日均
    item({ name: 'd', price: 50 }),
  ]);

  assert.equal(s.total, 4);
  assert.equal(s.totalValue, 350);
  assert.equal(s.pricedCount, 3, '★ 两个数的样本不一样，页面上的口径小字就是为它写的');
  assert.equal(s.dailyTotal, 3);
  assert.equal(s.dailySampleCount, 2);
});

test('总览：空库全为 0，不出现 NaN', () => {
  const s = summarize([]);
  assert.deepEqual(s, {
    total: 0,
    totalValue: 0,
    pricedCount: 0,
    dailyTotal: 0,
    dailySampleCount: 0,
  });
});

/* ------------------------------------------------------------ 分类价值条 */

test('价值条：条长以最高的一类为满格', () => {
  const { bars, max, total } = buildValueBars([
    item({ name: 'a', categoryName: '数码', price: 6000 }),
    item({ name: 'b', categoryName: '厨房', price: 3000 }),
    item({ name: 'c', categoryName: '五金', price: 1000 }),
  ]);

  assert.equal(max, 6000);
  assert.equal(total, 10_000);
  assert.deepEqual(
    bars.map((b) => b.label),
    ['数码', '厨房', '五金'],
    '按金额降序',
  );
  assert.equal(bars[0].ratio, 1, '榜首满格');
  assert.equal(bars[1].ratio, 0.5);
  assert.equal(bars[2].ratio, 1 / 6);
});

test('价值条：超过 topN 的合并成「其余 N 类」，且不参与满格基准', () => {
  const { bars, restLabel, restValue, max } = buildValueBars(
    [
      item({ name: 'a', categoryName: 'A', price: 100 }),
      item({ name: 'b', categoryName: 'B', price: 80 }),
      item({ name: 'c', categoryName: 'C', price: 60 }),
      item({ name: 'd', categoryName: 'D', price: 40 }),
      item({ name: 'e', categoryName: 'E', price: 20 }),
      item({ name: 'f', categoryName: 'F', price: 10 }),
      item({ name: 'g', categoryName: 'G', price: 5 }),
    ],
    5,
  );

  assert.equal(bars.length, 5);
  assert.equal(restLabel, '其余 2 类');
  assert.equal(restValue, 15);
  assert.equal(max, 100, '★ 满格基准必须是榜首那一类，不能是总额');
});

test('价值条：不到 topN 时不产生汇总行', () => {
  const { restLabel, restValue, restRatio } = buildValueBars([
    item({ name: 'a', categoryName: 'A', price: 10 }),
    item({ name: 'b', categoryName: 'B', price: 5 }),
  ]);
  assert.equal(restLabel, null);
  assert.equal(restValue, 0);
  assert.equal(restRatio, 0);
});

test('价值条：没填分类的归到「未分类」，且不因为 price 为空而混进来', () => {
  const { bars } = buildValueBars([
    item({ name: 'a', categoryName: null, price: 30 }),
    item({ name: 'b', categoryName: '数码', price: null }),
  ]);
  assert.deepEqual(
    bars.map((b) => `${b.label}:${b.value}`),
    ['未分类:30'],
    '没价格的分类不该以 0 元出现在榜上',
  );
});

test('价值条：全为 0 时不除零', () => {
  const { bars, max } = buildValueBars([item({ name: 'a', categoryName: '数码', price: 0 })]);
  assert.equal(max, 0);
  assert.equal(bars[0].ratio, 0);
  assert.ok(Number.isFinite(bars[0].ratio));
});

/* ------------------------------------------------------------ 日均排行 */

test('日均排行：降序、只取前 N，但合计与样本数算全量', () => {
  const { rows, totalPerDay, sampleCount } = rankDailyCost(
    [
      item({ name: '咖啡机', dailyCost: 25.83, holdingDays: 96 }),
      item({ name: '净化器', dailyCost: 25.77, holdingDays: 128 }),
      item({ name: '显示器', dailyCost: 9.04, holdingDays: 210 }),
      item({ name: '人体工学椅', dailyCost: 7.76, holdingDays: 165 }),
      item({ name: '电动牙刷', dailyCost: 6.88, holdingDays: 58 }),
      item({ name: '便宜货', dailyCost: 0.5, holdingDays: 20 }),
    ],
    5,
  );

  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['咖啡机', '净化器', '显示器', '人体工学椅', '电动牙刷'],
  );
  assert.equal(sampleCount, 6, '★ 样本数是全量，不是 topN');
  assert.ok(
    Math.abs(totalPerDay - 75.78) < 1e-9,
    '★ 合计也是全量 —— 顶部三格那个数就来自它（浮点求和，用容差比）',
  );
});

test('日均排行：缺价格或购买日期的整行不出现，绝不显示 ¥0.00/天', () => {
  const { rows, sampleCount } = rankDailyCost([
    item({ name: '有价无日期', price: 500, dailyCost: null }),
    item({ name: '有日期无价', purchaseDate: '2026-01-01', dailyCost: null }),
    item({ name: '齐全', price: 100, purchaseDate: '2026-01-01', dailyCost: 1, holdingDays: 100 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['齐全'],
  );
  assert.equal(sampleCount, 1);
});

test('日均排行：金额并列时按名称，不按输入顺序', () => {
  const a = rankDailyCost([
    item({ name: '乙', dailyCost: 5, holdingDays: 10 }),
    item({ name: '甲', dailyCost: 5, holdingDays: 10 }),
  ]);
  const b = rankDailyCost([
    item({ name: '甲', dailyCost: 5, holdingDays: 10 }),
    item({ name: '乙', dailyCost: 5, holdingDays: 10 }),
  ]);
  assert.deepEqual(
    a.rows.map((r) => r.name),
    b.rows.map((r) => r.name),
    '同一组数据换个输入顺序也该排出同一个顺序',
  );
});

/* ------------------------------------------------------------ 柜子占用 */

test('柜子：按占用率排，不按件数', () => {
  const list = rankCabinets([
    // 大柜子：12 格里用 8 格 —— 占用率 0.67，但件数最多
    cabinet({ id: 'big', name: '书房书柜', slots: 12, occupiedSlots: 8, totalCount: 40 }),
    // 小柜子：6 格里用 5 格 —— 占用率 0.83
    cabinet({ id: 'small', name: '玄关鞋柜', slots: 6, occupiedSlots: 5, totalCount: 6 }),
    // 半空：6 格里用 3 格 —— 0.5
    cabinet({ id: 'half', name: '阳台储物柜', slots: 6, occupiedSlots: 3, totalCount: 3 }),
  ]);

  assert.deepEqual(
    list.map((c) => c.name),
    ['玄关鞋柜', '书房书柜', '阳台储物柜'],
    '★ 按件数排的话「书房书柜」会永远第一，而那条不是「该收拾了」',
  );
});

test('柜子：占用率相同则格位多的排前面，没有格位的不参与', () => {
  const list = rankCabinets([
    cabinet({ id: 'a', name: '小柜', slots: 2, occupiedSlots: 1 }),
    cabinet({ id: 'b', name: '大柜', slots: 8, occupiedSlots: 4 }),
    cabinet({ id: 'c', name: '没格位', slots: 0, occupiedSlots: 0 }),
  ]);

  assert.deepEqual(
    list.map((c) => c.name),
    ['大柜', '小柜'],
    '0/0 没有占用率可言，放进来只会是一根空条',
  );
});

test('柜子：截断到 topN', () => {
  const list = rankCabinets(
    [
      cabinet({ id: 'a', name: 'A', slots: 4, occupiedSlots: 4 }),
      cabinet({ id: 'b', name: 'B', slots: 4, occupiedSlots: 3 }),
      cabinet({ id: 'c', name: 'C', slots: 4, occupiedSlots: 2 }),
      cabinet({ id: 'd', name: 'D', slots: 4, occupiedSlots: 1 }),
    ],
    2,
  );
  assert.equal(list.length, 2);
});

test('柜子：带上原始格位，页面才能复用同一排方块', () => {
  const [first] = rankCabinets([cabinet({ id: 'a', name: 'A', slots: 3, occupiedSlots: 2 })]);
  assert.equal(first.slots.length, 3);
  assert.equal(first.slots.filter((s) => s.itemCount > 0).length, 2);
});

/* ------------------------------------------------------------ 最近半年 */

test('月度：从往前第 N-1 个月排到当前月，跨年也接得上', () => {
  const now = new Date(2026, 0, 15); // 2026-01
  const buckets = buildMonthSeries([], now, 6);
  assert.deepEqual(
    buckets.map((b) => b.key),
    ['2025-8', '2025-9', '2025-10', '2025-11', '2025-12', '2026-1'],
  );
  assert.deepEqual(
    buckets.map((b) => b.label),
    ['8 月', '9 月', '10 月', '11 月', '12 月', '1 月'],
  );
});

test('月度：按入库时间分组，窗口外的丢弃', () => {
  const now = new Date(2026, 8, 15); // 2026-09
  const buckets = buildMonthSeries(
    [
      item({ name: 'a', createdAt: new Date(2026, 8, 3).getTime() }),
      item({ name: 'b', createdAt: new Date(2026, 8, 28).getTime() }),
      item({ name: 'c', createdAt: new Date(2026, 6, 1).getTime() }),
      item({ name: 'old', createdAt: new Date(2025, 0, 1).getTime() }),
    ],
    now,
    6,
  );

  const byKey = new Map(buckets.map((b) => [b.key, b.count]));
  assert.equal(byKey.get('2026-9'), 2);
  assert.equal(byKey.get('2026-7'), 1);
  assert.equal(byKey.get('2026-4'), 0);
  assert.equal(
    buckets.reduce((s, b) => s + b.count, 0),
    3,
    '2025 年那件落在窗口外，不该被塞进最早那一格',
  );
});

test('月度：柱子高度比例与峰值读数', () => {
  const now = new Date(2026, 8, 15);
  const buckets = buildMonthSeries(
    [
      item({ name: 'a', createdAt: new Date(2026, 8, 3).getTime() }),
      item({ name: 'b', createdAt: new Date(2026, 8, 4).getTime() }),
      item({ name: 'c', createdAt: new Date(2026, 7, 4).getTime() }),
    ],
    now,
    6,
  );

  const ratios = monthRatios(buckets);
  assert.equal(Math.max(...ratios), 1, '最高的一根必须满格');
  assert.equal(ratios[ratios.length - 1], 1, '9 月是峰值');

  assert.deepEqual(describePeak(buckets), { label: '9 月', count: 2 });
});

test('月度：一件都没新增时没有峰值读数，也不除零', () => {
  const buckets = buildMonthSeries([], new Date(2026, 8, 15), 6);
  assert.equal(describePeak(buckets), null);
  assert.deepEqual(
    monthRatios(buckets),
    [0, 0, 0, 0, 0, 0],
  );
});

/* ------------------------------------------------------------ 串起来 */

test('从一组物品一路走到四段结论，数字之间对得上', () => {
  const items = [
    item({
      name: '咖啡机',
      categoryName: '厨房',
      price: 2480,
      purchaseDate: '2026-06-01',
      dailyCost: 24.8,
      holdingDays: 100,
      createdAt: new Date(2026, 8, 2).getTime(),
    }),
    item({
      name: '显示器',
      categoryName: '数码',
      price: 1800,
      purchaseDate: '2026-02-01',
      dailyCost: 8.18,
      holdingDays: 220,
      createdAt: new Date(2026, 7, 9).getTime(),
    }),
    item({ name: '螺丝刀', categoryName: '五金', price: 40, createdAt: new Date(2026, 6, 1).getTime() }),
  ];

  const s = summarize(items);
  const { total: barsTotal, bars } = buildValueBars(items);
  const cost = rankDailyCost(items);
  const months = buildMonthSeries(items, new Date(2026, 8, 15), 6);

  assert.equal(barsTotal, s.totalValue, '★ 分类合计必须等于顶部「总价值」，页面上写死了「同源」');
  assert.equal(cost.totalPerDay, s.dailyTotal, '★ 日均合计同理');
  assert.equal(cost.sampleCount, s.dailySampleCount);
  assert.equal(
    bars.reduce((sum, b) => sum + b.value, 0),
    s.totalValue,
  );
  assert.equal(
    months.reduce((sum, b) => sum + b.count, 0),
    items.length,
    '三个月都在窗口内，柱子加起来应等于总件数',
  );
});
