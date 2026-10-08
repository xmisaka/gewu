/**
 * 格物 · 权益运行时
 *
 * 与主题运行时同构：Provider 持有当前档位，组件靠 `useEntitlement()` 订阅。
 *
 * 为什么必须是 hook、不能是模块级变量：激活成功要让**全应用**立刻换档 ——
 * 主题选择器里的锁、设置页的状态行、门控浮层都得跟着变，
 * 而模块级变量不会通知 React 重渲染（换肤那条坑同理）。
 *
 * 未读完库之前一律按免费档渲染，**不做「加载中」**：
 * 读一次 meta 是本地毫秒级操作，为它放一个骨架屏，反而会让每次冷启动都闪一下。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { saveEntitlementCode, loadEntitlement } from '@/lib/db/license';
import {
  checkActivation,
  FREE_ENTITLEMENT,
  type ActivationCheck,
  type Entitlement,
} from '@/lib/entitlement';

export interface EntitlementValue {
  entitlement: Entitlement;
  /** 是否已解锁支持者功能。门控一律读它，别读 entitlement.edition */
  entitled: boolean;
  /** 首次读库是否完成。只用于区分「真的没激活」与「还没读出来」，界面通常不用管 */
  ready: boolean;
  /** 校验通过才落库；失败原样返回原因，由调用方决定怎么显示 */
  activate: (code: string) => Promise<ActivationCheck>;
  /** 重新读一遍库（激活页返回时用得上） */
  refresh: () => Promise<void>;
}

const EntitlementContext = createContext<EntitlementValue | null>(null);

export function EntitlementProvider({ children }: { children: ReactNode }) {
  const [entitlement, setEntitlement] = useState<Entitlement>(FREE_ENTITLEMENT);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setEntitlement(await loadEntitlement());
    } catch {
      // 库还没热起来时先按免费档走：宁可不给，也不能默认可疑地放行
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 本 Provider 存在的理由就是启动时把档位读进来
    void refresh();
  }, [refresh]);

  /**
   * 先验签、验通了才落库。这个顺序不能反 —— 先存后验会让「存进去了但没生效」
   * 变成一个需要排查的状态，而激活码是不可编辑的长字符串，用户看不出哪一位粘错了。
   */
  const activate = useCallback(async (code: string) => {
    const outcome = checkActivation(code);
    if (outcome.kind === 'ok') {
      await saveEntitlementCode(outcome.entitlement.code ?? '');
      setEntitlement(outcome.entitlement);
    }
    return outcome;
  }, []);

  const value = useMemo<EntitlementValue>(
    () => ({ entitlement, entitled: entitlement.entitled, ready, activate, refresh }),
    [entitlement, ready, activate, refresh],
  );

  return <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>;
}

export function useEntitlement(): EntitlementValue {
  const ctx = useContext(EntitlementContext);
  if (!ctx) {
    throw new Error('useEntitlement 必须在 EntitlementProvider 内使用');
  }
  return ctx;
}
