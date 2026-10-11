/**
 * 格物 · 到期提醒的运行时
 *
 * 三件事：
 *   1. 把偏好（开关 / 提前几天）与**权限态**读进来，摆给「我的」页看；
 *   2. 数据一变（`dataVersion`）就**去抖重排**一次通知 —— 与统计刷新挂在同一处；
 *   3. 点通知能跳回那件物品（冷启动那次也要能）。
 *
 * ★ 唯一的同步入口是那个 effect：启动、改数据、拨开关、改提前天数、从后台回来
 *   —— 五条路都汇到同一个 `sync()`。不另外在每个写操作里各调一次：
 *   批量加 20 件会排 20 次，而且迟早会漏掉一条路径。
 *
 * ★ 失败一律**静默**：通知链路上的任何异常都不该让录入/保存变成一次弹窗，
 *   更不能让「提醒没排上」变成用户看得见的错误 —— 与 AI 的降级同一条规矩。
 */

import { useRootNavigationState, useRouter } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import {
  listExpiryCandidates,
  readNotifyPrefs,
  writeNotifyEnabled,
  writeNotifyLeadDays,
} from '@/lib/db/notify';
import { DEFAULT_LEAD_DAYS, planExpiryNotifications, type LeadDays } from '@/lib/notify/plan';
import {
  applyPlan,
  cancelAllManaged,
  installForegroundHandler,
  listManagedScheduled,
  readPermission,
  requestPermission,
  useOpenedFromNotification,
  type PermissionState,
} from '@/lib/notify/schedule';

import { useAppState } from './app-state';

/** 数据变动后等这么久再重排 —— 批量加 20 件只排一次 */
const SYNC_DEBOUNCE_MS = 800;

interface NotifyValue {
  /** 偏好已经从库里读出来了吗（没读出来之前别显示「已关闭」这种结论） */
  ready: boolean;
  /** 用户拨的那个开关，库里存的值 */
  enabled: boolean;
  /** 真的会响吗：开关开着 **且** 系统给了权限 */
  active: boolean;
  permission: PermissionState;
  leadDays: LeadDays;
  /** 系统里当前排着的条数 */
  scheduledCount: number;
  /** 最近一条的触发时刻（毫秒），「已排 N 条 · 最近一条 10-14」用 */
  nextAt: number | null;
  /** 正在要权限 —— 期间开关要挡住连点 */
  busy: boolean;
  setEnabled: (next: boolean) => Promise<void>;
  setLeadDays: (next: LeadDays) => Promise<void>;
}

const NotifyContext = createContext<NotifyValue | null>(null);

