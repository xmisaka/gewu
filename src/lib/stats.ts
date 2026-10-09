/**
 * 格物 · 统计聚合（纯逻辑，不 import expo / react-native / db）
 *
 * 这一页要回答四件事：钱花在哪、每天在烧多少、柜子塞到几成、最近半年买得多了还是少了。
 * 全部从**已有字段**算出来，零 schema 变更：
 *   price / purchaseDate / categoryName / Cabinet.slots / createdAt。
 *
 * ── 三条必须守住的口径 ─────────────────────────────────────
 *
 * ★ 日均成本**不在这里重写公式**，一律用 `ItemView.dailyCost`（它由 date.ts 的
 *   `dailyCost()` 算出）。同一件东西在详情页成本卡与统计页必须是同一个数 ——
 *   只要有一处忘了 `max(1, days)` 下限，两页就会差出一天的钱，而用户一定会去对。
 *
 * ★ 排行条一律「**以最大值为满格**」，不是占比。全是小类目时，按占比每根条都短得
 *   看不出差别，排行就失去了意义（占比只对「合计 100%」有意义）。
 *
 * ★ 「其余 N 类」是**汇总项不是选手**：永远排在最后、数字转灰。插在中间会打断
 *   「谁最烧钱」的阅读顺序。
 */

import type { CabinetView, ItemView } from './types';

/** 无分类的归类名。与录入页的兜底文案一致（suggest.ts 的同名常量）。 */
const UNCATEGORIZED = '未分类';

/** 中文排序：与列表、标签候选同一套规则，保证「同频次时谁在前」可预期 */
const collator = (() => {
  try {
    return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  } catch {
    return null;
  }
})();

function byLabel(a: string, b: string): number {
  return collator ? collator.compare(a, b) : a.localeCompare(b);
}

/* ------------------------------------------------------------ 顶部总览 */

export interface StatsSummary {
  /** 在库件数 */
  total: number;
  /** 有价格的物品的价值合计 */
  totalValue: number;
  /** 参与 totalValue 的件数 —— 口径必须显示在界面上 */
  pricedCount: number;
  /** 日均持有成本合计（只算价格与购买日期齐备的） */
  dailyTotal: number;
  /** 参与 dailyTotal 的件数 */
  dailySampleCount: number;
}

export function summarize(items: ItemView[]): StatsSummary {
  let totalValue = 0;
  let pricedCount = 0;
  let dailyTotal = 0;
  let dailySampleCount = 0;

  for (const it of items) {
    if (it.price != null) {
      totalValue += it.price;
      pricedCount += 1;
    }
    if (it.dailyCost != null) {
      dailyTotal += it.dailyCost;
      dailySampleCount += 1;
    }
  }

  return { total: items.length, totalValue, pricedCount, dailyTotal, dailySampleCount };
}

/* ------------------------------------------------------------ 钱花在哪 */

export interface ValueBar {
  label: string;
  value: number;
  /** 相对**最大值**的比例（0～1），不是占总额的百分比 */
  ratio: number;
}

export interface ValueBars {
  bars: ValueBar[];
  /** 「其余 N 类」；没有剩余时为 null */
  restLabel: string | null;
  restValue: number;
  restRatio: number;
  /** 满格基准 */
  max: number;
  total: number;
}

/**
 * 分类维度的价值分布。
 *
 * @param topN 榜单取前几名；其余合并成一行汇总项
 */
export function buildValueBars(items: ItemView[], topN = 5): ValueBars {
  const sums = new Map<string, number>();
  for (const it of items) {
    if (it.price == null) continue;
    const key = it.categoryName?.trim() || UNCATEGORIZED;
    sums.set(key, (sums.get(key) ?? 0) + it.price);
  }

  const sorted = [...sums.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || byLabel(a.label, b.label));

  const total = sorted.reduce((sum, row) => sum + row.value, 0);
  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);

  // 满格基准取「榜首」，不是 total —— 见文件头注释
  const max = head.length > 0 ? head[0].value : 0;
  const ratioOf = (v: number) => (max > 0 ? Math.min(1, v / max) : 0);

  const restValue = tail.reduce((sum, row) => sum + row.value, 0);

  return {
    bars: head.map((row) => ({ label: row.label, value: row.value, ratio: ratioOf(row.value) })),
    restLabel: tail.length > 0 ? `其余 ${tail.length} 类` : null,
    restValue,
    restRatio: ratioOf(restValue),
    max,
    total,
  };
}

/* ------------------------------------------------------------ 每天在烧多少钱 */

export interface DailyCostRow {
  id: string;
  name: string;
  dailyCost: number;
  /** 持有天数。摆出来用户才分得清「贵」还是「刚买」 */
  holdingDays: number;
}

export interface DailyCostRank {
  rows: DailyCostRow[];
  /** 全部有日均成本的物品合计 */
  totalPerDay: number;
  sampleCount: number;
}

