/**
 * 格物 · 海报落图与分享（唯一碰系统能力的文件）
 *
 * `quotes` / `templates` / `model` 都是纯逻辑，能在 Node 里跑；
 * 只有这里 import react-native-view-shot / expo-sharing / expo-file-system。
 * 与 `lib/inventory/export.ts` 同一条分工：**系统能力只在最外层出现一次**。
 *
 * ── 为什么为了这张图引一枚原生模块 ─────────────────────────────
 * 项目有过两次裁决（`lib/contact.ts` 的二维码、清册的 PDF）：能不加模块就不加。
 * 这次加的 `react-native-view-shot` 是唯一能把「屏幕上的排版」变成「一张图」的路：
 *   · `expo-print` 已在依赖里，但它出 PDF 不出 PNG —— 微信里是文件卡片，像发附件；
 *   · Skia 能直接 encode，但体积与学习成本对一次分享不成立。
 * 加之前已经核过包：`android/src/main/AndroidManifest.xml` 是空的，
 * **不声明任何权限**；`android/build.gradle` 只依赖 react-native 本体，没有额外 AAR。
 * 真实增量仍以两版 APK 的 `aapt2 dump badging` 计数差为准（见交付说明）。
 *
 * ── 为什么要显式传 width / height ─────────────────────────────
 * 不传就是「按 view 的物理尺寸」，在 dpr=2 的机器上只有 720×900，
 * 发到朋友圈会被二次插值放大。传了之后 view-shot 是**在 canvas 上等比重绘**
 * （`canvas.scale` + `view.draw`），所以文字仍然是矢量清晰的，
 * 只有照片是上采样 —— 而照片本来就是缩略图，这一层躲不掉。
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { RefObject } from 'react';
import { Share, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { POSTER_SIZE } from './model';

/** 导出像素。4:5，朋友圈单图的最优比例 */
export const POSTER_PIXEL = {
  width: POSTER_SIZE.width * 3,
  height: POSTER_SIZE.height * 3,
} as const;

/**
 * 固定文件名。
 *
 * 与 `contact.ts` 落二维码同一条规矩：cache 里只留一份，反复生成不会堆垃圾。
 * 名字固定也意味着「上一次的图」一定被覆盖 —— 用户不会发到一张三天前的海报。
 */
const POSTER_FILE = 'gewu-poster.png';

/**
 * 把海报视图抓成 PNG，返回可交给分享面板的 file:// uri。
 *
 * 不吞异常：抓图失败（view 没挂上、原生模块没链上）必须让调用方看见，
 * 否则用户会看到「分享按钮点了没反应」。
 */
export async function capturePoster(ref: RefObject<View | null>): Promise<string> {
  const tmpUri = await captureRef(ref, {
    format: 'png',
    quality: 1,
    result: 'tmpfile',
    width: POSTER_PIXEL.width,
    height: POSTER_PIXEL.height,
  });

  const target = new File(Paths.cache, POSTER_FILE);
  try {
    // ★ 用 move(目标, { overwrite: true })，不用 rename —— 见 export.ts 头注释那次真机事故
    await new File(tmpUri).move(target, { overwrite: true });
    return target.uri;
  } catch {
    // 落不到固定名不算失败：tmp 那份同样能分享，只是会多留一个临时文件（系统会清）
    return tmpUri;
  }
}

/**
 * 交给系统分享面板。
 *
 * 返回 false ＝ 这台设备没有分享面板（罕见机型）。由界面给出替代说法，
 * 不在这里弹错误 —— 与 `shareWechatQr` 同一条约定。
 */
export async function sharePosterFile(uri: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: '分享这张海报' });
  return true;
}

/**
 * 纯文本清单走 RN 的 Share —— expo-sharing 只收文件，不收字符串。
 * 与 sharePosterFile 同一条约定：返回 false（包括用户划掉面板）不算错误，不弹提示。
 */
export async function shareText(message: string): Promise<boolean> {
  try {
    const res = await Share.share({ message });
    return res.action !== Share.dismissedAction;
  } catch {
    return false;
  }
}
