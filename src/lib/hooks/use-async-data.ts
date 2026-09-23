/**
 * 格物 · 异步数据加载 hook
 *
 * 极简实现：不引入 react-query 之类的库。
 * 关键点是取消标记 —— 页面切换时旧请求返回不得覆盖新状态。
 *
 * 这个文件整体豁免两条 react-hooks 规则，不是图省事：
 *   - refs：loader 走「最新值引用」模式（每次渲染覆盖 ref、effect 只认 ref），
 *     这是社区通行的写法，也是唯一能既拿到最新闭包又不把内联箭头函数放进依赖数组的做法
 *   - set-state-in-effect：加载态由这次请求的生命周期决定，本来就没有可推导的等价物
 */
/* eslint-disable react-hooks/refs, react-hooks/set-state-in-effect */

import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface AsyncState<T> {
  data: T;
  loading: boolean;
  error: Error | null;
  /** 手动重新加载 */
  reload: () => void;
}

export function useAsyncData<T>(loader: () => Promise<T>, deps: DependencyList, initial: T): AsyncState<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  // 始终调用最新的 loader，但不把它放进依赖数组 —— 否则内联箭头函数会导致死循环
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    loaderRef.current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
