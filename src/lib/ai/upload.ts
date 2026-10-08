/**
 * 格物 · 识别副本的生成（依赖 expo-image-manipulator 的那一半）
 *
 * 从 `client.ts` 拆出来，两条理由：
 *
 * 1. **让网络层可测。** `expo-image-manipulator` 的包入口是 `src/index.ts` ——
 *    node_modules 里的一个 TS 文件，`--experimental-strip-types` 拒绝加载它。
 *    只要网络层还 import 它，整层逻辑（超时、状态码分类、请求形状）就一条测试都跑不了。
 *    本轮那个「超时没真取消 → 撞上并发限流」的 bug，正是从这个缺口里溜过去的。
 * 2. 分层本来也该这样：网络层只管「把消息发出去、把状态翻译成人话」，
 *    图片怎么压是另一件事，只是恰好被同一个动作用到。
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { AI_UPLOAD_MAX_EDGE, AI_UPLOAD_QUALITY } from './config';
import { AiError } from './error';

/**
 * 把沙盒里的一张图压成长边 ≤1024 的 JPEG base64。
 *
 * 走 `saveAsync({ base64: true })` 而不是「先落盘再读文件」：
 * 那一步会多出一份临时文件和一次完整读盘，而这份副本的**唯一用途**就是发出去、
 * 用完即弃。让它连文件都不产生，是最省事也最不容易留垃圾的做法。
 *
 * ★ 只在长边超限时才缩，绝不放大 —— 与 photos/pipeline.ts 的 resizeAction 同一条规则。
 */
export async function toUploadBase64(uri: string, width: number, height: number): Promise<string> {
  const longEdge = Math.max(width, height);
  let ctx = ImageManipulator.manipulate(uri);
  if (longEdge > AI_UPLOAD_MAX_EDGE) {
    ctx = width >= height ? ctx.resize({ width: AI_UPLOAD_MAX_EDGE }) : ctx.resize({ height: AI_UPLOAD_MAX_EDGE });
  }
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ compress: AI_UPLOAD_QUALITY, format: SaveFormat.JPEG, base64: true });
  if (!out.base64) throw new AiError('图片压缩失败', 'api');
  return out.base64;
}
