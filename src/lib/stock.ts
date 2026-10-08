/**
 * 格物 · 库存纯函数
 *
 * 为什么单独抽一个文件：这几条规则**判错了不会报错**。
 * 「0 再减一件」会变成负数、「null 混进加减」会变成 NaN、
 * 「用完」与「没启用库存」混淆会让一行永久显示 0 —— 出错时界面只是安静地
 * 显示一个错数字，没有异常、没有红屏，只能靠单测兜住（见 tests/pure.test.mjs）。
 *
 * 三条语义边界（与 PRD 例外条款一起钉死，改之前先读）：
 *   1. `quantity === null` 是「单件物品、不启用库存」，**不是 0**。
 *      两者在界面上完全是两回事：前者什么都不显示，后者显示「用完了」。
 *   2. `quantity === 0` 是派生态，不是删除、不是状态机字段。
 *   3. 数量变化**不动 `updated_at`** —— 那是内容编辑的时间戳，
 *      拿它记库存周转会让首页「最近变动」排序被「用完一瓶酱油」反复打乱。
 */

import type { StockState } from './types';

/**
 * 剩几件算「即将见底」。
 *
 * 只把「只剩最后一件」算进去：用户真正会因此起身去买的是这个时刻，
 * 剩 2 件就报警只会让人把提示当噪音，久而久之整条链都失效。
 */
export const LOW_STOCK_THRESHOLD = 1;

/** 是否启用了库存。列表、详情、到期页都拿它决定「渲不渲染库存元素」 */
export function isStockEnabled(quantity: number | null | undefined): boolean {
  return typeof quantity === 'number' && Number.isFinite(quantity);
}

/**
 * 数量 → 状态。四档分界写在一处，界面只认这个结果，不自己判「是不是快没了」。
 */
export function stockState(quantity: number | null | undefined): StockState {
  if (!isStockEnabled(quantity)) return 'none';
  const n = quantity as number;
  if (n <= 0) return 'empty';
  if (n <= LOW_STOCK_THRESHOLD) return 'low';
  return 'ok';
}

/**
 * 把界面上来的原始数字收拾成合法数量：取整、夹到 0 以上。
 *
 * 表单里用户完全可能输入 `-3` 或 `2.5`，两者都不该原样落库 ——
 * 「剩 -3」这种数字一上屏就会被当成数据损坏，而它既不报错也不触发任何告警。
 * 加法与直接设定两条路径共用这一个夹取，避免出现「加着不会负、写着会负」的分叉。
 */
export function normalizeQuantity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  return n < 0 ? 0 : n;
}

/**
 * 加减一件之后的新数量。
 *
 * ★ 先读后写，绝不在 SQL 里写 `quantity - 1`：
 *   一个是**永远不会为负**（0 再减还是 0），另一个是「用完了再点一下变成 −1」，
 *   而 −1 件会让「剩 −1」这种数字直接上屏。
 *   同一个理由也让调用方顺手拿到旧值，撤销要用。
 *
 * `null` 原样返回：单件物品没有「用掉一件」这回事，调用方应在此之前拦住。
 */
export function nextQuantity(quantity: number | null, delta: number): number | null {
  if (!isStockEnabled(quantity)) return null;
  return normalizeQuantity((quantity as number) + delta);
}

/**
 * 数量 → 显示文案。空串表示「什么都不该显示」，
 * 调用方据此决定整块要不要渲染 —— 别把 `null` 渲染成「剩 0」。
 */
export function stockLabel(quantity: number | null | undefined): string {
  const state = stockState(quantity);
  if (state === 'none') return '';
  if (state === 'empty') return '用完了';
  return `剩 ${quantity}`;
}

/**
 * 数量 → 状态词，给「库存」卡的右上角用。
 *
 * 与 stockLabel 分开的理由：胶囊上写「剩 2」是把数字一起说了，
 * 而卡片下方已经有一个大大的 2，同一句话再说一遍纯属重复 ——
 * 那里要的只是「即将见底」这样的一个词。
 */
export function stockStateText(quantity: number | null | undefined): string {
  const state = stockState(quantity);
  if (state === 'none') return '';
  if (state === 'empty') return '已用完';
  if (state === 'low') return '即将见底';
  return '还有余量';
}
