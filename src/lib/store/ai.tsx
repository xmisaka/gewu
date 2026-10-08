/**
 * 格物 · AI 运行时
 *
 * 与权益、主题两个 Provider 同构：持有当前状态，组件靠 `useAi()` 订阅。
 *
 * 为什么必须是 hook 而不是模块级变量：`config.ts` 里那三个模块级变量
 * 是给「不经过 React 的调用方」用的（client.ts 取 Key），
 * 而界面需要**变化时重渲染** —— 填完 Key 回到设置页、用完一次识别，
 * 那几行状态得当场变。模块级变量不会通知 React（换肤那条坑同理）。
 *
 * 未读完库之前一律按「未配置、关着」渲染，不做加载态：
 * 读一次 meta 是本地毫秒级操作，为它放骨架屏只会让每次冷启动闪一下。
 */

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

import {
  bumpUsage,
  currentAiKey,
  EMPTY_USAGE,
  hydrateAi,
  isAiEnabled,
  maskKey,
  readAiUsage,
  rollUsage,
  saveAiEnabled,
  saveAiKey,
  writeAiUsage,
  type AiKind,
  type AiUsage,
} from '@/lib/ai/config';
import { today } from '@/lib/date';

export interface AiValue {
  /** 首次读库是否完成。只用于区分「真的没配」与「还没读出来」，界面通常不用管 */
  ready: boolean;
  /** 总开关。默认关着 —— 不开就不存在任何联网链路 */
  enabled: boolean;
  hasKey: boolean;
  /** 掩码后的 Key，设置页那一行直接用 */
  keyMask: string;
  usage: AiUsage;
  /**
   * AI 真的可用（开关开着 **且** 有 Key）。
   * ★ 界面判断「要不要显示 AI 能力」一律读它，别自己拼 `enabled && hasKey` ——
   *   那两处逻辑一旦分叉，就会出现「开关开着但一按就报没配 Key」。
   */
  active: boolean;
  setEnabled: (on: boolean) => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  /** 记一次调用，顺带落盘 */
  record: (kind: AiKind) => void;
  refresh: () => Promise<void>;
}

const AiContext = createContext<AiValue | null>(null);

/** 本月的 `YYYY-MM`。跨月时用量归零，见 config.rollUsage */
function currentMonth(): string {
  return today().slice(0, 7);
}

export function AiProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [key, setKey] = useState('');
  const [usage, setUsage] = useState<AiUsage>(EMPTY_USAGE);

  /* record 要基于「最新的」用量累加，而它可能在同一个渲染批里被连调两次
     （识别一次 + 问答一次）。用 ref 记住最新值，state 只负责触发重渲染。 */
  const usageRef = useRef<AiUsage>(EMPTY_USAGE);

  const refresh = useCallback(async () => {
    try {
      await hydrateAi();
      setEnabledState(isAiEnabled());
      setKey(currentAiKey());
      const next = await readAiUsage(currentMonth());
      usageRef.current = next;
      setUsage(next);
    } catch {
      // 库还没热起来时按「未配置」走：宁可不给，也不要默认放行一个联网能力
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 本 Provider 存在的理由就是启动时把状态读进来
    void refresh();
  }, [refresh]);

  const setEnabled = useCallback(async (on: boolean) => {
    setEnabledState(on);
    await saveAiEnabled(on);
  }, []);

  const saveKeyAction = useCallback(async (next: string) => {
    await saveAiKey(next);
    setKey(currentAiKey());
    /* 刚填上 Key 却还关着开关，是很典型的「填完发现没反应」——
       这里不替用户开开关（那是他的决定），但界面会把开关摆在最上面。 */
  }, []);

  const record = useCallback((kind: AiKind) => {
    const next = bumpUsage(rollUsage(usageRef.current, currentMonth()), kind);
    usageRef.current = next;
    setUsage(next);
    void writeAiUsage(next).catch(() => undefined);
  }, []);

  const value = useMemo<AiValue>(
    () => ({
      ready,
      enabled,
      hasKey: key.length > 0,
      keyMask: maskKey(key),
      usage,
      active: enabled && key.length > 0,
      setEnabled,
      saveKey: saveKeyAction,
      record,
      refresh,
    }),
    [ready, enabled, key, usage, setEnabled, saveKeyAction, record, refresh],
  );

  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

export function useAi(): AiValue {
  const ctx = useContext(AiContext);
  if (!ctx) {
    throw new Error('useAi 必须在 AiProvider 内使用');
  }
  return ctx;
}
