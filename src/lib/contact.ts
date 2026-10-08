/**
 * 格物 · 联系作者
 *
 * 这里只管两件事：把二维码这张图交出去，以及把它送进系统分享面板。
 *
 * ★ 为什么走分享而不是「保存到相册」：
 *   保存到相册要 expo-media-library（原生模块）＋存储权限，
 *   为一张二维码破掉「零新原生依赖、零新权限」不划算 —— 而分享是等价路径：
 *   发到微信里点开、长按识别，一样能加上；expo-sharing 本来就在依赖里。
 *
 * ★ 图片本身是**重新生成**的，不是把截图裁一块：
 *   原图是 928×1377 的微信截图，二维码区只有 608px，放大到全屏就虚。
 *   现在这份是 segno 从扫码结果重画的 1176×1176（纠错 H、静区 4 模块），
 *   放大到 280dp 仍然逐模块清晰 —— 二维码糊了会直接扫不出。
 *
 * 载荷（换了微信号就用它重画，别去截图）：
 *   https://u.wechat.com/EHVgw7ESh4m95vrk4uZFldA?s=3
 * 重画命令（本机托管 venv 里有 segno）：
 *   python -c "import segno; segno.make('https://u.wechat.com/EHVgw7ESh4m95vrk4uZFldA?s=3', \
 *     error='h').save('assets/images/wechat-qr.png', scale=24, border=4, \
 *     dark='#07c160', light='#ffffff')"  theme-color-ok: 模块色烘进 PNG，不参与换肤
 *   ★ 重画后一定用扫码器验一遍：载荷必须与上面那行完全一致。
 *   ★ 重画后还要重新生成本文件里 QR_PNG_BASE64 那一段（见它的注释）。
 *
 * 上面那两个色值是微信绿与纯白，刻意**不**从 theme.ts 取 —— 它们属于这张图片，
 * 不属于皮肤。任何一套主题下二维码都得是深色模块压浅色底，否则扫不出来。
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/* 项目里没有 `declare module '*.png'`，静态 import 会直接报 TS2307；
   用 require 取模块号（expo-image 的 source 吃这个），
   与 src/lib/id.ts 取 expo-crypto 的写法一致。
   显示用这一份 —— RN 的 Image 走 drawable 资源，一直显示正常。 */
const QR_MODULE = require('../../assets/images/wechat-qr.png') as number;

/** 交给 <Image> 的 source（不要在这里再包一层 uri） */
export const WECHAT_QR = QR_MODULE;

/**
 * 同一张二维码的 base64 内联副本，专供**分享**使用。
 *
 * ── 为什么分享不走 expo-asset ────────────────────────────────
 * 试过 `Asset.fromModule(...).downloadAsync()`，在 Android 生产包上拿回来的
 * localUri 与 uri **都是空**（真机报 "expected scheme to be 'file', got 'null'"）：
 * RN 会把打包资源重命名成 `res/g6.png` 这样的短名，Asset 按 hash 去定位对不上；
 * AssetRegistry 的 descriptor 上又没有 uri 字段可以兜底。
 * 图其实一直在包里（按字节比对确认过），只是这条取件路径取不到它。
 *
 * 与其赌 asset 管线，不如把图直接带在代码里 —— 它只有 1446 字节，
 * base64 后 1928 字符。落进 cache 一次，永远有稳定的 file:// 可交出去。
 *
 * ★ 换二维码后重新生成这一段：
 *   python -c "import base64; print(base64.b64encode(open('assets/images/wechat-qr.png','rb').read()).decode())"
 *   再按 76 字符一行填进下面的数组。
 */
