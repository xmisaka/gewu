/**
 * 纯函数单测 —— 日期派生、格式化、猜词。
 *
 * 这三块是「算错了也没人报错」的重灾区：日均成本、到期状态、金额展示
 * 都会直接影响用户对数据的信任，但出错时界面只是安静地显示一个错数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SOON_THRESHOLD_DAYS,
  toDateString,
  parseDate,
  today,
  daysBetween,
  holdingDays,
  dailyCost,
  isJustAcquired,
  expiryState,
  describeRemaining,
  addMonths,
  formatDateCN,
  formatDateDot,
  describePurchase,
} from '../src/lib/date.ts';
import {
  formatMoney,
  formatDailyCost,
  formatCount,
  formatMoneyCompact,
  parseMoneyInput,
  formatBytes,
  formatStamp,
  initialOf,
} from '../src/lib/format.ts';
import {
  BUILTIN_CATEGORIES,
  guessCategory,
  defaultExpireMonths,
  EXPIRY_PRESETS,
  UNCATEGORIZED,
} from '../src/lib/suggest.ts';

/** 相对今天的日期串，供依赖 today() 的函数使用 */
function dayOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toDateString(d);
}

/* ------------------------------------------------------------ 日期 */

test('toDateString / parseDate 往返一致，且解析的是本地零点', () => {
  const d = parseDate('2026-09-17');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8, '月份应已从 1 基转成 0 基');
  assert.equal(d.getDate(), 17);
  assert.equal(d.getHours(), 0, '应是本地零点而不是 UTC 零点');
  assert.equal(toDateString(d), '2026-09-17');
});

test('parseDate：非法输入一律返回 null，不抛异常', () => {
  for (const bad of [null, undefined, '', '   ', '2026-9-17', '20260917', '2026/09/17', '2026-13-01x']) {
    assert.equal(parseDate(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.ok(parseDate(' 2026-09-17 '), '两侧空白应被容忍');
});

test('daysBetween：跨月与跨年按整天数算', () => {
  assert.equal(daysBetween('2026-09-17', '2026-09-17'), 0);
  assert.equal(daysBetween('2026-09-17', '2026-09-20'), 3);
  assert.equal(daysBetween('2026-09-20', '2026-09-17'), -3);
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1);
  assert.equal(daysBetween('2026-01-31', '2026-02-01'), 1);
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2, '2024 是闰年');
  assert.equal(daysBetween('2025-02-28', '2025-03-01'), 1, '2025 不是闰年');
  assert.equal(daysBetween('nope', '2026-01-01'), null);
});

test('holdingDays：当天购买或预购都按 1 天计，不给 0 或负数', () => {
  assert.equal(holdingDays('2026-09-07', '2026-09-17'), 10);
  assert.equal(holdingDays('2026-09-17', '2026-09-17'), 1, '当天购买按 1 计');
  assert.equal(holdingDays('2026-12-01', '2026-09-17'), 1, '预购不应产生负数');
  assert.equal(holdingDays(null, '2026-09-17'), null);
});

test('dailyCost：价格或购买日期任一缺失即返回 null，绝不返回 ¥0.00', () => {
  assert.equal(dailyCost(100, '2026-09-07', '2026-09-17'), 10);
  assert.equal(dailyCost(null, '2026-09-07', '2026-09-17'), null);
  assert.equal(dailyCost(0, '2026-09-07', '2026-09-17'), null, '价格为 0 视为未填');
  assert.equal(dailyCost(-5, '2026-09-07', '2026-09-17'), null);
  assert.equal(dailyCost(100, null, '2026-09-17'), null);
  // 当天买的大额物品：除以 1，不该出现除零
  assert.equal(dailyCost(5000, '2026-09-17', '2026-09-17'), 5000);
});

test('isJustAcquired：购买日不早于今天即为「刚入手」', () => {
  assert.equal(isJustAcquired('2026-09-17', '2026-09-17'), true);
  assert.equal(isJustAcquired('2026-10-01', '2026-09-17'), true);
  assert.equal(isJustAcquired('2026-09-16', '2026-09-17'), false);
  assert.equal(isJustAcquired(null, '2026-09-17'), false);
});

test(`expiryState：${SOON_THRESHOLD_DAYS} 天整好落在「即将到期」内侧`, () => {
  const on = '2026-09-17';
  assert.deepEqual(expiryState(null, on), { state: 'none', days: null });
  assert.deepEqual(expiryState('2026-09-16', on), { state: 'overdue', days: -1 });
  assert.deepEqual(expiryState('2026-09-17', on), { state: 'soon', days: 0 }, '今天到期算即将到期');
  assert.deepEqual(expiryState('2026-10-17', on), { state: 'soon', days: 30 });
  assert.deepEqual(expiryState('2026-10-18', on), { state: 'fine', days: 31 });
});

test('describeRemaining / formatDateCN / formatDateDot 的文案与缺省值', () => {
  assert.equal(describeRemaining(null), '未设置');
  assert.equal(describeRemaining(-3), '已过期 3 天');
  assert.equal(describeRemaining(0), '今天到期');
  assert.equal(describeRemaining(7), '还剩 7 天');

  assert.equal(formatDateCN('2026-09-17'), '2026年9月17日');
  assert.equal(formatDateCN(null), '未设置');
  assert.equal(formatDateDot('2026-09-07'), '2026.09.07');
  assert.equal(formatDateDot(null), '未设置');
});

test('addMonths：月末溢出钳到目标月最后一天', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28', '平年 2 月只有 28 天');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29', '闰年 2 月有 29 天');
  assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
  assert.equal(addMonths('2026-01-15', 12), '2027-01-15');
  assert.equal(addMonths('2026-01-15', 0), '2026-01-15');
  assert.equal(addMonths('不是日期', 3), '不是日期', '解析失败时原样返回');
});

