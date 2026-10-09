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
  activeProviderKey,
  bumpUsage,
  chatModelName,
  currentAiKey,
  defaultModelName,
  EMPTY_USAGE,
  endpointUrl,
  findProvider,
  hasModelOverride,
  hydrateAi,
  isAiEnabled,
  maskKey,
  readAiUsage,
  rollUsage,
  saveAiEnabled,
  saveAiKey,
  saveAiModel,
  saveAiProvider,
  saveCustomEndpoint,
  visionModelName,
  writeAiUsage,
  type AiKind,
  type AiModelKind,
  type AiProviderDef,
  type AiUsage,
} from '@/lib/ai/config';
import { DEFAULT_PROVIDER_KEY as DEFAULT_PROVIDER } from '@/lib/ai/config';
import { today } from '@/lib/date';

export interface AiValue {
  /** 首次读库是否完成。只用于区分「真的没配」与「还没读出来」，界面通常不用管 */
  ready: boolean;
  /**
   * 总开关。默认关着 —— 不开就不存在任何联网链路。
   *
   * ★★ 界面判断「AI 这一族的入口露不露」**读它**，不要读 `active`：
   *   `active` 还要求填了 Key，那是「能不能跑」；入口该不该露只看
   *   **用户有没有把这一族关掉**。两者的差别正好是两种不同的用户处境 ——
   *     开关开着但没 Key ＝「还没配好」→ 入口**保留**，点下去给引导
   *       （没商店评分兜底时，说清楚比装作没有更重要）；
   *     开关关着 ＝「我不要」→ 麦克风 / 问一问 / 识物**整族收起来**。
   *   把这两件事混成一句判断，症状就是「开关明明关着，界面上还满屏 AI」。
   *
   * 覆盖范围：首页与录入页的麦克风、首页的问一问星标、录入页的识物按钮，
   * 以及 `/voice`、`/ask` 两页的**深链兜底**（少了它，`gewu://ask` 就是一道暗门）。
   */
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

  /* ---- 供应商与模型 ----
     这些必须是 **React 状态**，不能只放 config 的模块级变量：
     模块级变量改了不会通知 React（换肤那条坑同理），
     界面就会「明明切过去了，名字还是旧的」—— 而且不报错。
     config 那侧仍然保留运行时值，因为 client.ts 是不经过 React 的调用方。 */
  provider: AiProviderDef;
  /** 自定义端点地址；非自定义时为空串 */
  endpoint: string;
  /** 识图模型名；空串＝当前这家看不了图 */
  visionModel: string;
  chatModel: string;
  /** 当前这家能不能识图。界面据此决定露不露识物入口 */
  supportsVision: boolean;
  /** 这家预置的默认模型名，输入框拿它当 placeholder */
  defaultVision: string;
  defaultChat: string;
  /** 用户是否改过这个名字 */
  visionOverridden: boolean;
  chatOverridden: boolean;
  setProvider: (key: string) => Promise<void>;
  saveEndpoint: (url: string) => Promise<void>;
  saveModel: (kind: AiModelKind, value: string) => Promise<void>;
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
  const [providerKey, setProviderKeyState] = useState<string>(DEFAULT_PROVIDER);
  const [endpoint, setEndpointState] = useState('');
  const [visionModel, setVisionState] = useState('');
  const [chatModel, setChatState] = useState('');

  /* record 要基于「最新的」用量累加，而它可能在同一个渲染批里被连调两次
     （识别一次 + 问答一次）。用 ref 记住最新值，state 只负责触发重渲染。 */
  const usageRef = useRef<AiUsage>(EMPTY_USAGE);

  /** 把 config 那侧「供应商 / 端点 / 模型名」的当前值同步进 React 状态 */
  const syncProviderState = useCallback(() => {
    setProviderKeyState(activeProviderKey());
    setEndpointState(endpointUrl());
    setVisionState(visionModelName());
    setChatState(chatModelName());
  }, []);

  const refresh = useCallback(async () => {
    try {
      await hydrateAi();
      setEnabledState(isAiEnabled());
      setKey(currentAiKey());
      syncProviderState();
      const next = await readAiUsage(currentMonth());
      usageRef.current = next;
      setUsage(next);
    } catch {
      // 库还没热起来时按「未配置」走：宁可不给，也不要默认放行一个联网能力
    } finally {
      setReady(true);
    }
  }, [syncProviderState]);

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

  /**
   * 切供应商。
   *
   * ★ 切完必须**重新同步一次**：Key 换成那一家的了（hasKey 要跟着变），
   *   端点与两个模型名也都换了。少同步一处，界面上就会出现
   *   「显示已配置、实际用的是上一家的 Key」这种看不出错的错。
   */
  const setProvider = useCallback(
    async (next: string) => {
      await saveAiProvider(next);
      setKey(currentAiKey());
      syncProviderState();
    },
    [syncProviderState],
  );

  const saveEndpoint = useCallback(async (url: string) => {
    await saveCustomEndpoint({ endpoint: url });
    setEndpointState(url.trim());
  }, []);

  const saveModel = useCallback(
    async (kind: AiModelKind, value: string) => {
      await saveAiModel(kind, value);
      setVisionState(visionModelName());
      setChatState(chatModelName());
    },
    [],
  );

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
      provider: findProvider(providerKey),
      endpoint,
      visionModel,
      chatModel,
      supportsVision: visionModel.length > 0,
      defaultVision: defaultModelName('vision'),
      defaultChat: defaultModelName('chat'),
      visionOverridden: visionModel.length > 0 && hasModelOverride('vision'),
      chatOverridden: chatModel.length > 0 && hasModelOverride('chat'),
      setProvider,
      saveEndpoint,
      saveModel,
    }),
    [
      ready,
      enabled,
      key,
      usage,
      setEnabled,
      saveKeyAction,
      record,
      refresh,
      providerKey,
      endpoint,
      visionModel,
      chatModel,
      setProvider,
      saveEndpoint,
      saveModel,
    ],
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
