/**
 * 格物 · 财产清册 · 产物自检
 *
 * `printToFileAsync` 返回的 `numberOfPages` 是**估算**（安卓侧 = `1 + contentHeight / pageHeight`），
 * 内容正好整数页时会多报一页，被 `overflow:hidden` 裁掉时又照样报得很大。
 * 真正可信的是 PDF 文件本身 —— 数一下里面有几个 `/Type /Page`。
 *
 * 纯函数、不碰文件系统：这样可以用一段假的 PDF 字节在 `node:test` 里钉住。
 */

const SLASH = 0x2f;
const WHITESPACE = new Set([0x20, 0x0a, 0x0d, 0x09, 0x0c, 0x00]);

function matchesAt(bytes: Uint8Array, index: number, token: string): boolean {
  if (index < 0 || index + token.length > bytes.length) return false;
  for (let k = 0; k < token.length; k += 1) {
    if (bytes[index + k] !== token.charCodeAt(k)) return false;
  }
  return true;
}

/**
 * 真实页数 = `/Type /Page` 出现的次数。
 *
 * `/Type /Pages`（PDF 的目录节点）必须排除，否则每本册子都会多算一页。
 */
export function countPdfPages(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== SLASH) continue;
    if (!matchesAt(bytes, i, '/Type')) continue;
    let j = i + 5;
    while (j < bytes.length && WHITESPACE.has(bytes[j])) j += 1;
    if (!matchesAt(bytes, j, '/Page')) continue;
    // 后一个字符是 s → 这是 /Pages 目录节点，不是页
    if (bytes[j + 5] === 0x73) continue;
    count += 1;
  }
  return count;
}