test('describePurchase：按天/月/年分档，未来的日期说「刚入手」', () => {
  assert.equal(describePurchase(null), '未记录购买日期');
  assert.equal(describePurchase(dayOffset(0)), '刚入手');
  assert.equal(describePurchase(dayOffset(30)), '刚入手', '未来日期也是刚入手');
  assert.equal(describePurchase(dayOffset(-10)), '入手 10 天');
  assert.equal(describePurchase(dayOffset(-60)), '入手 2 个月');
  assert.match(describePurchase(dayOffset(-400)), /^入手 1\.1 年$/);
  assert.match(describePurchase(dayOffset(-4000)), /^入手 11 年$/, '10 年以上不再保留一位小数');
});

/* ------------------------------------------------------------ 格式化 */

test('formatMoney：整数不带小数，有分才显示两位', () => {
  assert.equal(formatMoney(8999), '¥8,999');
  assert.equal(formatMoney(8999.5), '¥8,999.50');
  assert.equal(formatMoney(0), '¥0');
  assert.equal(formatMoney(null), '未设置');
  assert.equal(formatMoney(8999, { decimals: 'always' }), '¥8,999.00');
  assert.equal(formatMoney(-1234.5), '¥-1,234.50', '负数符号在货币号之后');
  assert.equal(formatMoney(1234567.891), '¥1,234,567.89', '按分四舍五入');
});

test('formatDailyCost：小额给到分，极小值给到厘位', () => {
  assert.equal(formatDailyCost(null), '', '缺值时应为空串，由调用方隐藏整行');
  assert.equal(formatDailyCost(12), '¥12.00');
  assert.equal(formatDailyCost(0.5), '¥0.50');
  assert.equal(formatDailyCost(0.01), '¥0.01');
  assert.equal(formatDailyCost(0.0012), '¥0.0012', '低于一分时给四位，避免 ¥0.00');
});

test('formatCount / formatMoneyCompact：千分位与万亿压缩', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1,000');
  assert.equal(formatCount(1234567), '1,234,567');

  assert.equal(formatMoneyCompact(0), '¥0');
  assert.equal(formatMoneyCompact(9999), '¥9,999');
  assert.equal(formatMoneyCompact(10000), '¥1.0万');
  assert.equal(formatMoneyCompact(12480), '¥1.2万');
  assert.equal(formatMoneyCompact(100000000), '¥1.0亿');
});

