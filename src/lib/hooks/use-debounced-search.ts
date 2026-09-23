/**
 * 格物 · 搜索输入防抖
 *
 * 列表的每一次按键都会触发一次 SQLite 查询。库不大，但「输入框跟手」和
 * 「数据库少跑几趟」是可以同时要的：输入框始终是受控的原始值，
 * 只有送给查询的那个值被压了一档。
 *
 * 清空是例外 —— 用户按「清除筛选」或删光关键词时，期待的是立刻看到全量，
 * 这时候再等一档会显得界面卡住了。
 */

import { useEffect, useState } from 'react';

/** 一档的时长。够盖住连续敲字，又不至于让用户觉得延迟 */
export const SEARCH_DEBOUNCE_MS = 260;

export function useDebouncedSearch(query: string, delay: number = SEARCH_DEBOUNCE_MS): string {
  const [settled, setSettled] = useState(query);

  useEffect(() => {
    // 清空走 0 延迟：这一档若也压一拍，「清除筛选」看起来就像没反应
    const timer = setTimeout(() => setSettled(query), query.length === 0 ? 0 : delay);
    return () => clearTimeout(timer);
  }, [query, delay]);

  return settled;
}
