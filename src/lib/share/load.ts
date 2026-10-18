/**
 * 格物 · 海报取数
 *
 * 这一层只做「从库里捞出数据 → 交给纯函数模型」，不碰渲染也不碰系统能力。
 * 拆出来是为了让 `model.ts` 保持零依赖，同时让页面不必自己拼 SQL。
 */

import { getItemView, listItems, ordinalOf } from '@/lib/db/items';
import { listCabinetViews } from '@/lib/db/locations';
import type { ItemView } from '@/lib/types';

import { buildListText } from './list-text';
import {
  buildMultiPoster,
  buildSinglePoster,
  buildStatPoster,
  POSTER_MAX_CELLS,
  type PosterModel,
} from './model';

/** 海报入口的两种来源：指定物品（含单件与多选）/ 全屋统计 */
export type PosterSource = { kind: 'ids'; ids: string[] } | { kind: 'stat' };

/**
 * 取数并建模型。
 *
 * ★ 多选超过 9 件时**只取前 9 件**，不报错 —— 入口那边已经拦过一次，
 *   这里兜底是为了防止将来别的入口直接拼 ids 进来。少画几件比打不开页面好。
 * ★ 单件用 `getItemView`，多件也用 `getItemView` 逐个取而不是 `listItems` 全量筛：
 *   多选通常只有几件，全量列表在 1000 件的库上要多走一遍排序。
 */
export async function loadPosterModel(source: PosterSource): Promise<PosterModel> {
  if (source.kind === 'stat') {
    const [items, cabinets] = await Promise.all([listItems(), listCabinetViews()]);
    return buildStatPoster(items, cabinets);
  }

  const ids = source.ids.slice(0, POSTER_MAX_CELLS);
  if (ids.length === 0) throw new Error('没有要分享的物品');

  const views = await Promise.all(ids.map((id) => getItemView(id)));
  const found = views.filter((v): v is ItemView => v != null);
  if (found.length === 0) throw new Error('这些物品已经不在了');

  if (found.length === 1) {
    const ordinal = await ordinalOf(found[0].id);
    return buildSinglePoster(found[0], ordinal);
  }

  return buildMultiPoster(found);
}

/**
 * 文字清单取数（海报页「只发文字清单」用）。
 *
 * ★ 不设 9 件上限 —— 海报的格子有画布边界，文本没有；
 *   多选 20 件就出 20 行的清单，这正是文本存在的意义。
 *   与 loadPosterModel 的「少画几件比打不开页面好」是两个方向，别共用一个函数。
 */
export async function loadListText(ids: string[]): Promise<string> {
  const views = await Promise.all(ids.map((id) => getItemView(id)));
  const found = views.filter((v): v is ItemView => v != null);
  return buildListText(found);
}
