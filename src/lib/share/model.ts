/**
 * 格物 · 海报数据模型
 *
 * 这一层是**纯函数**：进来 ItemView / CabinetView，出去一张海报要用的所有字符串与数字。
 * 不碰数据库、不碰 React、不碰系统能力 —— 所以整个渲染逻辑能在 Node 里跑测试，
 * 与 `lib/inventory/model.ts` 同一个理由（那本册子也是这么做到不开模拟器就能验的）。
 *
 * ★ 所有口径都在这里定一次：件数、天数、编号、日期。渲染组件只负责摆位置，
 *   不许自己再算一遍 —— 一处算错只错一处，两处算错会互相打脸。
 */

import { formatDateDot } from '../date';
import { buildMonthSeries, monthRatios } from '../stats';
import type { CabinetView, ItemView } from '../types';

import { pickQuote } from './quotes';
import type { PosterKind } from './templates';

/** 多件海报的上限。超了不缩图，直接让用户分两张 —— 12 格的缩略图墙谁都不看 */
export const POSTER_MAX_CELLS = 9;

/** 画布尺寸（dp）。导出时 3x → 1080 × 1350，与方案稿的 4:5 一致 */
export const POSTER_SIZE = { width: 360, height: 450 } as const;

export interface PosterCell {
  name: string;
  /** 缩略图相对路径，没有就是 null（渲染层显示首字块） */
  thumb: string | null;
  /** 右下角的小标注：剩 2 / 2 件。没有就不显示 */
  note: string | null;
}

export interface PosterStat {
  total: number;
  cabinetCount: number;
  slotCount: number;
  categoryCount: number;
  /** 最久一件陪了多少天，没有购买日期就是 null */
  oldestDays: number | null;
  /** 近 6 个月新增，0..1 的归一值，直接喂给柱子的高度 */
  bars: number[];
  /** 近 6 个月新增的原始件数，用于柱顶标注 */
  barCounts: number[];
  /** 口径小字，必须显示 */
  note: string;
}

export interface PosterModel {
  kind: PosterKind;
  /** 顶部小字：格物 / 这一格 / 我的收纳 · 2026 */
  eyebrow: string;
  /** 主标题。单件＝物品名，多件＝位置名或「已选 N 件」 */
  title: string;
  /** 副标题。单件＝品牌型号，多件＝分类归纳 */
  subtitle: string | null;
  /** 左下位置路径 */
  location: string | null;
  /** 编号 NO. 042。null 表示没查出来，模板会整块跳过 */
  ordinal: string | null;
  /** 「6 件」/「剩 2 件」这类计数 */
  countText: string | null;
  /** 「2021.03 · 至今 1842 天」 */
  daysText: string | null;
  /** 落款旁边的小日期 2026.10.18 */
  dateText: string;
  quote: string;
  /** 单件海报的主照片缩略图 */
  photoThumb: string | null;
  /** 多件海报的格子 */
  cells: PosterCell[];
  /** 一页账的数字，其它形态为 null */
  stat: PosterStat | null;
}

/* ------------------------------------------------------------ 小工具 */

function pad3(n: number): string {
  return n < 10 ? `00${n}` : n < 100 ? `0${n}` : String(n);
}

/**
 * 「第几件」。
 *
 * 用**录入顺序**数，含回收站 —— 按在库数数的话，删掉一件会让所有编号往前窜，
 * 用户会看到自己那张海报上的编号变了。编号是个纪念性的东西，不能漂。
 */
export function formatOrdinal(n: number | null): string | null {
  if (n == null || n <= 0) return null;
  return `NO. ${pad3(n)}`;
}

/** 购买年月 → 「2021.03」。没有日期返回 null */
export function formatPurchaseMonth(purchaseDate: string | null): string | null {
  if (!purchaseDate) return null;
  const dot = formatDateDot(purchaseDate);
  if (dot === '未设置') return null;
  return dot.slice(0, 7);
}

/**
 * 「2021.03 · 至今 1842 天」。
 *
 * ★ 天数为 0 时写「刚入手」而不是「至今 0 天」—— 后者读起来像出了错。
 * ★ 超过 3650 天就切到年，否则四位数会把这行撑开。
 */
export function formatDaysLine(purchaseDate: string | null, holdingDays: number | null): string | null {
  const month = formatPurchaseMonth(purchaseDate);
  if (!month || holdingDays == null) return null;
  if (holdingDays <= 0) return `${month} · 刚入手`;
  if (holdingDays >= 3650) return `${month} · 至今 ${(holdingDays / 365).toFixed(0)} 年`;
  return `${month} · 至今 ${holdingDays} 天`;
}

/** 位置路径：柜 · 格。只有一级时不带分隔符 */
export function locationPath(cabinetName: string | null, locationName: string | null): string | null {
  if (cabinetName && locationName) return `${cabinetName} · ${locationName}`;
  return cabinetName ?? locationName ?? null;
}

/** 品牌型号：「SONY · WH-1000XM4」。两边都空就返回 null，别让模板留一行空白 */
export function brandLine(brand: string | null, model: string | null): string | null {
  const b = brand?.trim();
  const m = model?.trim();
  if (b && m && b !== m) return `${b} · ${m}`;
  return b || m || null;
}

/** 库存口径与详情页一致：只有启用了数量才显示 */
export function quantityText(quantity: number | null): string | null {
  if (quantity == null) return null;
  if (quantity === 0) return '用完了';
  return `剩 ${quantity} 件`;
}

