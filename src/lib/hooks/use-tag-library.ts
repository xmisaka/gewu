/**
 * 格物 · 标签候选的加载与全局改写
 *
 * 两件容易写漏的事收在这一个地方：
 *  1. 应用一次全局改写之后**必须重取候选** —— 否则改完名，列表里旧名字还在，
 *     用户会以为没改成功，再点一次（而那次点击作用在一个已经不存在的标签上，静默无效果）。
 *  2. 「在哪里用选择器」不该决定「候选从哪来」：录入页、编辑页、筛选器共用这一份。
 *
 * 候选是**算出来的**（见 lib/tags.ts），不落库、不缓存到 meta —— 每次进页面重算，
 * 几百件物品的一次全表扫，比维护一份可能过期的缓存便宜也更不容易错。
 */

import { useCallback, type DependencyList } from 'react';

import { listTagCounts, rewriteTags } from '@/lib/db/items';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import type { TagCount, TagTransform } from '@/lib/tags';

export interface TagLibrary {
  tags: TagCount[];
  loading: boolean;
  /** 重命名 / 合并 / 删除，跨全部物品生效；完成后自动刷新候选 */
  manage: (transform: TagTransform) => Promise<void>;
  /** 手动重新取候选 */
  reload: () => void;
}

/**
 * @param deps 候选需要跟着一起刷新的外部条件。列表页要传 `[dataVersion]` ——
 *   否则新增一件带新标签的物品后，筛选器里还是旧的那份候选（**不报错**，
 *   只是「我明明加过这个标签，怎么选不到」）。
 */
export function useTagLibrary(deps: DependencyList = []): TagLibrary {
  const state = useAsyncData(() => listTagCounts(), deps, [] as TagCount[]);
  const reload = state.reload;

  const manage = useCallback(
    async (transform: TagTransform) => {
      await rewriteTags(transform);
      reload();
    },
    [reload],
  );

  return { tags: state.data, loading: state.loading, manage, reload };
}