export function NotifyProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { dataVersion } = useAppState();

  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [leadDays, setLeadDays] = useState<LeadDays>(DEFAULT_LEAD_DAYS);
  const [permission, setPermission] = useState<PermissionState>('undetermined');
  const [scheduledCount, setScheduledCount] = useState(0);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  /* 重排要读「当下的值」，而 useCallback 的闭包只会捕获它创建那一刻的 state。
     ★ 与批量识图那次踩的坑同一个：只读 state 会拿到旧值，而且**不报错**。 */
  const enabledRef = useRef(false);
  const leadDaysRef = useRef<LeadDays>(DEFAULT_LEAD_DAYS);

  const commitEnabled = useCallback((next: boolean) => {
    enabledRef.current = next;
    setEnabled(next);
  }, []);

  const commitLeadDays = useCallback((next: LeadDays) => {
    leadDaysRef.current = next;
    setLeadDays(next);
  }, []);

  /**
   * 唯一的同步动作。
   *
   * 关着的时候**不是什么都不做**：要把之前排的全部撤掉 ——
   * 「关了开关还照响」比不提醒更伤信任；顺带也自愈了「偏好是关的、系统里却还排着」的脏状态。
   */
  const sync = useCallback(async () => {
    if (!enabledRef.current) {
      await cancelAllManaged();
      setScheduledCount(0);
      setNextAt(null);
      return;
    }

    const perm = await readPermission();
    setPermission(perm);
    if (perm !== 'granted') {
      /* 系统里没给权限：如实回报，别让界面继续挂着「已排 N 条」 */
      setScheduledCount(0);
      setNextAt(null);
      return;
    }

    const [items, existing] = await Promise.all([listExpiryCandidates(), listManagedScheduled()]);
    const plan = planExpiryNotifications({
      items,
      leadDays: leadDaysRef.current,
      now: Date.now(),
      existing,
    });
    await applyPlan(plan);
    setScheduledCount(plan.kept.length);
    setNextAt(plan.kept[0]?.at ?? null);
  }, []);

  const safeSync = useCallback(async () => {
    try {
      await sync();
    } catch {
      // 静默：排通知失败不该在界面上留任何痕迹
    }
  }, [sync]);

  /* 装前台处理器 + 冷启动读一次偏好与权限 */
  useEffect(() => {
    installForegroundHandler();

    let alive = true;
    void (async () => {
      try {
        const prefs = await readNotifyPrefs();
        if (!alive) return;
        commitEnabled(prefs.enabled);
        commitLeadDays(prefs.leadDays);
        const perm = await readPermission();
        if (alive) setPermission(perm);
      } catch {
        // 读不到就按「关着」处理，不打断启动
      } finally {
        if (alive) setReady(true);
      }
    })();

    return () => {
      alive = false;
    };
  }, [commitEnabled, commitLeadDays, safeSync]);

  /* 五条路都汇到这里：启动、改数据、拨开关、改提前天数 */
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => void safeSync(), SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ready, dataVersion, enabled, leadDays, safeSync]);

  /* 用户可能去系统设置里改了通知权限再回来 —— 回前台复核一次，
     否则界面会一直停在「系统里没给权限」，而其实早就给了 */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void safeSync();
    });
    return () => sub.remove();
  }, [safeSync]);

  /* 点通知 → 回到那件物品。冷启动那次也走这条 */
  const opened = useOpenedFromNotification();
  const openedKey = opened?.key ?? null;
  const openedItemId = opened?.itemId ?? null;
  /* ★ 冷启动时导航容器可能还没就绪 —— 不等它，这一跳会被直接丢掉，
     而且**不报错**：用户点了通知进来却停在首页，只会以为点错了 */
  const rootKey = useRootNavigationState()?.key ?? null;
  const openedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!rootKey || !openedKey || !openedItemId) return;
    /* 同一条响应可能被反复交回来 —— 否则会一直往详情页压栈 */
    if (openedRef.current.has(openedKey)) return;
    openedRef.current.add(openedKey);
    router.push({ pathname: '/item/[id]', params: { id: openedItemId } });
  }, [rootKey, openedKey, openedItemId, router]);

  /**
   * 拨开关。
   * ★ 打开时**先要权限**（并且要先建渠道 —— Android 13 没有渠道就弹不出那个框）；
   *   被拒就**把开关落回去**并写 '0'：绝不留一个「开着但不会响」的假象。
   */
  const changeEnabled = useCallback(
    async (next: boolean) => {
      if (next) {
        setBusy(true);
        try {
          const perm = await requestPermission();
          setPermission(perm);
          if (perm !== 'granted') {
            commitEnabled(false);
            await writeNotifyEnabled(false);
            return;
          }
        } catch {
          commitEnabled(false);
          return;
        } finally {
          setBusy(false);
        }
      }

      commitEnabled(next);
      try {
        await writeNotifyEnabled(next);
      } catch {
        // 静默：写偏好失败，下次打开还是旧状态，但这一次的行为已经生效
      }
    },
    [commitEnabled],
  );

  const changeLeadDays = useCallback(
    async (next: LeadDays) => {
      commitLeadDays(next);
      try {
        await writeNotifyLeadDays(next);
      } catch {
        // 同上
      }
    },
    [commitLeadDays],
  );

  const value = useMemo<NotifyValue>(
    () => ({
      ready,
      enabled,
      active: enabled && permission === 'granted',
      permission,
      leadDays,
      scheduledCount,
      nextAt,
      busy,
      setEnabled: changeEnabled,
      setLeadDays: changeLeadDays,
    }),
    [
      ready,
      enabled,
      permission,
      leadDays,
      scheduledCount,
      nextAt,
      busy,
      changeEnabled,
      changeLeadDays,
    ],
  );

  return <NotifyContext.Provider value={value}>{children}</NotifyContext.Provider>;
}

export function useNotify(): NotifyValue {
  const ctx = useContext(NotifyContext);
  if (!ctx) {
    throw new Error('useNotify 必须在 NotifyProvider 内使用');
  }
  return ctx;
}