/** 今天 → 2026.10.18 */
function stamp(now: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${now.getFullYear()}.${p(now.getMonth() + 1)}.${p(now.getDate())}`;
}

/**
 * 一张海报里会渲染几张照片。页面用它判断「能不能抓图了」——
 * 照片是异步加载的，抓早了就是一张空框海报。
 */
export function photoCountOf(model: PosterModel): number {
  if (model.photoThumb) return 1;
  return model.cells.filter((c) => !!c.thumb).length;
}

/* ------------------------------------------------------------ 单件 */

export function buildSinglePoster(
  item: ItemView,
  ordinal: number | null,
  now: Date = new Date(),
): PosterModel {
  return {
    kind: 'single',
    eyebrow: '格物',
    title: item.name,
    subtitle: brandLine(item.brand, item.model),
    location: locationPath(item.cabinetName, item.locationName),
    ordinal: formatOrdinal(ordinal),
    countText: quantityText(item.quantity),
    daysText: formatDaysLine(item.purchaseDate, item.holdingDays),
    dateText: stamp(now),
    quote: pickQuote(item.id),
    photoThumb: item.coverThumb,
    cells: [],
    stat: null,
  };
}

/* ------------------------------------------------------------ 多件 */

/**
 * 多件的标题怎么定。
 *
 * 三条递降规则：同一格 → 用格名；同一柜 → 用柜名；跨柜 → 「已选 N 件」。
 * 不做「取第一个的位置」—— 那句会是错的，而且错得看不出来。
 */
export function multiTitle(items: ItemView[]): string {
  if (items.length === 0) return '空';
  const first = items[0];
  const sameCabinet = items.every((i) => i.cabinetName === first.cabinetName);
  const sameSlot = items.every((i) => i.locationName === first.locationName);
  if (sameCabinet && sameSlot) {
    return locationPath(first.cabinetName, first.locationName) ?? `已选 ${items.length} 件`;
  }
  if (sameCabinet && first.cabinetName) return first.cabinetName;
  return `已选 ${items.length} 件`;
}

/** 多件的副标题：分类归纳，最多两个，多了就是噪音 */
export function multiSubtitle(items: ItemView[]): string | null {
  const names: string[] = [];
  for (const it of items) {
    const n = it.categoryName;
    if (n && !names.includes(n)) names.push(n);
    if (names.length === 3) break;
  }
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(' · ');
  return `${names[0]} 等 ${names.length} 类`;
}

export function buildMultiPoster(items: ItemView[], now: Date = new Date()): PosterModel {
  const cells: PosterCell[] = items.slice(0, POSTER_MAX_CELLS).map((it) => ({
    name: it.name,
    thumb: it.coverThumb,
    note: it.quantity != null && it.quantity > 1 ? `${it.quantity}` : null,
  }));

  const title = multiTitle(items);

  return {
    kind: 'multi',
    /* 「这一格」只在真的落到同一格时才成立。跨柜时写「这几件」——
       写「这一格」而下面列着三个柜子的东西，是那种一眼看出不对、
       又说不清哪儿不对的错。 */
    eyebrow: title.startsWith('已选') ? '这几件' : '这一格',
    title,
    subtitle: multiSubtitle(items),
    location: null,
    ordinal: null,
    countText: `${items.length} 件`,
    daysText: null,
    dateText: stamp(now),
    quote: pickQuote(items[0]?.id ?? 'gewu'),
    photoThumb: null,
    cells,
    stat: null,
  };
}

/* ------------------------------------------------------------ 统计 */

/**
 * 一页账。
 *
 * 数据全部来自 `stats.ts` 的现成口径，不新增算法：
 * 件数用 items.length（与统计页同一个列表），柜子数用传进来的 cabinets，
 * 月份趋势用 `buildMonthSeries` + `monthRatios`。
 *
 * ★ 口径小字必须显示。海报是唯一一次把这些数字对外输出，
 *   不显示的代价不是不精确，是被截图挂出来时无法自证。
 */
export function buildStatPoster(
  items: ItemView[],
  cabinets: CabinetView[],
  now: Date = new Date(),
): PosterModel {
  const total = items.length;
  const slotCount = cabinets.reduce((sum, c) => sum + c.slots.length, 0);

  const categorySet = new Set<string>();
  let oldestDays: number | null = null;
  for (const it of items) {
    if (it.categoryName) categorySet.add(it.categoryName);
    if (it.holdingDays != null && (oldestDays == null || it.holdingDays > oldestDays)) {
      oldestDays = it.holdingDays;
    }
  }

  const series = buildMonthSeries(items, now, 6);
  const ratios = monthRatios(series);
  const barCounts = series.map((b) => b.count);

  return {
    kind: 'stat',
    eyebrow: `我的收纳 · ${now.getFullYear()}`,
    title: String(total),
    subtitle: null,
    location: null,
    ordinal: null,
    countText: null,
    daysText: oldestDays != null ? `最久的一件 ${oldestDays} 天` : null,
    dateText: stamp(now),
    quote: pickQuote('stat'),
    photoThumb: null,
    cells: [],
    stat: {
      total,
      cabinetCount: cabinets.length,
      slotCount,
      categoryCount: categorySet.size,
      oldestDays,
      bars: ratios,
      barCounts,
      note: '近 6 个月新增 · 仅统计在库物品',
    },
  };
}

/* ------------------------------------------------------------ 版式档位 */

/**
 * 多件的列数。1–4 件两列、5–9 件三列。
 *
 * 不做等比缩放：四件摊成 3 列会剩一个空格，九件挤成 2 列会让每格小到认不出。
 * 这是两套版式，不是同一个版式的两个尺寸。
 */
export function gridColumns(count: number): 2 | 3 {
  return count <= 4 ? 2 : 3;
}

/** 超出上限时给用户的话。调用方决定怎么展示，模型只负责说清楚 */
export function overflowHint(count: number): string | null {
  if (count <= POSTER_MAX_CELLS) return null;
  return `最多 ${POSTER_MAX_CELLS} 件，剩下的可以分两张`;
}
