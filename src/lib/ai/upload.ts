/**
 * 格物 · 识别副本的生成（依赖 expo-image-manipulator 的那一半）
 *
 * 从 `client.ts` 拆出来，两条理由：
 *
 * 1. **让网络层可测。** `expo-image-manipulator` 的包入口是 `src/index.ts` ——
 *    node_modules 里的一个 TS 文件，`--experimental-strip-types` 拒绝加载它。
 *    只要网络层还 import 它，整层逻辑（超时、状态码分类、请求形状）就一条测试都跑不了。
 * 2. 分层本来也该这样：网络层只管「把消息发出去、把状态翻译成人话」，
 *    图片怎么压是另一件事，只是恰好被同一个动作用到。
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { AI_UPLOAD_MAX_EDGE, AI_UPLOAD_QUALITY } from './config';
import { AiError } from './error';

/**
 * 上传副本的体积上限（base64 字符数）。
 *
 * 长边 ≤1024、质量 0.8 的 JPEG，base64 通常落在 100–400KB。
 * 明显超过这个量级，说明**压缩根本没生效**（原图被整个编了出来）。
 * 与其把它发出去换来一句莫名其妙的 429，不如在这里就报清楚。
 */
const MAX_UPLOAD_BASE64 = 1_500_000;

/** 按长边算缩放动作；只在超限时缩，绝不放大（与 photos/pipeline.ts 同一条规则） */
function resizeAction(w: number, h: number): { width?: number; height?: number } | null {
  if (!w || !h) return null;
  if (Math.max(w, h) <= AI_UPLOAD_MAX_EDGE) return null;
  return w >= h ? { width: AI_UPLOAD_MAX_EDGE } : { height: AI_UPLOAD_MAX_EDGE };
}

/** 渲染一次并落成 base64，同时**回报这一次实际产出的尺寸** */
async function renderJpeg(
  uri: string,
  action: { width?: number; height?: number } | null,
): Promise<{ base64: string; width: number; height: number }> {
  let ctx = ImageManipulator.manipulate(uri);
  if (action) ctx = ctx.resize(action);
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ compress: AI_UPLOAD_QUALITY, format: SaveFormat.JPEG, base64: true });
  if (!out.base64) throw new AiError('图片压缩失败', 'api');
  return { base64: out.base64, width: out.width ?? 0, height: out.height ?? 0 };
}

/**
 * 把沙盒里的一张图压成长边 ≤1024 的 JPEG base64。
 *
 * 走 `saveAsync({ base64: true })` 而不是「先落盘再读文件」：
 * 那一步会多出一份临时文件和一次完整读盘，而这份副本的**唯一用途**就是发出去、
 * 用完即弃。让它连文件都不产生，是最省事也最不容易留垃圾的做法。
 *
 * ★★ 判据用的是**这一次实际产出的尺寸**，不是调用方传进来的宽高。
 *    相机路径上踩过这个坑：传进来的宽高一旦不准，`resizeAction` 就判成「无需缩放」，
 *    于是整张原图成了上传副本 —— 请求量级直接涨一两个数量级，
 *    服务端回的是 429，而错误信息里完全看不出「其实是图没压」。
 *    所以这里量输出、再兜一道；只多解码一次，且只在异常路径上发生。
 */
export async function toUploadBase64(uri: string, width: number, height: number): Promise<string> {
  const first = await renderJpeg(uri, resizeAction(width, height));

  const sizeOk = Math.max(first.width, first.height) <= AI_UPLOAD_MAX_EDGE;
  if (sizeOk && first.base64.length <= MAX_UPLOAD_BASE64) return first.base64;

  /*
   * 走到这里说明第一遍没压住。好消息是这一遍已经把**真实尺寸**量出来了，
   * 直接拿它当输入重做即可 —— 不需要额外再探测一次。
   */
  const retry = await renderJpeg(uri, resizeAction(first.width, first.height));
  if (retry.base64.length > MAX_UPLOAD_BASE64) {
    throw new AiError('这张图没能压到能上传的大小，换一张试试', 'api');
  }
  return retry.base64;
}
