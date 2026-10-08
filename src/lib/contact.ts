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
 *
 * 上面那两个色值是微信绿与纯白，刻意**不**从 theme.ts 取 —— 它们属于这张图片，
 * 不属于皮肤。任何一套主题下二维码都得是深色模块压浅色底，否则扫不出来。
 */

import { Asset } from 'expo-asset';
import * as Sharing from 'expo-sharing';

/* 项目里没有 `declare module '*.png'`，静态 import 会直接报 TS2307；
   用 require 取模块号（expo-image 的 source 与 expo-asset 的 fromModule 都吃这个），
   与 src/lib/id.ts 取 expo-crypto 的写法一致 */
const QR_MODULE = require('../../assets/images/wechat-qr.png') as number;

/** 交给 <Image> 的 source（不要在这里再包一层 uri） */
export const WECHAT_QR = QR_MODULE;

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

  /* 打包进 APK 的资源在运行时没有可直接分享的路径：
     downloadAsync() 会把它落到 cache 目录，localUri 才是能交给分享面板的 file:// */
  const asset = Asset.fromModule(QR_MODULE);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;

  await Sharing.shareAsync(uri, {
    mimeType: 'image/png',
    dialogTitle: '分享微信二维码',
  });
  return true;
}