const QR_PNG_BASE64 = [
  'iVBORw0KGgoAAAANSUhEUgAABJgAAASYAQMAAABmmuXzAAAABlBMVEUHwWD///9Xj5kNAAAFW0lE',
  'QVR42u3dQY7bMAwF0I/e/87tosDAtUhagO00i+dFkPE41gO0+pBE5vf3XWFiYmJiYmJiYmJiYmJi',
  'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYvomU6rr7/2fz+7L6fmf78eX',
  'z6P8XL/yfRcTExMTExMTExMTE9O3m+oIVt45Zrc15a3J7jIeduOaOyYmJiYmJiYmJiYmpkfy3Smj',
  '1ct+//58iIHlb+dRzB0TExMTExMTExMTE9NL+e74Z6rVuvn+/Fv5jomJiYmJiYmJiYmJ6WP5rjt2',
  '163WlS+3fsfExMTExMTExMTExPThfDffKYuldHmtHCvO3zExMTExMTExMTExMb2f78oHHv+cGeaO',
  'iYmJiYmJiYmJiYnpZr6b+ig0uW///v5Y5o6JiYmJiYmJiYmJiemRfJe+08Ga+Mo/1+/HV80H+uQ7',
  'JiYmJiYmJiYmJiam+/luyGs7J+zWhNi9Zz27J98xMTExMTExMTExMTE9mO92iqKsya7MgKnW6dYf',
  'lgxzx8TExMTExMTExMTEdDPfdbnslMjmcDd0Px8SpXzHxMTExMTExMTExMT0YL7rdlem2kVZvqS7',
  'We7GLF8r3zExMTExMTExMTExMd3Pd2kKnqTvWNcFwPRtEazfMTExMTExMTExMTExfSbfZaNXXcZd',
  'muVWzONvMy7hmTsmJiYmJiYmJiYmJqab+a6rcjn3v5ubI6w7M9Ns15TvmJiYmJiYmJiYmJiYnsp3',
  'p7x2inJd9cu5vUK2q6zId0xMTExMTExMTExMTG/ku8uCKqnO3GU8iHd5mk++Y2JiYmJiYmJiYmJi',
  'ejbfzfGtXK0bOqFvPinfMTExMTExMTExMTExPZXv5qxXdj9Pf6RuGCL2ZzIxMTExMTExMTExMb2Z',
  '7y6fSb8k1wW9LMfucrVj09wxMTExMTExMTExMTHdz3dDF7xygW8IeqcH1nHTdFIwd0xMTExMTExM',
  'TExMTDfz3VBNZS66MtdUSbW9U75jYmJiYmJiYmJiYmL6QL7LWHclVa+EbuXu9KXMd87fMTExMTEx',
  'MTExMTExPZvvdoJY9upqznkw40ZQc8fExMTExMTExMTExPRUvisbmqdpcT7c7I7plePKd0xMTExM',
  'TExMTExMTE/lu3nL5X4AHMpjDi+U75iYmJiYmJiYmJiYmN7Id2sEKxPc8bHhV2l2fup/x8TExMTE',
  'xMTExMTE9Ea+O95J36UuVy3LT+/JVdu7WL9jYmJiYmJiYmJiYmJ6NN+VEW9uabdzUq9ro1AuC8p3',
  'TExMTExMTExMTExM9/PdkMuG6pdDIc3LgfS/Y2JiYmJiYmJiYmJieiPfDaftugKba+LLVW2WOe7J',
  'd0xMTExMTExMTExMTPfzXaqSKfs97E731yG6oeU7JiYmJiYmJiYmJiamZ/Ndd6U6kZdq/S5XBTZ3',
  'FgrNHRMTExMTExMTExMT0818t/nA3PPu9K/02zi7UcwdExMTExMTExMTExPT/Xw3HMfrSqNkY1Ev',
  'VXOENHVazB0TExMTExMTExMTE9Mj+W5NZGl6HKzJruxz163Zpdkdau6YmJiYmJiYmJiYmJheyndl',
  'misz4JD+TiOmaXou3zExMTExMTExMTExMb2X74bPjK3PdxKffMfExMTExMTExMTExPRSvhsakZdn',
  '7ub9mWX0S794J98xMTExMTExMTExMTE9ku+GB7o7XTxMs8Y3d1WQ75iYmJiYmJiYmJiYmO7nuy+5',
  'mJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiY/vf1',
  'Bxh7T9dcFCDpAAAAAElFTkSuQmCC',
].join('');

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 手写 base64 解码 —— Hermes 上 atob 的可用性随版本浮动，不赌它（与 license.ts 同一条理由） */
function base64ToBytes(text: string): Uint8Array {
  const s = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let pos = 0;
  for (const ch of s) {
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('二维码内联数据损坏');
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (value >>> bits) & 0xff;
    }
  }
  return out.subarray(0, pos);
}

/** 把内联副本落进 cache（幂等），返回可直接交给分享面板的 file:// uri */
function writeBundledQrToFile(): string {
  const target = new File(Paths.cache, 'wechat-qr.png');
  if (!target.exists) {
    target.create();
    target.write(base64ToBytes(QR_PNG_BASE64));
  }
  return target.uri;
}

/**
 * 把自己的二维码交给系统分享面板。
 *
 * 返回 false = 这台设备没有分享面板（罕见机型），由界面给出替代路径，
 * 不在这里弹错误 —— 调用方才知道该说什么。
 *
 * 不吞异常：分享面板本身报错（权限、目标应用崩了）要让调用方看见。
 */
export async function shareWechatQr(): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;

  const uri = writeBundledQrToFile();

  await Sharing.shareAsync(uri, {
    mimeType: 'image/png',
    dialogTitle: '分享微信二维码',
  });
  return true;
}
