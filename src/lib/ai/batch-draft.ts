/**
 * 格物 · 批量识图的「详细编辑」跨页槽（模块级 · 内存态 · 一次性）
 *
 * 清单页 → 编辑页要带一条条目的初值，编辑页 → 清单页要带回改完的值。
 * expo-router 的 params 只适合传短字符串，而一份种子（含备注、标签）可能几百字节；
 * 把整份清单塞进 params 更不现实。
 *
 * 所以用两个槽，语义刻意不同：
 *   · `editing` —— **peek + 显式 clear**。编辑页要能重复读（每次渲染都能拿到），
 *     所以不能「取走即清空」：那会让 `useState(() => take())` 在严格模式下
 *     第二次拿到 null 而白屏。清空交给编辑页 unmount。
 *   · `result` —— **取走即清空**。清单页只在 focus 时取一次；取走就应用，
 *     多留一会儿反而会在下次进页面时被误当成新结果。
 *
 * ★ 是内存态、不落库 —— 与「批量不做跨会话恢复」同一条口径：
 *   退出这条链路就等于放弃，没保存的条目本来也不该在下次冷启动时冒出来。
 *
 * 不 import expo / react-native / db，纯数据，可进测试。
 */

import type { BatchEditSeed, BatchPhoto } from './batch';

export interface EditSlot {
  key: string;
  seed: BatchEditSeed;
  /** 那一件的照片（相对路径）—— 编辑页顶部拿缩略图做参照，免得改错条 */
  photo?: BatchPhoto | null;
}

let editing: EditSlot | null = null;
let result: EditSlot | null = null;

/** 跳页前写入（清单页） */
export function putEditing(slot: EditSlot): void {
  editing = slot;
}

/** 纯读，不清空 —— 编辑页每次渲染都可以拿 */
export function peekEditing(): EditSlot | null {
  return editing;
}

/** 编辑页 unmount 时清。不清的话，下次深链进来会拿到上一条的残留 */
export function clearEditing(): void {
  editing = null;
}

/** 编辑页提交后写入 */
export function putEditResult(slot: EditSlot): void {
  result = slot;
}

/** 清单页 focus 时取走 —— 拿到即清空 */
export function takeEditResult(): EditSlot | null {
  const v = result;
  result = null;
  return v;
}
