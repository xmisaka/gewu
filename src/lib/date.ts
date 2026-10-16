/**
 * 格物 · 日期与派生指标
 *
 * 全部使用本地日期，存储格式统一为 `YYYY-MM-DD`。
 * 刻意不依赖 Intl / toLocaleDateString —— Hermes 上时区与中文 locale
 * 表现不稳定，手写格式化更可控。
 */

import type { DateString, ExpiryState } from './types';

/** 到期状态的判定阈值：30 天内为「即将到期」 */
export const SOON_THRESHOLD_DAYS = 30;

const MS_PER_DAY = 86_400_000;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Date → `YYYY-MM-DD` */
export function toDateString(d: Date): DateString {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今天（本地） */
export function today(): DateString {
  return toDateString(new Date());
}

/**
 * `YYYY-MM-DD` → 本地零点的 Date。
 * 逐段解析而非 `new Date(str)`，后者在部分引擎上按 UTC 解析会差一天。
 */
export function parseDate(s: DateString | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 两个日期串之间的整天数（to - from），忽略时分秒 */
export function daysBetween(from: DateString, to: DateString): number | null {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/**
 * 持有天数 = 今天 − 购买日期。
 * 边界：当天购买或预购（结果 ≤ 0）一律按 1 计，避免除零与天文数字。
 * 无购买日期 → null。
 */
export function holdingDays(purchaseDate: DateString | null, on: DateString = today()): number | null {
  if (!purchaseDate) return null;
  const diff = daysBetween(purchaseDate, on);
  if (diff == null) return null;
  return Math.max(1, diff);
}

/**
 * 日均成本 = 价格 ÷ max(1, 持有天数)。
 * 前提：价格与购买日期均存在且价格 > 0；任一不满足返回 null
 * （调用方必须整行/整卡隐藏，绝不显示 ¥0.00）。
 */
export function dailyCost(
  price: number | null,
  purchaseDate: DateString | null,
  on: DateString = today(),
): number | null {
  if (price == null || !(price > 0)) return null;
  const days = holdingDays(purchaseDate, on);
  if (days == null) return null;
  return price / days;
}

/** 是否「刚入手」（持有天数被下限截断的情形，即购买日 ≥ 今天） */
export function isJustAcquired(purchaseDate: DateString | null, on: DateString = today()): boolean {
  if (!purchaseDate) return false;
  const diff = daysBetween(purchaseDate, on);
  return diff != null && diff <= 0;
}

/* ------------------------------------------------------------ 到期 */

/** 计算到期状态与剩余天数。无过期日期 → none。 */
export function expiryState(
  expireDate: DateString | null,
  on: DateString = today(),
): { state: ExpiryState; days: number | null } {
  if (!expireDate) return { state: 'none', days: null };
  const days = daysBetween(on, expireDate);
  if (days == null) return { state: 'none', days: null };
  if (days < 0) return { state: 'overdue', days };
  if (days <= SOON_THRESHOLD_DAYS) return { state: 'soon', days };
  return { state: 'fine', days };
}

/** 剩余天数的中文表述 */
export function describeRemaining(days: number | null): string {
  if (days == null) return '未设置';
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天到期';
  return `还剩 ${days} 天`;
}

/**
 * 到期状态在**列表行与桌面小组件**上的短文案：「过期 8 天」「今天到期」「6 天后到期」。
 *
 * ★ 与 `describeRemaining` 是**两套措辞、故意不同**，别顺手合并：
 *   · `describeRemaining` 说「还剩 6 天」—— 给**单独看一件**的场景用，语调是说明性的；
 *   · 这一个说「6 天后到期」—— 它是个**标签**，挂在这件东西旁边，
 *     主语是物品本身而不是「剩余量」。
 *   把两者混用会让同一屏出现两种说法，用户会以为它们指的是不同的东西。
 *
 * ★ 2026-10-14 从 `ItemRow` 里搬到这里：桌面小组件要显示同一个胶囊，而 widget
 *   跑在 launcher 进程、读不到组件层的东西（且以后也不该去读）。搬出来之后
 *   列表行与桌面用的是**同一个函数** —— 这类「两处各写一遍、看着一样、
 *   改一处就分叉」的文案，是最典型的静默不一致。
 */
export function describeExpiryTag(daysToExpiry: number | null): string {
  if (daysToExpiry == null) return '';
  if (daysToExpiry < 0) return `过期 ${Math.abs(daysToExpiry)} 天`;
  if (daysToExpiry === 0) return '今天到期';
  return `${daysToExpiry} 天后到期`;
}

/**
 * 保修状态的短文案，给「到期」页的保修分组、详情页的保修标签用。
 *
 * ★ 措辞必须与 `describeExpiryTag` 明确区分开，**不许合并**：
 *   那一句说的是「到期」（保质期），这一句说的是「过保」（保修期）。
 *   同一个东西的这两件事可以差好几年；两处都写成「过期 8 天」，
 *   用户会以为是同一个日子被算了两遍。
 */
export function describeWarrantyTag(daysToWarranty: number | null): string {
  if (daysToWarranty == null) return '';
  if (daysToWarranty < 0) return `已过保 ${Math.abs(daysToWarranty)} 天`;
  if (daysToWarranty === 0) return '保修今天到期';
  return `保修还剩 ${daysToWarranty} 天`;
}

/** 在日期上加减月数，用于按分类模板推算过期时间 */
export function addMonths(dateStr: DateString, months: number): DateString {
  const d = parseDate(dateStr);
  if (!d) return dateStr;
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  // 处理 1/31 + 1 个月这类溢出：钳到目标月最后一天
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return toDateString(target);
}

/* ------------------------------------------------------------ 格式化 */

/** `2026-09-17` → `2026年9月17日` */
export function formatDateCN(s: DateString | null): string {
  const d = parseDate(s);
  if (!d) return '未设置';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** `2026-09-17` → `2026.09.17` */
export function formatDateDot(s: DateString | null): string {
  const d = parseDate(s);
  if (!d) return '未设置';
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/**
 * `2026-11-03` → `11 月 3 日`（**不带年份**）。
 *
 * 给「期限就在眼前」的场合用：桌面小组件页脚那句「下一件 · 感冒灵颗粒 · 11 月 3 日」、
 * 以及时间戳退回绝对日期时的「截至 10 月 12 日 09:12」。
 * ★ 与 `formatDateCN` 分开是**刻意的**：那个带年份（`2026年11月3日`），
 *   服务的是「存档/凭据」类场合；这里服务的是「一眼看还剩多久」，
 *   多一个年份只会把行挤满。两者不要互相改写。
 */
export function formatDateDayMonthCN(s: DateString | null): string {
  const d = parseDate(s);
  if (!d) return '';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 相对今天的自然语言描述，用于列表副标题 */
export function describePurchase(s: DateString | null): string {
  if (!s) return '未记录购买日期';
  const days = daysBetween(s, today());
  if (days == null) return '未记录购买日期';
  if (days <= 0) return '刚入手';
  if (days < 30) return `入手 ${days} 天`;
  if (days < 365) return `入手 ${Math.round(days / 30)} 个月`;
  const years = days / 365;
  return `入手 ${years < 10 ? years.toFixed(1) : Math.round(years)} 年`;
}
