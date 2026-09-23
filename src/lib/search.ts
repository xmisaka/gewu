/**
 * 格物 · 位置视图的客户端筛选
 *
 * 柜子数量是「几十」量级，不值得为搜索再走一次 SQL ——
 * 纯函数筛选既好测，也让每次按键不必等数据库往返。
 *
 * 匹配范围刻意只有「柜子名 / 柜子备注 / 格位名」：
 * 位置视图回答的是「东西放哪」，找某件具体物品是列表视图的搜索框该干的事。
 */

import type { CabinetView } from './types';

/** 归一：去两侧空白并折成小写，让大小写混写也能命中 */
function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * 按关键词筛柜子。
 *
 * - 空关键词 → 原样返回（同一个引用，避免下游无谓的重渲染）
 * - 柜子自身命中 → 保留它的全部格位
 * - 只有部分格位命中 → 只保留命中的格位，柜子仍在（否则会找不到「柜子里那一格」）
 * - 两者都没命中 → 整柜剔除
 */
export function filterCabinets(cabinets: CabinetView[], query: string): CabinetView[] {
  const q = normalize(query);
  if (!q) return cabinets;

  const matched: CabinetView[] = [];
  for (const cabinet of cabinets) {
    const cabinetHit = normalize(cabinet.name).includes(q) || normalize(cabinet.note ?? '').includes(q);
    const slots = cabinetHit
      ? cabinet.slots
      : cabinet.slots.filter((s) => normalize(s.slot.name).includes(q));

    if (!cabinetHit && slots.length === 0) continue;
    // 命中柜子名时 slots 是同一个数组，可以直接复用对象
    matched.push(cabinetHit ? cabinet : { ...cabinet, slots });
  }
  return matched;
}
