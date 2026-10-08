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

import { writeDismissedVersionCode } from '@/lib/db/update';
import { checkForUpdate, readLocalVersion, type CheckOutcome } from '@/lib/update/check';
import type { LocalVersion, UpdateManifest, UpdateStatus } from '@/lib/update/policy';

export interface UpdateValue {
  status: UpdateStatus;
  /** 只在 `status === 'available'` 时非空 */
  manifest: UpdateManifest | null;
  local: LocalVersion;
  /** 更新弹窗是否展开。由本 Provider 管，因为它同时被自动与手动两条路驱动 */
  sheetOpen: boolean;
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
  /* 版本号来自 app.json，运行期不会变，读一次就够 */
  const [local] = useState<LocalVersion>(() => readLocalVersion());

  /**
   * `manual` 同时决定两件事，所以只传一个布尔就够：
   *   - 失败要不要说出来（自动路径必须完全静默）
   *   - 已抑制的版本要不要照样弹（用户自己点进来的，当然要给他看）
   */
  const apply = useCallback((outcome: CheckOutcome, manual: boolean) => {
    switch (outcome.kind) {
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

  /* 冷启动查一次。节流在 checkForUpdate 里，所以这里不必再判断「今天查过没有」。
     整个过程不阻塞启动：真查到了才会冒出弹窗 */
  useEffect(() => {
    let alive = true;
    void (async () => {
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

  const remindLater = useCallback(() => {
    setSheetOpen(false);
    const code = manifest?.versionCode;
    // 记不住也不影响什么，只是下次启动会再弹一遍
    if (code !== undefined) void writeDismissedVersionCode(code).catch(() => undefined);
  }, [manifest]);

  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const value = useMemo<UpdateValue>(
    () => ({ status, manifest, local, sheetOpen, checkNow, remindLater, closeSheet }),
    [status, manifest, local, sheetOpen, checkNow, remindLater, closeSheet],
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
