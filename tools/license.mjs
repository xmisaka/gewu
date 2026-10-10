#!/usr/bin/env node
/**
 * 格物 · 激活码签发工具（完全离线，零第三方依赖）
 *
 * 码的形态：
 *   GW1-<Base32(载荷 JSON 的 UTF-8 字节)>.<Base64URL(64 字节 Ed25519 签名)>
 *
 * 签名覆盖的消息 = 大写化之后的前半段（Base32 载荷段）的 ASCII 字节。
 * 之所以签「编码后的字符串」而不是「载荷 JSON」，是为了彻底避开 JSON 规范化问题：
 * 验签方不需要重新序列化一遍载荷，直接把收到的字符串当字节喂给验签即可。
 * 先规范成大写，是因为 Base32 大小写是同一份数据的两种写法，签名只能落在正规形式上。
 *
 * 依赖只有 node:crypto（OpenSSL 的 Ed25519）—— 发码端不需要装任何 npm 包。
 * 私钥落在 ~/.gewu/license_key.json，**不进仓库、不进 App、不进备份**。
 *
 * 子命令：
 *   keygen            生成密钥对（一次性动作）
 *   keygen --show     只打印公钥，不重新生成
 *   issue             签发激活码
 *   verify            用公钥自检一个码
 *   ledger            导出台账（对账 / 查重）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CODE_PREFIX = 'GW1';
export const EDITION = 'sup';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_RE = /^[A-Za-z2-7]+$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 密钥与台账的落盘位置。默认 ~/.gewu；`GEWU_LICENSE_DIR` 可覆盖 ——
 * 一来测试能在临时目录里跑完整命令行而不碰真实密钥，二来你可以把密钥放到别的盘或同步盘。
 */
export const HOME_DIR = process.env.GEWU_LICENSE_DIR || path.join(os.homedir(), '.gewu');
export const KEY_FILE = path.join(HOME_DIR, 'license_key.json');
export const LEDGER_FILE = path.join(HOME_DIR, 'license_ledger.jsonl');

/** 码的形状。`i` 只影响字面的 `GW1-` 前缀；字符类本就覆盖大小写，签名段的大小写不会被折叠。 */
const CODE_RE = new RegExp(`^${CODE_PREFIX}-([A-Za-z2-7]+)\\.([A-Za-z0-9_-]+)$`, 'i');

/* ==================== 编解码（纯函数，可测） ==================== */

/** RFC 4648 Base32，无填充。大小写不敏感（解码时统一转大写）。 */
export function base32Encode(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const s = String(text).toUpperCase().replace(/=+$/, '');
  if (!s) return new Uint8Array(0);
  if (!B32_RE.test(s)) throw new Error('Base32 非法字符');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const c of s) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function base64UrlToBytes(text) {
  const s = String(text).replace(/=+$/, '');
  if (!B64URL_RE.test(s)) throw new Error('base64url 非法字符');
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/* ==================== 码的构造与解析 ==================== */

/**
 * 载荷 JSON。键顺序固定为 e, t, d, n —— JSON.stringify 对字符串键按插入序输出，
 * 因此序列化结果是确定性的，这一点是签名可复现的前提。
 */
export function encodePayload({ subject, date, seq }) {
  return JSON.stringify({ e: subject, t: EDITION, d: date, n: seq });
}

/** 用私钥 JWK 对一个载荷签出完整的码。 */
export function buildCode(payloadJson, privateJwk) {
  const segment = base32Encode(Buffer.from(payloadJson, 'utf8'));
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const sig = crypto.sign(null, Buffer.from(segment, 'ascii'), key);
  return `${CODE_PREFIX}-${segment}.${bytesToBase64Url(sig)}`;
}

/**
 * 解析一个码。只做形状与编码层面的检查，不验签。
 * 输入容错：剥掉所有空白（微信/邮件换行是常态）、前缀大小写不敏感。
 */
export function parseCode(code) {
  const raw = String(code ?? '').replace(/\s+/g, '');
  if (!raw) return { ok: false, reason: 'empty' };

  const m = CODE_RE.exec(raw);
  if (!m) return { ok: false, reason: 'format' };

  const [, segment, sigText] = m;

  let payloadJson;
  try {
    payloadJson = Buffer.from(base32Decode(segment)).toString('utf8');
  } catch {
    return { ok: false, reason: 'payload' };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'payload' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload' };

  let signature;
  try {
    signature = Buffer.from(base64UrlToBytes(sigText));
  } catch {
    return { ok: false, reason: 'signature' };
  }
  if (signature.length !== 64) return { ok: false, reason: 'signature' };

  return { ok: true, segment, payloadJson, payload, signature };
}

/** 解析 + 验签。publicKeyB64Url 为 32 字节原始公钥的 base64url。 */
export function verifyCode(code, publicKeyB64Url) {
  const parsed = parseCode(code);
  if (!parsed.ok) return parsed;

  let publicKey;
  try {
    publicKey = base64UrlToBytes(publicKeyB64Url);
  } catch {
    return { ok: false, reason: 'key' };
  }
  if (publicKey.length !== 32) return { ok: false, reason: 'key' };

  let good = false;
  try {
    const keyObject = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyB64Url },
      format: 'jwk',
    });
    // 消息取**大写**段 —— 与 App 端 src/lib/license.ts 保持一致。
    // Base32 大小写是同一份数据的两种写法，签名只在正规形式（大写）上成立。
    good = crypto.verify(null, Buffer.from(parsed.segment.toUpperCase(), 'ascii'), keyObject, parsed.signature);
  } catch {
    return { ok: false, reason: 'signature' };
  }

  if (!good) return { ok: false, reason: 'signature' };
  return { ok: true, payload: parsed.payload };
}

