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
