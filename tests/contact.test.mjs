/**
 * 联系我 · 内联二维码副本的完整性。
 *
 * contact.ts import 了 expo-file-system / expo-sharing（原生模块），
 * 整个文件进不了 node:test —— 所以这里不 import 它，而是**读源码、
 * 把 base64 抠出来解码**，与 assets 里那张 PNG 逐字节比对。
 * （与 theme.ts 的取值同一个思路：不能 import 的就读文件。）
 *
 * 这条钉的是：换了二维码图、却忘了重新生成内联副本 ——
 * 那种不一致**没有任何运行时报错**，用户分享出去的会是旧码。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('内联的二维码 base64 与 assets 里的 PNG 逐字节一致', () => {
  const source = readFileSync('src/lib/contact.ts', 'utf-8');
  const m = source.match(/const QR_PNG_BASE64 = \[\r?\n([\s\S]*?)\r?\n\]\.join\(''\)/);
  assert.ok(m, 'contact.ts 里找不到 QR_PNG_BASE64 —— 结构变了还是被删了？');

  const b64 = m[1]
    .split("'")
    .filter((s) => /^[A-Za-z0-9+/]{10,}$/.test(s))
    .join('');
  assert.ok(b64.length > 1000, '抠出来的数据异常地短');

  const decoded = Buffer.from(b64, 'base64');
  const png = readFileSync('assets/images/wechat-qr.png');

  assert.equal(decoded.length, png.length, '字节数不同 —— 二维码图更新过，内联副本没跟上');
  assert.ok(decoded.equals(png), '内容不同 —— 二维码图更新过，内联副本没跟上');

  /* PNG 魔数兜底：万一两边同时坏掉，至少能发现解码结果根本不是 PNG */
  assert.equal(decoded.subarray(0, 4).toString('hex'), '89504e47', '解码结果不是 PNG');
});