/** 生成一对 Ed25519 密钥。私钥以 JWK 形态返回，公钥是 32 字节原始字节的 base64url。 */
export function makeKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateJwk: privateKey.export({ format: 'jwk' }),
    publicKeyB64Url: publicKey.export({ format: 'jwk' }).x,
  };
}

/* ==================== 本地文件 ==================== */

export function ensureHomeDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
}

export function readKeyFile() {
  if (!fs.existsSync(KEY_FILE)) return null;
  return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
}

export function readLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  return fs
    .readFileSync(LEDGER_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 追加台账。导出给 tools/license-batch.mjs 复用 —— 台账只留一个写入者，格式才不会分叉。 */
export function appendLedger(entries) {
  ensureHomeDir();
  fs.appendFileSync(LEDGER_FILE, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

export function todayLocal() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function publicKeyConstantLine(publicKeyB64Url) {
  return `export const LICENSE_PUBLIC_KEY = '${publicKeyB64Url}';`;
}

/* ==================== 命令行 ==================== */

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

const HELP = `格物 · 激活码签发工具

  node tools/license.mjs keygen [--force]        生成密钥对（--force 覆盖已有）
  node tools/license.mjs keygen --show           只打印公钥，不重新生成
  node tools/license.mjs issue --email a@b.com   签发 1 个码
  node tools/license.mjs issue --order 2026...   以订单号代替邮箱
  node tools/license.mjs issue --label "张三" --count 3 --out codes.txt
  node tools/license.mjs verify --code GW1-...   用公钥自检一个码
  node tools/license.mjs ledger [--check]        导出台账（--check 顺带查重）`;

function cmdKeygen(flags) {
  const existing = readKeyFile();

  if (flags.show) {
    if (!existing) {
      console.error('还没有密钥。先跑 `node tools/license.mjs keygen`。');
      process.exitCode = 1;
      return;
    }
    console.log('公钥（把它粘进 src/lib/license.ts）：\n');
    console.log(publicKeyConstantLine(existing.publicKey));
    return;
  }

  if (existing && !flags.force) {
    console.error(`密钥已存在：${KEY_FILE}`);
    console.error('拒绝覆盖（覆盖会让**所有已发出的激活码立即失效**）。确实要换就用 --force。');
    process.exitCode = 1;
    return;
  }

  const { privateJwk, publicKeyB64Url } = makeKeypair();
  ensureHomeDir();
  fs.writeFileSync(
    KEY_FILE,
    JSON.stringify({ v: 1, createdAt: new Date().toISOString(), publicKey: publicKeyB64Url, privateJwk }, null, 2),
    { mode: 0o600 },
  );

  console.log(`私钥已写入：${KEY_FILE}（权限 600）\n`);
  console.log('把下面这行粘进 src/lib/license.ts：\n');
  console.log(publicKeyConstantLine(publicKeyB64Url));
  console.log(`
接下来立刻做两件事：
  ① 离线双备份这个文件（一份加密压缩放网盘、一份放另一台机器）——
     丢了它 = 再也发不出新码（已发出的仍然有效）。
  ② 别把它提交进 git、别放进 App、别放进备份包。`);
}

function cmdIssue(flags) {
  const keyFile = readKeyFile();
  if (!keyFile) {
    console.error('没有私钥。先跑 `node tools/license.mjs keygen`。');
    process.exitCode = 1;
    return;
  }

  const subject = flags.email || flags.order || flags.label;
  if (typeof subject !== 'string' || !subject.trim()) {
    console.error('要指定 --email / --order / --label 之一，作为码里的标识。');
    process.exitCode = 1;
    return;
  }

  const count = Math.max(1, Number.parseInt(flags.count ?? '1', 10) || 1);
  const date = typeof flags.date === 'string' ? flags.date : todayLocal();

  const ledger = readLedger();
  const maxSeq = ledger.reduce((acc, e) => (Number.isFinite(e.n) && e.n > acc ? e.n : acc), 0);

  const issued = [];
  for (let i = 1; i <= count; i++) {
    const seq = maxSeq + i;
    const payloadJson = encodePayload({ subject: subject.trim(), date, seq });
    const code = buildCode(payloadJson, keyFile.privateJwk);
    issued.push({ n: seq, e: subject.trim(), d: date, issuedAt: new Date().toISOString(), code });
  }

  appendLedger(issued);

  for (const item of issued) {
    console.log(`${item.code}`);
  }

  console.error(`\n已签发 ${issued.length} 个码（序号 ${issued[0].n}~${issued[issued.length - 1].n}），台账：${LEDGER_FILE}`);
  console.error(`标识：${subject.trim()}  签发日期：${date}`);

  if (typeof flags.out === 'string') {
    fs.writeFileSync(flags.out, issued.map((i) => i.code).join('\n') + '\n', 'utf8');
    console.error(`码已写入文件：${flags.out}（可直接逐行粘进爱发电「自动随机回复」）`);
  }
}

function cmdVerify(flags) {
  const keyFile = readKeyFile();
  const code = typeof flags.code === 'string' ? flags.code : null;
  if (!code) {
    console.error('用法：node tools/license.mjs verify --code GW1-...');
    process.exitCode = 1;
    return;
  }
  if (!keyFile) {
    console.error('没有公钥（~/.gewu/license_key.json 不存在）——无法自检。');
    process.exitCode = 1;
    return;
  }

  const result = verifyCode(code, keyFile.publicKey);
  if (result.ok) {
    console.log('验签通过');
    console.log(JSON.stringify(result.payload, null, 2));
  } else {
    console.log(`验签失败：${result.reason}`);
    process.exitCode = 1;
  }
}

function cmdLedger(flags) {
  const ledger = readLedger();
  if (!ledger.length) {
    console.log('台账为空。');
    return;
  }

  console.log('序号\t签发日期\t标识\t码');
  for (const e of ledger) {
    console.log(`${e.n}\t${e.d}\t${e.e}\t${e.code}`);
  }
  console.log(`\n共 ${ledger.length} 条。`);

  if (flags.check) {
    const bySeq = new Map();
    const byCode = new Map();
    const dupes = [];
    for (const e of ledger) {
      if (bySeq.has(e.n)) dupes.push(`序号 ${e.n} 重复`);
      bySeq.set(e.n, true);
      if (byCode.has(e.code)) dupes.push(`码重复（序号 ${e.n} / ${byCode.get(e.code)}）`);
      byCode.set(e.code, e.n);
    }
    console.log(dupes.length ? `\n发现问题：\n  ${dupes.join('\n  ')}` : '\n查重通过：序号与码均无重复。');
  }

  console.log(`\n台账文件：${LEDGER_FILE}`);
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  switch (command) {
    case 'keygen':
      cmdKeygen(flags);
      break;
    case 'issue':
      cmdIssue(flags);
      break;
    case 'verify':
      cmdVerify(flags);
      break;
    case 'ledger':
      cmdLedger(flags);
      break;
    default:
      console.log(HELP);
      if (command) process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
