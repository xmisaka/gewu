/**
 * 免费档件数闸门（UI 侧入口）
 *
 * 新增物品的路径有**四条**：录入页、批量识图、语音录入、复制一件。
 * 判定逻辑只在 `lib/entitlement.ts` 的 `checkNewItems`（纯逻辑、可测），
 * 这里只负责把「当前件数」和「当前档位」两样东西凑齐 —— 凑的这几行
 * 抄四遍必然会有一处忘记改（比如以后调限额），所以收成一处。
 *
 * ★ 件数每次现查 `countItems()`，不读 store 里的 stats：后者只在
 *   `dataVersion` 变化后重算，连续录入时差一步，闸门会悄悄多放几件。
 * ★ 判完**只返回结论**，不弹任何东西 —— 四处场景的呈现方式不一样：
 *   录入页是弹窗，批量页是列表下方的提示，语音页在自己的结果区里说。
 *   这也是为什么它返回 verdict 而不是抛错。
 */

import { useCallback } from 'react';

import { countItems } from '@/lib/db/items';
import { checkNewItems, type QuotaVerdict } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/store/entitlement';

export function useQuotaGuard(): (want: number) => Promise<QuotaVerdict> {
  const { entitled } = useEntitlement();
  return useCallback(
    async (want: number) => checkNewItems(await countItems(), want, entitled),
    [entitled],
  );
}
