/**
 * 格物 · 桌面小组件的快照同步（无界面）
 *
 * 挂在根布局里跑一次。职责只有一个：**数据或主题一变，就把桌面那份快照重写一遍**。
 *
 * ★★ 为什么是一个「什么都不画」的组件，而不是在每个写操作里各调一次：
 *   与 `NotifyProvider` 是同一个理由 —— 录入、编辑、删除、批量入库、导入、
 *   回收站还原……写操作有十几条路，每条都记得去刷一次是不可能的，
 *   而漏掉的那条**不报错**，只是桌面上停着旧数字。这里统一挂在
 *   `dataVersion` 上，凡是调过 `bump()` 的都自动覆盖。
 *
 * ★★ 「什么时候轮到桌面刷新」这件事，刻意**不**由这里决定：
 *   本组件只负责把文件写好。真正去戳 `AppWidgetManager` 的是原生侧
 *   （`MainActivity.onStop` —— 用户离开 App 的那一刻）。
 *   理由是这样排除了「JS 还没写完、原生已经去读了」这条竞态：
 *   写文件是同步的（`File.write`），而 `onStop` 必然发生在它之后。
 *   反过来做（JS 主动广播去刷新）得为一次广播接一整套原生模块，
 *   而那套东西一旦哪次没接上，表现同样是「桌面不动」，却更难查。
 *
 * ★ 挂载位置要求：必须在 `ThemeProvider` 内层 —— 快照要带上当前主题的色值，
 *   而主题是运行时的 React 状态（七套主题在桌面上要能各画各的）。
 */

import { useEffect } from 'react';

import { useAppState } from '@/lib/store/app-state';
import { widgetColorsOf } from '@/lib/widget/palette';
import { publishWidgetSnapshot } from '@/lib/widget/publish';
import { useTheme } from '@/lib/theme';

/**
 * 数据变动后等这么久再写 —— 与通知重排同一个节奏。
 *
 * 批量入库 20 件会连续 `bump()` 20 次；每次写一个文件虽然只有 1KB，
 * 但每次都要跑两条查询。等一拍，这一串只落一次盘。
 */
const SYNC_DEBOUNCE_MS = 800;

export function WidgetSync() {
  const { stats, dataVersion, ready } = useAppState();
  const { key: themeId, tokens } = useTheme();

  useEffect(() => {
    /* ★ 必须等 `ready`：数据库首次初始化没完成时 stats 还是全零，
       这时候写一份快照出去，桌面上会出现「0 件」——
       而它**看起来完全正常**，用户只会以为东西丢了。
       冷启动路径本来就会在 ready 之后重跑一次这个 effect。 */
    if (!ready) return;

    const timer = setTimeout(() => {
      void publishWidgetSnapshot({
        attentionCount: stats.attentionCount,
        totalItems: stats.total,
        themeId,
        colors: widgetColorsOf(tokens),
      });
      /* publishWidgetSnapshot 内部已经把什么异常都吞了，
         这里再接一层 `catch` 只是防它自己的 import 层面出问题 */
    }, SYNC_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    /* `tokens` 每套主题一个稳定对象，进了依赖就等于「换肤也算一次变更」——
       否则用户在设置里换了主题、回到桌面发现卡片还是旧配色，而两处都不报错 */
  }, [ready, dataVersion, stats.attentionCount, stats.total, themeId, tokens]);

  return null;
}
