/**
 * 格物 · 激活码验签（纯函数，完全离线）
 *
 * 码的形态：
 *   GW1-<Base32(载荷 JSON 的 UTF-8 字节)>.<Base64URL(64 字节 Ed25519 签名)>
 *
 * 签名覆盖的消息是**大写化之后的前半段（Base32 载荷段）的 ASCII 字节**，不是载荷 JSON。
 * 这样验签方不需要重新序列化载荷，从根上避开 JSON 键序/空白导致的「同一份内容两串字节」问题；
 * 而先规范成大写，是因为 Base32 大小写只是同一份数据的两种写法，签名只能落在唯一那个正规形式上。
 *
 * 三条刻意的约束：
 *
 * 1. **不碰 `Buffer`、也不碰 `TextEncoder`/`TextDecoder`** —— Hermes 上前两者的可用性
 *    随版本浮动，UTF-8 与两种编码的解码都在本文件手写，行为只取决于 ECMAScript 本身。
 *
 * 2. **只验签，不签名**，因此不需要 `react-native-get-random-values` 之类的原生随机数 polyfill ——
 *    这项能力没有引入任何新的原生模块或权限。
 *
 * 3. **验签用严格模式（`zip215: false`）**。ZIP215 语义下「全零公钥」对任意签名都返回通过，
 *    一旦公钥常量配错成空值/全零就会变成对谁都放行；严格模式会拒掉它，代价为零。
 *    即便如此，本文件仍然对公钥本身做长度与非零校验，双保险。
 *
 * 这里不评估「码是否已被撤销」「是否超出台数」—— 那些是服务端的事，而本方案已决定不做。
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

/**
 * 支持者档验签公钥：32 字节原始 Ed25519 公钥的 base64url。
 *
 * 执行 `node tools/license.mjs keygen` 后，把输出的那一行粘到这里。
 * **留空 = 未配置 = 所有码一律拒绝**（fail-closed：宁可全部不通过，也不能全部通过）。
 */
export const LICENSE_PUBLIC_KEY = '0WsOA9ihEbMtrbVCsj_D9dEo14qmgQ7FgF97DbqhnY4';

const CODE_PREFIX = 'GW1';
const EDITION_SUPPORTER = 'sup';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_RE = /^[A-Za-z2-7]+$/;
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BYTES = 32;

/**
 * 码的形状。`i` 只影响字面的 `GW1-` 前缀（用户手打时可能写成 gw1）；
 * 两个字符类本就覆盖大小写，签名段的字母大小写对签名本身有意义，不会被折叠。
 */
const CODE_RE = new RegExp(`^${CODE_PREFIX}-([A-Za-z2-7]+)\\.([A-Za-z0-9_-]+)$`, 'i');

export type LicenseEdition = 'supporter';

export type LicensePayload = {
  /** 邮箱、订单号或备注，签发时写入 */
  subject: string;
  edition: LicenseEdition;
  /** 签发日期，YYYY-MM-DD */
  issuedAt: string;
  /** 签发序号，用于对账与查重 */
  serial: number;
};

export type LicenseFailureReason =
  /** 空串或只有空白 */
  | 'empty'
  /** 形状不对：前缀、分隔符、字符集 */
  | 'format'
  /** 载荷段解不开：Base32、UTF-8 或 JSON 有问题 */
  | 'payload'
  /** 载荷能读，但档位不认识（不是本版本支持的档） */
  | 'edition'
  /** 签名不对：长度不对、或验签不通过 */
  | 'signature'
  /** 公钥未配置或非法 */
  | 'key';

export type LicenseResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: LicenseFailureReason };

/* ==================== 编解码 ==================== */

/** UTF-8 编码。手写而不用 TextEncoder —— 见文件头第 1 条。 */
export function utf8ToBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
        i++;
      } else {
        out.push(0xef, 0xbf, 0xbd);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 解码。遇到非法序列直接抛，由调用方映射成 payload 失败。 */
export function bytesToUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i];
    let point: number;
    let size: number;

    if (lead < 0x80) {
      point = lead;
      size = 1;
    } else if ((lead & 0xe0) === 0xc0) {
      point = lead & 0x1f;
      size = 2;
    } else if ((lead & 0xf0) === 0xe0) {
      point = lead & 0x0f;
      size = 3;
    } else if ((lead & 0xf8) === 0xf0) {
      point = lead & 0x07;
      size = 4;
    } else {
      throw new Error('UTF-8 首字节非法');
    }

    if (i + size > bytes.length) throw new Error('UTF-8 截断');

    for (let k = 1; k < size; k++) {
      const cont = bytes[i + k];
      if ((cont & 0xc0) !== 0x80) throw new Error('UTF-8 续字节非法');
      point = (point << 6) | (cont & 0x3f);
    }
    i += size;

    const overlong = (size === 2 && point < 0x80) || (size === 3 && point < 0x800) || (size === 4 && point < 0x10000);
    if (overlong || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      throw new Error('UTF-8 码点非法');
    }

    if (point > 0xffff) {
      const v = point - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      out += String.fromCharCode(point);
    }
  }
  return out;
}

