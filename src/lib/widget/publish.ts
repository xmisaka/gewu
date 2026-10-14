/**
 * 格物 · 把快照送到磁盘上
 *
 * 这是 widget 那条链路上**唯一**会同时碰「数据库」和「文件系统」的地方，
 * 所以它刻意写得很薄：取数 → 交给纯函数拼 → 落盘。三个动作各自独立可测，
 * 拼错的风险全部留在 `snapshot.ts` 那一层（有单测），这里只剩搬运。
 *
 * ★★ 为什么落在 `Paths.document`（= Android 的 `context.filesDir`）：
 *   读它的是**我们自己的** `GewuWidgetProvider` —— provider 跑在格物的进程里，
 *   只是不在 JS 运行时里。所以它能直接用普通文件 API 读到这份 JSON，
 *   不需要 ContentProvider、不需要 FileProvider、不需要任何跨进程授权。
 *   ★ 这个等式是查过源码的，不是推测：`expo-file-system` 的
 *     `documentDirectory` 常量取的就是 `appContext.persistentFilesDirectory`，
 *     而它直接返回 `context.filesDir`（见 expo-modules-core 的 AppDirectoriesService）。
 *     改成本目录之外的任何位置，provider 都会**静默读不到**，widget 停在空态。
 *
 * ★ 失败一律静默：这份文件只影响桌面上那张卡片，写不进去不该让录入弹错误。
 *   与通知、AI 降级同一条规矩。
 */

import { File, Paths } from 'expo-file-system';
import { strToU8 } from 'fflate';

import { getNextExpiry, listAttentionGroups } from '@/lib/db/items';

import { buildWidgetSnapshot, WIDGET_SNAPSHOT_FILE, type WidgetColors } from './snapshot';

/** 一次同步要用到的、来自 App 运行时的东西（其余数据在这一层现查） */
export interface WidgetSyncInput {
  attentionCount: number;
  totalItems: number;
  themeId: string;
  colors: WidgetColors;
}

/**
 * 取数 → 拼快照 → 落盘。返回是否写成功（调用方一般不看，失败也已静默）。
 *
 * ★ 三份数据**并行**取：它们之间没有依赖，串行会让「录入完立刻切到桌面」
 *   这条最常见的路径多等一个来回。
 */
export async function publishWidgetSnapshot(input: WidgetSyncInput): Promise<boolean> {
  try {
    const [groups, nextExpiry] = await Promise.all([listAttentionGroups(), getNextExpiry()]);

    const snapshot = buildWidgetSnapshot({
      /* 时刻由这里决定，不由纯函数决定 —— 这样「现在几点」是外面给的，
         纯函数可以在测试里钉在任意一刻 */
      generatedAt: Date.now(),
      themeId: input.themeId,
      colors: input.colors,
      attentionCount: input.attentionCount,
      groups,
      totalItems: input.totalItems,
      nextExpiry,
    });

    const file = new File(Paths.document, WIDGET_SNAPSHOT_FILE);
    /* ★ 先 create({overwrite}) 再 write，而不是直接 write：
       直接写在文件不存在时会失败，而**第一次**安装时它必然不存在 ——
       那正是「装了 widget 再去设置主题」这条路上最容易踩的一次。
       ★ 中间那一瞬文件是空的：如果进程恰好死在这里，provider 会读到空文件，
         按 parseWidgetSnapshot 的规约当成「还没有快照」走空态。
         代价是桌面空白一轮（最多 30 分钟），不值得为它上「临时文件 + rename」。 */
    file.create({ overwrite: true, intermediates: true });
    file.write(strToU8(JSON.stringify(snapshot)));

    return true;
  } catch {
    return false;
  }
}