/**
 * 日均持有成本 TOP N。
 *
 * 缺价格或缺购买日期的物品整行不出现 —— 绝不显示 ¥0.00 / 天（与详情页同一条规矩）。
 */
export function rankDailyCost(items: ItemView[], topN = 5): DailyCostRank {
  const rows: DailyCostRow[] = [];
  let totalPerDay = 0;

  for (const it of items) {
    if (it.dailyCost == null) continue;
    totalPerDay += it.dailyCost;
    rows.push({
      id: it.id,
      name: it.name,
      dailyCost: it.dailyCost,
      // dailyCost 非空即意味着持有天数已算出；?? 1 只是给类型一个兜底
      holdingDays: it.holdingDays ?? 1,
    });
  }

  rows.sort((a, b) => b.dailyCost - a.dailyCost || byLabel(a.name, b.name));

  return { rows: rows.slice(0, topN), totalPerDay, sampleCount: rows.length };
}

/* ------------------------------------------------------------ 柜子占用 */

export interface CabinetUsage {
  id: string;
  name: string;
  totalSlots: number;
  occupiedSlots: number;
  /** 直接挂柜 + 各格位合计 */
  totalCount: number;
  /**
   * 原始格位列表。带上它是为了让页面能用 `SlotDots` 画**和柜子页一模一样的方块** ——
   * 只回传两个计数的话，页面就只能退回画进度条，两页的画法就分家了。
   */
  slots: CabinetView['slots'];
}

/**
 * 柜子按**占用率**排行，不按件数。
 *
 * 12 格里放 8 件的柜子，比 6 格里放 5 件的柜子更空；按件数排会把最大的柜子永远顶在
 * 第一名，而那不是「该收拾了」的意思。
 * 没有格位的柜子不参与 —— 占用率对它没有定义（0/0），放进来只会显示成一根空条。
 */
export function rankCabinets(cabinets: CabinetView[], topN = 4): CabinetUsage[] {
  return cabinets
    .filter((c) => c.slots.length > 0)
    .map((c) => ({
      id: c.id,
      name: c.name,
      totalSlots: c.slots.length,
      occupiedSlots: c.occupiedSlots,
      totalCount: c.totalCount,
      slots: c.slots,
    }))
    .sort((a, b) => {
      const ra = a.occupiedSlots / a.totalSlots;
      const rb = b.occupiedSlots / b.totalSlots;
      if (rb !== ra) return rb - ra;
      // 占用率相同时，格位多的排前面（大柜子更值得先收拾）
      if (b.totalSlots !== a.totalSlots) return b.totalSlots - a.totalSlots;
      return byLabel(a.name, b.name);
    })
    .slice(0, topN);
}

/* ------------------------------------------------------------ 最近半年 */

export interface MonthBucket {
  /** `2026-9`，用于对齐 */
  key: string;
  /** `9 月` */
  label: string;
  /** 当月入库件数 */
  count: number;
}

/**
 * 最近 N 个月的新增件数，按**入库时间**（createdAt）分组。
 *
 * 不用购买日期：它大量为空，用它分组趋势会缺一大块，柱子看着像「买得很少」——
 * 其实是「没填」。入库时间人人都有。
 *
 * @param now 由调用方传入（默认取当前时刻），便于测试固定时间轴
 */
export function buildMonthSeries(items: ItemView[], now: Date, months = 6): MonthBucket[] {
  const buckets: (MonthBucket & { year: number; month: number })[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    buckets.push({
      key: `${d.getFullYear()}-${d.getMonth() + 1}`,
      label: `${d.getMonth() + 1} 月`,
      count: 0,
      year: d.getFullYear(),
      month: d.getMonth() + 1,
    });
  }

  const index = new Map(buckets.map((b) => [b.key, b]));

  for (const it of items) {
    const d = new Date(it.createdAt);
    const bucket = index.get(`${d.getFullYear()}-${d.getMonth() + 1}`);
    if (bucket) bucket.count += 1;
  }

  return buckets.map((b) => ({ key: b.key, label: b.label, count: b.count }));
}

/** 柱状图的高度比例（相对最高的一根）；全为 0 时返回一列 0 */
export function monthRatios(buckets: MonthBucket[]): number[] {
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  return buckets.map((b) => (max > 0 ? b.count / max : 0));
}

/**
 * 「买得最多的是 9 月，41 件」这类读法。
 *
 * 比让用户自己数柱子强 —— 那一段的用途是一句结论，不是一道题。
 * 一件都没新增时返回 null（页面就不显示这句）。
 */
export function describePeak(buckets: MonthBucket[]): { label: string; count: number } | null {
  let peak: MonthBucket | null = null;
  for (const b of buckets) {
    if (b.count === 0) continue;
    if (!peak || b.count > peak.count) peak = b;
  }
  return peak ? { label: peak.label, count: peak.count } : null;
}
