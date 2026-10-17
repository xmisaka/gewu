/**
 * 格物 · 财产清册 · 数据模型
 *
 * 纯函数模块：**不许** import expo / react-native / db。
 * 这样整本册子可以在 `node:test` 里生成出来比对，不用开模拟器就能验
 * 合计、转义、分页（与 `tags` / `entitlement` / `update/policy` 同一套规矩）。
 *
 * ── 金额口径（红线） ──────────────────────────────────────────
 * 合计 = `Σ price`（有价格的物品相加），**单件价、不乘数量** ——
 * 与 `lib/stats.ts` 的 `summarize()` 逐字同一个公式。清册若为了「更准」乘上数量，
 * 用户会看到清册 ¥387 对首页 ¥129，然后不再相信任何数字。
 * 数量以 `×N` 前缀标在名称前，一眼能看出「这一行只算了一件」。
 *
 * ── 册里没有的东西 ────────────────────────────────────────────
 * 序列号 / 保单号 / 现估值 / 产权人：库里没有这几列，清册**不印**。
 * 序列号那类信息只对少数高价值品有意义，为此给每件物品的表单加两行空字段，
 * 成本摊在所有用户身上 —— 所以账簿版改用「留白手填页」承接（见 html.ts 的 register 页）。
 */

import type { ItemView } from '../types';

/** 未指定分类时的名称，与列表页、统计页保持一致 */
const UNCATEGORIZED = '未分类';

/** 未指定位置时的显示值 */
const NO_LOCATION = '未指定位置';

export interface InventoryEntry {
  id: string;
  /** 连续编号（1 起），按打印顺序排定 —— 用来发现「少了一页 / 被抽走一页」 */
  no: number;
  name: string;
  /** 同批件数；null = 单件物品，不显示 */
  quantity: number | null;
  category: string;
  /** 柜 › 格；没有位置时为「—」 */
  location: string;
  /** 柜子名（没有柜子时为 ''），位置汇总页按它分组 */
  cabinet: string;
  /** `2023.05`；没记购入日时为「—」 */
  purchase: string;
  price: number | null;
}

export interface InventorySection {
  name: string;
  count: number;
  /** 记了价格的件数 */
  pricedCount: number;
  value: number;
}

export interface InventoryLocationRow {
  name: string;
  count: number;
  value: number;
}

export interface InventoryTotals {
  count: number;
  /** 记了价格的件数 —— 必须显示在册子上，否则合计会被读成「全部家当值这些」 */
  pricedCount: number;
  value: number;
  /** 没记价格的件数 = count - pricedCount */
  unpriced: number;
}

export interface InventoryModel {
  entries: InventoryEntry[];
  sections: InventorySection[];
  locations: InventoryLocationRow[];
  totals: InventoryTotals;
  /** 账簿版「高价值品登记」用：按价格取前若干件 */
  highValue: InventoryEntry[];
}

/** 中文按拼音排，避免「按码位」那种随机顺序；环境不支持时退回 localeCompare */
const collator = (() => {
  try {
    return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  } catch {
    return null;
  }
})();

function compareName(a: string, b: string): number {
  return collator ? collator.compare(a, b) : a.localeCompare(b);
}

/** `2023-05-18` → `2023.05`；空值给「—」 */
export function formatPurchaseDate(date: string | null): string {
  if (!date) return '—';
  const m = /^(\d{4})-(\d{2})/.exec(date);
  return m ? `${m[1]}.${m[2]}` : date;
}

function locationOf(item: ItemView): { location: string; cabinet: string } {
  if (!item.locationName) return { location: '—', cabinet: '' };
  // 位置本身就是柜子（没有上级）时，只显示柜名
  if (!item.cabinetName) return { location: item.locationName, cabinet: item.locationName };
  return { location: `${item.cabinetName} › ${item.locationName}`, cabinet: item.cabinetName };
}

/**
 * 建册。输入必须是**已在库物品**（`listItems()` 的结果，回收站已被 SQL 排除）。
 *
 * 排序：分类按价值降序、同价值按件数、再按名称；分类内按价格降序、
 * 没记价格的沉底、再按名称 —— 这样「翻到最后一页」看到的正好是没价格的那批，
 * 用户顺手就能补。
 */
export function buildInventory(items: readonly ItemView[]): InventoryModel {
  const rows = items.map((item) => {
    const { location, cabinet } = locationOf(item);
    return {
      id: item.id,
      name: item.name,
      quantity: item.quantity != null && item.quantity > 1 ? item.quantity : null,
      category: item.categoryName?.trim() || UNCATEGORIZED,
      location,
      cabinet,
      purchase: formatPurchaseDate(item.purchaseDate),
      price: item.price,
    };
  });

  // 分类 -> 条目
  const bySection = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = bySection.get(row.category);
    if (bucket) bucket.push(row);
    else bySection.set(row.category, [row]);
  }

  /** 分节时先留着手上的条目，最后一并交给 `sections` 与 `entries` */
  type DraftSection = InventorySection & { rows: Omit<InventoryEntry, 'no'>[] };
  const drafts: DraftSection[] = [];

  for (const [name, list] of bySection) {
    const sorted = [...list].sort((a, b) => {
      const pa = a.price ?? -1;
      const pb = b.price ?? -1;
      if (pb !== pa) return pb - pa;
      return compareName(a.name, b.name);
    });
    const value = sorted.reduce((sum, r) => sum + (r.price ?? 0), 0);
    const pricedCount = sorted.filter((r) => r.price != null).length;
    drafts.push({ name, count: sorted.length, pricedCount, value, rows: sorted });
  }

  drafts.sort((a, b) => b.value - a.value || b.count - a.count || compareName(a.name, b.name));

  const sections: InventorySection[] = drafts.map(({ rows: _rows, ...rest }) => rest);

  /**
   * ★★ 编号必须按**排好序之后**的顺序分配，不能按 Map 的插入顺序：
   * 两个分类价值都为 0 时，插入顺序与「价值降序 + 名称」的最终顺序可能相反，
   * 于是册子上的编号会跳（1,2,4,3）—— 不报错，只是看着像少了一件。
   */
  const entries: InventoryEntry[] = [];
  for (const draft of drafts) {
    for (const row of draft.rows) {
      entries.push({ ...row, no: entries.length + 1 });
    }
  }

  // 位置汇总（活页版附页）：没有位置的一律归到「未指定位置」，且排在最后
  const byLocation = new Map<string, InventoryLocationRow>();
  for (const row of entries) {
    const key = row.cabinet || NO_LOCATION;
    const hit = byLocation.get(key);
    if (hit) {
      hit.count += 1;
      hit.value += row.price ?? 0;
    } else {
      byLocation.set(key, { name: key, count: 1, value: row.price ?? 0 });
    }
  }
  const locations = [...byLocation.values()].sort((a, b) => {
    if (a.name === NO_LOCATION) return 1;
    if (b.name === NO_LOCATION) return -1;
    return b.value - a.value || compareName(a.name, b.name);
  });

  const pricedCount = entries.filter((r) => r.price != null).length;
  const totals: InventoryTotals = {
    count: entries.length,
    pricedCount,
    value: entries.reduce((sum, r) => sum + (r.price ?? 0), 0),
    unpriced: entries.length - pricedCount,
  };

  const highValue = [...entries]
    .filter((r) => r.price != null)
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))
    .slice(0, 8);

  return { entries, sections, locations, totals, highValue };
}