/** RFC 4648 Base32 解码，无填充，大小写不敏感。 */
export function base32Decode(text: string): Uint8Array {
  const s = text.toUpperCase().replace(/=+$/, '');
  if (!s) return new Uint8Array(0);
  if (!B32_RE.test(s)) throw new Error('Base32 非法字符');

  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 给测试用的编码方向，App 运行时用不到（发码在 tools/license.mjs）。 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** base64url 解码，手写而不用 Buffer/atob。 */
export function base64UrlToBytes(text: string): Uint8Array {
  const s = text.replace(/=+$/, '');
  if (!s) return new Uint8Array(0);
  if (!B64URL_RE.test(s)) throw new Error('base64url 非法字符');

  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    value = (value << 6) | B64URL_ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/* ==================== noble 接线 ==================== */

let hasherReady = false;

/** 同步验签需要显式接上 SHA-512（Hermes 没有 crypto.subtle，异步路径在这里用不上）。 */
function ensureHasher(): void {
  if (hasherReady) return;
  ed.hashes.sha512 = sha512;
  hasherReady = true;
}

/* ==================== 载荷 ==================== */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPayload(payloadJson: string): LicenseResult | { ok: false; reason: 'payload' | 'edition' } {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'payload' };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: 'payload' };

  const { e, t, d, n } = raw;
  if (typeof e !== 'string' || typeof d !== 'string' || !Number.isInteger(n)) {
    return { ok: false, reason: 'payload' };
  }
  if (t !== EDITION_SUPPORTER) return { ok: false, reason: 'edition' };

  return {
    ok: true,
    payload: { subject: e, edition: 'supporter', issuedAt: d, serial: n as number },
  };
}

/* ==================== 对外 API ==================== */

/** 剥掉所有空白。微信、邮件里粘出来常带换行，这属于正常输入而非错误。 */
export function normalizeLicenseCode(code: string): string {
  return (code ?? '').replace(/\s+/g, '');
}

/** 公钥是否可用：非空、能解码成 32 字节、且不是全零。 */
export function isLicenseKeyUsable(publicKeyB64Url: string): boolean {
  if (!publicKeyB64Url) return false;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(publicKeyB64Url);
  } catch {
    return false;
  }
  if (bytes.length !== PUBLIC_KEY_BYTES) return false;
  return bytes.some((b) => b !== 0);
}

/**
 * 验签。默认用内置公钥；显式传第二参可覆盖（测试与「换密钥」预案用）。
 */
export function verifyLicenseCode(code: string, publicKeyB64Url: string = LICENSE_PUBLIC_KEY): LicenseResult {
  const normalized = normalizeLicenseCode(code);
  if (!normalized) return { ok: false, reason: 'empty' };

  const match = CODE_RE.exec(normalized);
  if (!match) return { ok: false, reason: 'format' };

  const [, segment, signatureText] = match;

  if (!isLicenseKeyUsable(publicKeyB64Url)) return { ok: false, reason: 'key' };

  let payloadJson: string;
  try {
    payloadJson = bytesToUtf8(base32Decode(segment));
  } catch {
    return { ok: false, reason: 'payload' };
  }

  const payloadResult = readPayload(payloadJson);
  if (!payloadResult.ok) return payloadResult;

  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = base64UrlToBytes(signatureText);
    publicKey = base64UrlToBytes(publicKeyB64Url);
  } catch {
    return { ok: false, reason: 'signature' };
  }
  if (signature.length !== SIGNATURE_BYTES) return { ok: false, reason: 'signature' };

  ensureHasher();

  let valid = false;
  try {
    // 严格模式：ZIP215 语义会放过「小阶/全零公钥 + 任意签名」这种组合，见文件头第 3 条。
    // 消息取**大写**段：Base32 的字母表是大写 A–Z2–7，大小写是同一份数据的两种写法，
    // 而签名只在唯一的正规形式上成立 —— 不先规范化，用户粘一个小写的码就会验签失败。
    valid = ed.verify(signature, asciiBytes(segment.toUpperCase()), publicKey, { zip215: false });
  } catch {
    return { ok: false, reason: 'signature' };
  }

  if (!valid) return { ok: false, reason: 'signature' };

  return { ok: true, payload: payloadResult.payload };
}

/** 签名的消息是 Base32 载荷段的 ASCII 字节（段内只可能是 A-Z 与 2-7，逐字节取低 7 位即可）。 */
function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

const REASON_TEXT: Record<LicenseFailureReason, string> = {
  empty: '请先粘贴激活码',
  format: '这串码的格式不对，请整串复制（以 GW1- 开头）',
  payload: '这串码读不出来，可能复制时缺了一段',
  edition: '这串码对应的档位在当前版本里没有',
  signature: '这串码没有通过校验，请确认是从订单里原样复制的',
  key: '当前版本没有内置可用的校验公钥',
};

/** 把失败原因翻成能直接显示给用户的一句话。 */
export function describeLicenseFailure(reason: LicenseFailureReason): string {
  return REASON_TEXT[reason];
}
