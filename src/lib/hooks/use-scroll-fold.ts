/**
 * 格物 · 滚动折叠
 *
 * 首页头部那些固定区块（统计概览、分类筛选、排序）在「刚打开」这一刻是有价值的，
 * 一旦开始往下翻列表，它们就只是在占地方 —— 少则吃掉一两行物品。
 *
 * 判定以「滚动位置」为准，方向只作辅助。四处刻意的保守：
 *
 *   1. 位置是权威，方向是补贴。之前只看方向（dy 的正负）出过一个后果：
 *      只要某一帧的方向读数不对，头部就会停在一个和「用户现在滚到哪了」
 *      不相符的状态上，而且自己回不来 —— 因为方向判定没有「绝对参照」。
 *      改成位置判定后，任何一个 y 都只有一个正确结果，卡不住。
 *
 *   2. 中间留一条滞回带（unfoldAt ~ foldAt）。回弹、亚像素抖动、惯性尾巴
 *      都落在这条带里：带内只做一件事 —— 往上滚就放出来，否则保持现状。
 *      不动就不会有两个条件互相推翻、每帧重启动画的抽搐。
 *
 *   3. 到顶必展开。y <= unfoldAt 是无条件的最高优先级 —— 不管当前是什么状态、
 *      内容还能不能滚，只要回到了顶部附近，头部就必须在。
 *
 *   4. 列表滚不动时不收。内容不足一屏时若照收不误，会出现「收起 → 可滚范围
 *      变小 → 偏移量被夹回 0 → 又展开」的抖动，而且这种抖动会卡在半路。
 *
 * 目标态与动画值分开存：折叠是 240ms 的 withTiming，若拿过渡中的值去判断
 * 「要不要再启动一次动画」，会每帧重启一次，动画永远走不完。
 *
 * 全文件豁免 react-hooks/immutability：Reanimated 的 shared value 就是靠
 * 直接改 .value 驱动的（写值即触发 UI 线程更新），这条规则在这里是误报。
 */
/* eslint-disable react-hooks/immutability */

import { useCallback } from 'react';
import {
  useAnimatedScrollHandler,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { Motion } from '@/constants/theme';

const DURATION = Motion.base;

export interface ScrollFoldOptions {
  /** 滚过这条线（dp）才收起 */
  foldAt?: number;
  /** 回到这条线以内，无条件放出来 */
  unfoldAt?: number;
  /** 回拉的判据：一帧里往上走了这么多（dp），视为「用户在往回翻」 */
  deadZone?: number;
  /** 列表至少还能滚这么远，才允许收起（防止上面第 4 条的死循环） */
  minScrollable?: number;
}

export interface ScrollFold {
  /** 1 = 完全展开，0 = 完全收起。直接喂给 Collapse */
  progress: SharedValue<number>;
  /** 挂到 FlatList / ScrollView 的 onScroll 上 */
  scrollHandler: (event: any) => void;
  /** 挂到 onScrollEndDrag / onMomentumScrollEnd 上：JS 侧兜底 */
  settle: (event: any) => void;
  /** 强制展开（例如切走了视图、或要让用户立刻看到筛选状态） */
  expand: () => void;
}

export function useScrollFold({
  foldAt = 88,
  unfoldAt = 56,
  deadZone = 24,
  minScrollable = 160,
}: ScrollFoldOptions = {}): ScrollFold {
  const progress = useSharedValue(1);
  /** 只有 0 / 1，代表「想去哪」；progress 是它的一次动画 */
  const target = useSharedValue(1);
  const lastY = useSharedValue(0);

  const drive = useCallback(
    (next: 0 | 1) => {
      target.value = next;
      progress.value = withTiming(next, { duration: DURATION });
    },
    [progress, target],
  );

  const expand = useCallback(() => drive(1), [drive]);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      const y = e.contentOffset.y;
      const dy = y - lastY.value;
      lastY.value = y;

      const scrollable = e.contentSize.height - e.layoutMeasurement.height;
      let next: number;

      if (scrollable < minScrollable || y <= unfoldAt) {
        // 内容不足一屏 / 已经回到顶部附近 —— 无条件展开，优先级最高
        next = 1;
      } else if (dy < -deadZone) {
        // 明显在往回翻 —— 立刻放出来，不必等到真正回到顶部
        next = 1;
      } else if (y >= foldAt) {
        // 翻过折叠线就收起。这一条不看方向：慢慢拖下来也该收得掉
        next = 0;
      } else {
        // 滞回带（unfoldAt ~ foldAt）内保持现状，回弹和抖动都落在这里
        next = target.value;
      }

      if (next !== target.value) {
        target.value = next;
        progress.value = withTiming(next, { duration: DURATION });
      }
    },
  });

  /**
   * 松手与惯性结束时的兜底。
   *
   * onScroll 那条路跑在 UI 线程，要同时判断位置、方向、可滚余量；这一条跑在
   * JS 线程，只看一件事：手离开屏幕时，列表是不是停在顶部附近。是就放出来。
   *
   * 多这一层的理由：「用户已经回到顶部」是一条不需要推理的事实，不该被任何
   * 一个中间环节的读数意外挡掉。
   */
  const settle = useCallback(
    (e: any) => {
      const y = e?.nativeEvent?.contentOffset?.y ?? 0;
      if (y <= unfoldAt) drive(1);
    },
    [drive, unfoldAt],
  );

  return { progress, scrollHandler, settle, expand };
}