test('parseMoneyInput：容忍全角、货币号与千分位，负数与垃圾输入返回 null', () => {
  assert.equal(parseMoneyInput('8999'), 8999);
  assert.equal(parseMoneyInput('¥8,999'), 8999);
  assert.equal(parseMoneyInput('８９９９'), 8999, '全角数字应被归一');
  assert.equal(parseMoneyInput(' 1 234.5 '), 1234.5);
  assert.equal(parseMoneyInput('99.999'), 100, '按分四舍五入');
  assert.equal(parseMoneyInput(''), null);
  assert.equal(parseMoneyInput('abc'), null);
  assert.equal(parseMoneyInput('-5'), null);
  assert.equal(parseMoneyInput('1e999'), null, '溢出成 Infinity 应被拒');
});

test('formatBytes：按 B / KB / MB / GB 分档', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB');
});

test('formatStamp / initialOf：时间戳与占位首字', () => {
  const ms = new Date(2026, 8, 17, 14, 30).getTime();
  assert.equal(formatStamp(ms), '2026.09.17 14:30');
  assert.equal(formatStamp(new Date(2026, 0, 5, 9, 5).getTime()), '2026.01.05 09:05');

  assert.equal(initialOf('相机'), '相');
  assert.equal(initialOf('iphone'), 'I', '拉丁字母取大写');
  assert.equal(initialOf('  耳机  '), '耳', '应忽略两侧空白');
  assert.equal(initialOf('   '), '·', '空名给一个占位符而不是空串');
});

/* ------------------------------------------------------------ 猜词 */

test('内置分类：名称不重复，类内关键词不重复', () => {
  const names = BUILTIN_CATEGORIES.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, '分类名不应重复');
  assert.ok(!names.includes(UNCATEGORIZED), '「未分类」不是实体，不该出现在内置表里');

  for (const c of BUILTIN_CATEGORIES) {
    const kw = c.keywords.map((k) => k.toLowerCase());
    const dup = kw.find((k, i) => kw.indexOf(k) !== i);
    assert.equal(dup, undefined, `「${c.name}」里重复了关键词 ${dup}`);
  }
});

test('guessCategory：长词优先，避免被短词抢先', () => {
  // 「螺丝刀」属工具，但五金里也有「螺丝」——必须长词先命中
  assert.equal(guessCategory('螺丝刀'), '工具');
  assert.equal(guessCategory('一盒螺丝'), '五金');

  // 「u盘」应压过厨房的「盘」
  assert.equal(guessCategory('U盘'), '数码', '大小写应被归一');
  assert.equal(guessCategory('盘子'), '厨房');
});

test('guessCategory：大小写与空白无关，未命中返回 null', () => {
  assert.equal(guessCategory('iPhone 15'), '数码');
  assert.equal(guessCategory('  t恤  '), '服饰');
  assert.equal(guessCategory('   '), null);
  assert.equal(guessCategory(''), null);
  assert.equal(guessCategory('外婆传下来的玉佩'), null, '没命中就是没命中，不硬猜');
});

test('guessCategory：同一输入反复调用结果稳定', () => {
  // 跨类重复的关键词（如「挂钩」「罐头」）不该造成结果漂移
  for (const name of ['挂钩', '罐头', '保温杯', '背包客']) {
    const first = guessCategory(name);
    const second = guessCategory(name);
    assert.equal(first, second, `「${name}」两次调用结果不一致`);
    assert.notEqual(first, undefined);
  }
});

test('defaultExpireMonths：按分类取默认保质期，无过期概念的分类给 null', () => {
  assert.equal(defaultExpireMonths('药品'), 24);
  assert.equal(defaultExpireMonths('食品'), 12);
  assert.equal(defaultExpireMonths('数码'), null);
  assert.equal(defaultExpireMonths('自定义分类'), null);
  assert.equal(defaultExpireMonths(null), null);
  assert.equal(defaultExpireMonths(UNCATEGORIZED), null);
});

test('保质期模板与内置词典的月份取值为正整数', () => {
  for (const p of EXPIRY_PRESETS) {
    assert.ok(Number.isInteger(p.months) && p.months > 0, `${p.label} 的月数应为正整数`);
    assert.ok(p.label.length > 0);
  }
  for (const c of BUILTIN_CATEGORIES) {
    if (c.expireMonths == null) continue;
    assert.ok(Number.isInteger(c.expireMonths) && c.expireMonths > 0, `「${c.name}」的保质期应为正整数`);
  }
});

test('today() 与解析后的日期往返一致', () => {
  assert.equal(toDateString(parseDate(today())), today());
});
