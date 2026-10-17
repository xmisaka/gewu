/**
 * 格物 · 财产清册 · 分页
 *
 * 为什么自己分页，而不是交给 WebView 自然流：
 *   ① `printToFileAsync` 返回的 `numberOfPages` 是**估算**
 *      （安卓侧是 `1 + contentHeight / pageHeight`），不能当页数用；
 *   ② Chromium / WebView 打印**不支持 `@page` 的页边盒**，`counter(page)` 静默失效，
 *      页脚「第 N 页 / 共 M 页」根本印不出来。
 * 所以页数在生成 HTML 时就必须是已知量 —— 这就是本文件存在的理由。
 *
 * 分页单位（unit）里，**分组标题也占一行**：只有把标题计入行数，
 * 每页高度才是可算的定值。代价是标题行与数据行等高，视觉上靠底色与字重区分。
 */

import type { InventoryEntry, InventoryModel, InventorySection } from './model';

export type DetailUnit =
  | { kind: 'group'; section: InventorySection }
  | { kind: 'item'; entry: InventoryEntry };

/** 把整册摊平成一串「行」：每个分类一个标题行，后面跟它的条目 */
export function buildDetailUnits(model: InventoryModel): DetailUnit[] {
  const units: DetailUnit[] = [];
  const bySection = new Map<string, InventoryEntry[]>();
  for (const entry of model.entries) {
    const bucket = bySection.get(entry.category);
    if (bucket) bucket.push(entry);
    else bySection.set(entry.category, [entry]);
  }
  // 顺序严格跟随 model.sections（已按价值降序），不重新排序 —— 否则标题与条目会对不上
  for (const section of model.sections) {
    units.push({ kind: 'group', section });
    for (const entry of bySection.get(section.name) ?? []) {
      units.push({ kind: 'item', entry });
    }
  }
  return units;
}

/**
 * 按每页行数切页。
 *
 * ★ 分组标题**不允许落在一页的最后一行**：那样读者会看到「房产与车位」孤零零挂在页底，
 * 它的条目全在下一页，翻页前根本不知道这一节是什么。
 * 遇到这种情况把标题挪到下一页开头（下一页先放标题、再放条目，仍然连续）。
 */
export function paginateDetails(
  units: readonly DetailUnit[],
  rowsPerPage: number,
): DetailUnit[][] {
  const perPage = Math.max(1, Math.floor(rowsPerPage));
  const pages: DetailUnit[][] = [];
  let current: DetailUnit[] = [];

  for (const unit of units) {
    if (current.length >= perPage) {
      const last = current[current.length - 1];
      // 标题被挤到页底 → 搬到下一页（下一页用它开头）。
      // `current.length > 1` 这个条件是必要的：整页只有这一个标题时搬走会留下空页。
      if (last && last.kind === 'group' && current.length > 1) {
        current.pop();
        pages.push(current);
        current = [last];
      } else {
        pages.push(current);
        current = [];
      }
    }
    current.push(unit);
  }
  if (current.length > 0) pages.push(current);

  return pages;
}

/**
 * 整册总页数 = 封面 1 + 明细若干 + 末页附页若干。
 * 页码与「共 M 页」都用这个数，**不用** `printToFileAsync` 返回的估算值。
 */
export function totalPagesOf(detailPages: number, extraPages: number): number {
  return 1 + detailPages + extraPages;
}
