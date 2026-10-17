/**
 * 格物 · 分享清单（纯文本）
 *
 * 与海报是同一条产品线的两面：
 *   海报给「看」，文本给「用」—— 能勾、能复制、能进购物车、能在微信里被引用回复。
 *   家人问「充电线在哪」时，一张图解决；「酱油没了帮我带一瓶」时，只有文本能解决。
 *
 * 规矩：
 *   ① 不走任何链接、不上传，只经系统分享面板（与 PRD §11 的三条红线一致）。
 *   ② 分隔不用破折号，用空行 —— 微信里破折号会粘成一条灰线，很难看。
 *   ③ 位置写在同一行的括号里，不换行：换行后一条物品占三行，十件就刷屏。
 */

import type { ItemView } from '../types';

import { locationPath, multiTitle } from './model';

/** 单条：「老抽酱油（厨房 · 调料架，剩 2 件）」 */
function lineOf(item: ItemView): string {
  const where = locationPath(item.cabinetName, item.locationName);
  const bits: string[] = [];
  if (where) bits.push(where);
  if (item.quantity != null && item.quantity > 1) bits.push(`剩 ${item.quantity} 件`);
  if (bits.length === 0) return `· ${item.name}`;
  return `· ${item.name}（${bits.join('，')}）`;
}

/**
 * 生成一段可以直接发出去的清单。
 *
 * 顶部一行说清这是什么，末尾一行说清从哪来 —— 转发几次之后，
 * 中间那几句会脱离上下文，这两行是唯一还能解释它的东西。
 */
export function buildListText(items: ItemView[]): string {
  if (items.length === 0) return '';
  const title = multiTitle(items);
  const body = items.map(lineOf).join('\n');
  return `${title}\n\n${body}\n\n来自格物 · 收纳柜`;
}
