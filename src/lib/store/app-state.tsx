/**
 * 格物 · 全局应用状态
 *
 * 纯本地单机应用，不需要状态管理库。这里只解决两件事：
 *   1. 数据变更后让所有已挂载页面重新取数（dataVersion 递增 + bump）
 *   2. 让底部标签栏的「提醒」角标与各页共享同一份统计
 *
 * 约定：任何写操作（新增/编辑/删除/导入）完成后必须调用 bump()。
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

import { getStats } from '@/lib/db/items';
import type { ItemStats } from '@/lib/types';

interface AppStateValue {
  stats: ItemStats;
  /** 每次数据变更递增；页面把它放进 useEffect 依赖即可自动刷新 */
  dataVersion: number;
  /** 通知全应用：数据已变 */
  bump: () => void;
  /** 重新拉取汇总统计 */
  refreshStats: () => Promise<void>;
  /** 数据库是否已完成首次初始化 */
  ready: boolean;
}

const EMPTY_STATS: ItemStats = {
  total: 0,
  totalValue: 0,
  expiringCount: 0,
  soonCount: 0,
  overdueCount: 0,
  fineCount: 0,
};

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<ItemStats>(EMPTY_STATS);
  const [dataVersion, setDataVersion] = useState(0);
  const [ready, setReady] = useState(false);

  const refreshStats = useCallback(async () => {
    try {
      const next = await getStats();
      setStats(next);
      setReady(true);
    } catch {
      // 首次初始化失败时不阻塞渲染：页面各自会展示空态
    }
  }, []);

  const bump = useCallback(() => {
    setDataVersion((v) => v + 1);
  }, []);

  // dataVersion 变化即重算统计，保证角标与实际数据永远同步
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 这一句就是本 hook 存在的理由：写库后立刻把统计重算一遍
    void refreshStats();
  }, [refreshStats, dataVersion]);

  const value = useMemo<AppStateValue>(
    () => ({ stats, dataVersion, bump, refreshStats, ready }),
    [stats, dataVersion, bump, refreshStats, ready],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error('useAppState 必须在 AppStateProvider 内使用');
  }
  return ctx;
}
