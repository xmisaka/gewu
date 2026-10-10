/**
 * 格物 · 更新检查运行时
 *
 * 与主题 / 权益两个运行时同构：Provider 持有状态，界面靠 hook 订阅。
 *
 * 为什么要有 Provider，而不是在设置页里就地 `useState`：
 * 更新检查有**两个入口**（冷启动自动 + 设置页手动），但**只有一个弹窗**。
 * 各写一份状态的话，冷启动那次的结果活不过页面切换，用户下拉再回来就看不见了 ——
 * 而这两个入口本来就该看到同一份结论。
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

import {
  clearLastCheckAt,
  readUpdateState,
  writeAutoCheck,
  writeDismissedVersionCode,
} from '@/lib/db/update';
import { checkForUpdate, readLocalVersion, type CheckOutcome } from '@/lib/update/check';
import type { LocalVersion, UpdateManifest, UpdateStatus } from '@/lib/update/policy';

export interface UpdateValue {
  status: UpdateStatus;
  /** 只在 `status === 'available'` 时非空 */
  manifest: UpdateManifest | null;
  local: LocalVersion;
  /** 更新弹窗是否展开。由本 Provider 管，因为它同时被自动与手动两条路驱动 */
  sheetOpen: boolean;
  /** 自动检查总开关。false = 用户关了，冷启动不再联网 */
  autoCheck: boolean;
  /** 拨开关。重新打开时会清掉节流时间戳，让下次冷启动立即生效 */
  setAutoCheck: (on: boolean) => Promise<void>;
  /** 手动查一次：会真的开网，且允许把失败如实写进状态 */
  checkNow: () => Promise<void>;
  /** 「以后再说」：关掉，并记住这个版本号不再自动弹 */
  remindLater: () => void;
  /** 只是关掉（去下载之后用）。**不抑制**，下次自动检查还会提示 */
  closeSheet: () => void;
}

const UpdateContext = createContext<UpdateValue | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [manifest, setManifest] = useState<UpdateManifest | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /* 自动检查总开关。先给 true（默认开），冷启动读到库里的值再校正 ——
     这一步极快，用户切到「我的」页时早已落定，不会看到开关闪动 */
  const [autoCheck, setAutoCheckState] = useState(true);
  /* 版本号来自 app.json，运行期不会变，读一次就够 */
  const [local] = useState<LocalVersion>(() => readLocalVersion());

  /**
   * `manual` 同时决定两件事，所以只传一个布尔就够：
   *   - 失败要不要说出来（自动路径必须完全静默）
   *   - 已抑制的版本要不要照样弹（用户自己点进来的，当然要给他看）
   */
  const apply = useCallback((outcome: CheckOutcome, manual: boolean) => {
    switch (outcome.kind) {
      case 'disabled':
        /* 总开关关着，这次连网都没开。什么都不改 —— 设置页那行仍是「点击检查」，
           因为手动入口不受开关约束 */
        return;
      case 'throttled':
        return;
      case 'failed':
        if (manual) setStatus('failed');
        return;
      case 'latest':
        setManifest(null);
        setStatus('latest');
        return;
      case 'available':
        setManifest(outcome.manifest);
        setStatus('available');
        if (manual || !outcome.suppressed) setSheetOpen(true);
        return;
    }
  }, []);

  /* 冷启动查一次。节流与总开关都在 checkForUpdate 里，这里不必再判断。
     整个过程不阻塞启动：真查到了才会冒出弹窗 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      /* 先把开关读出来校正界面（初值是 true，读到 '0' 再改成 false） */
      try {
        const state = await readUpdateState();
        if (alive) setAutoCheckState(state.autoCheck);
      } catch {
        // 读不到就当开，与 db 层的退化口径一致
      }
      try {
        const outcome = await checkForUpdate();
        if (alive) apply(outcome, false);
      } catch {
        // 自动检查的任何异常都不该打扰用户，下次启动还会再判断一次
      }
    })();
    return () => {
      alive = false;
    };
  }, [apply]);

  const checkNow = useCallback(async () => {
    setStatus('checking');
    try {
      apply(await checkForUpdate({ manual: true }), true);
    } catch {
      setStatus('failed');
    }
  }, [apply]);

  const setAutoCheck = useCallback(async (on: boolean) => {
    /* 先乐观更新：开关必须立刻跟手，写库失败也不该让它跳回去 */
    setAutoCheckState(on);
    try {
      await writeAutoCheck(on);
      /* ★ 重新打开时清掉节流时间戳 —— 否则用户刚拨开开关，
         还要等满 24h 的下一个窗口才查得到，看起来就像这开关没用 */
      if (on) await clearLastCheckAt();
    } catch {
      // 写不进去只是下次启动会退回默认（开），不值得打断
    }
  }, []);

  const remindLater = useCallback(() => {
    setSheetOpen(false);
    const code = manifest?.versionCode;
    // 记不住也不影响什么，只是下次启动会再弹一遍
    if (code !== undefined) void writeDismissedVersionCode(code).catch(() => undefined);
  }, [manifest]);

  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const value = useMemo<UpdateValue>(
    () => ({
      status,
      manifest,
      local,
      sheetOpen,
      autoCheck,
      setAutoCheck,
      checkNow,
      remindLater,
      closeSheet,
    }),
    [status, manifest, local, sheetOpen, autoCheck, setAutoCheck, checkNow, remindLater, closeSheet],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateValue {
  const ctx = useContext(UpdateContext);
  if (!ctx) {
    throw new Error('useUpdate 必须在 UpdateProvider 内使用');
  }
  return ctx;
}
