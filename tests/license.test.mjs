/**
 * 激活码：发码端（tools/license.mjs，node:crypto/OpenSSL）与验签端（src/lib/license.ts，@noble）的互操作测试。
 *
 * 这两份实现刻意是**互相独立**的：
 *   - 发码脚本必须能裸 `node tools/license.mjs` 跑起来，所以不能 import TS；
 *   - App 端跑在 Hermes 上，没有 Buffer 也没有 node:crypto。
 * 于是「两边算法是否一致」不能靠代码共享来保证，只能靠这组测试来钉住。
 *
 * 覆盖：RFC 4648 标准向量、跨实现编解码一致、正常码通过、六类失败原因、
 * 篡改（载荷/签名/前缀/长度）、大小写与空白容错、公钥未配置时 fail-closed。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  verifyLicenseCode,
  isLicenseKeyUsable,
  normalizeLicenseCode,
  describeLicenseFailure,
  utf8ToBytes,
  bytesToUtf8,
  base32Encode,
  base32Decode,
  base64UrlToBytes,
  LICENSE_PUBLIC_KEY,
} from '../src/lib/license.ts';

import {
  CODE_PREFIX,
  makeKeypair,
  encodePayload,
  buildCode,
  parseCode,
  verifyCode,
  base32Encode as toolBase32Encode,
  base32Decode as toolBase32Decode,
  bytesToBase64Url,
} from '../tools/license.mjs';

/* ==================== 夹具 ==================== */

function freshKeypair() {
  const { privateJwk, publicKeyB64Url } = makeKeypair();
  return { privateJwk, publicKey: publicKeyB64Url };
}

function issue(keypair, overrides = {}) {
  const payload = { subject: 'me@outlook.com', date: '2026-10-08', seq: 42, ...overrides };
  const payloadJson = encodePayload(payload);
  return { payloadJson, code: buildCode(payloadJson, keypair.privateJwk) };
}

/** 拆出码的两段，便于构造篡改样本。 */
function split(code) {
  const body = code.slice(CODE_PREFIX.length + 1);
  const [segment, signature] = body.split('.');
  return { segment, signature };
}

/** 换掉一个字符，但保证换完仍在同一字符集里（长度不变）。 */
function mutateChar(text, index, alphabet) {
  const original = text[index];
  const replacement = alphabet.split('').find((c) => c !== original);
  return text.slice(0, index) + replacement + text.slice(index + 1);
}

/* ==================== 1. 编解码标准向量 ==================== */

test('Base32 与 RFC 4648 标准向量一致（两份实现都要对）', () => {
  const vectors = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  for (const [plain, expected] of vectors) {
    assert.equal(base32Encode(utf8ToBytes(plain)), expected, `src 编码 ${plain}`);
    assert.equal(toolBase32Encode(Buffer.from(plain, 'utf8')), expected, `tools 编码 ${plain}`);
    assert.equal(bytesToUtf8(base32Decode(expected)), plain, `src 解码 ${expected}`);
    assert.equal(Buffer.from(toolBase32Decode(expected)).toString('utf8'), plain, `tools 解码 ${expected}`);
  }
});

test('Base32 解码容忍大小写与填充，拒绝非法字符', () => {
  assert.equal(bytesToUtf8(base32Decode('mzxw6ytboi')), 'foobar');
  assert.equal(bytesToUtf8(base32Decode('MZXW6YTBOI======')), 'foobar');
  assert.throws(() => base32Decode('MZXW6YTB1'), /非法字符/);
  assert.throws(() => toolBase32Decode('MZXW6YTB0'), /非法字符/);
});

test('base64url 解码与 RFC 4648 一致，且接受无填充', () => {
  assert.equal(bytesToUtf8(base64UrlToBytes('Zm9vYmFy')), 'foobar');
  assert.equal(bytesToUtf8(base64UrlToBytes('Zm9vYmFy==')), 'foobar');
  assert.throws(() => base64UrlToBytes('Zm9v+bar'), /非法字符/);
});

test('UTF-8 手写实现与 Buffer 一致，含多字节与代理对', () => {
  for (const text of ['a', '格物', '日本語', 'emoji 🙂 ok', 'Ünïcödé', '汉字 ascii 混排']) {
    const mine = utf8ToBytes(text);
    assert.deepEqual(Buffer.from(mine), Buffer.from(text, 'utf8'), `编码 ${text}`);
    assert.equal(bytesToUtf8(mine), text, `解码 ${text}`);
  }
});

test('UTF-8 解码拒绝非法序列而不是当成乱码放过去', () => {
  assert.throws(() => bytesToUtf8(Uint8Array.from([0xff, 0xfe])), /非法/);
  assert.throws(() => bytesToUtf8(Uint8Array.from([0xe6, 0xa0])), /截断/);
  assert.throws(() => bytesToUtf8(Uint8Array.from([0xc0, 0x80])), /非法/);
});

/* ==================== 2. 两份实现的编解码必须逐字节一致 ==================== */

test('src 与 tools 的 Base32 在随机字节上逐字节一致', () => {
  for (let round = 0; round < 200; round++) {
    const bytes = crypto.randomBytes(round % 37);
    const mine = base32Encode(new Uint8Array(bytes));
    const theirs = toolBase32Encode(bytes);
    assert.equal(mine, theirs, `长度 ${bytes.length} 的第 ${round} 轮`);
    assert.deepEqual(Buffer.from(base32Decode(mine)), bytes);
    assert.deepEqual(Buffer.from(toolBase32Decode(mine)), bytes);
  }
});

/* ==================== 3. 正常码走通 ==================== */

test('node:crypto 签出的码能被 App 端 noble 验签通过', () => {
  const keypair = freshKeypair();
  const { code } = issue(keypair);

  const result = verifyLicenseCode(code, keypair.publicKey);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    subject: 'me@outlook.com',
    edition: 'supporter',
    issuedAt: '2026-10-08',
    serial: 42,
  });
});

test('码的形态符合方案页约定：GW1- 前缀 + Base32 段 + 点 + base64url 签名', () => {
  const keypair = freshKeypair();
  const { code, payloadJson } = issue(keypair);

  assert.match(code, /^GW1-[A-Z2-7]+\.[A-Za-z0-9_-]+$/);

  const { segment, signature } = split(code);
  assert.equal(bytesToUtf8(base32Decode(segment)), payloadJson);
  assert.equal(base64UrlToBytes(signature).length, 64);
  assert.deepEqual(JSON.parse(payloadJson), { e: 'me@outlook.com', t: 'sup', d: '2026-10-08', n: 42 });
});

test('同一载荷与同一私钥必须产出同一个码（签名是确定性的）', () => {
  const keypair = freshKeypair();
  const first = issue(keypair, { seq: 7 }).code;
  const second = issue(keypair, { seq: 7 }).code;
  assert.equal(first, second);
});

test('tools 的 verifyCode 与 src 的 verifyLicenseCode 结论一致', () => {
  const keypair = freshKeypair();
  const { code } = issue(keypair);

  const viaTool = verifyCode(code, keypair.publicKey);
  const viaApp = verifyLicenseCode(code, keypair.publicKey);

  assert.equal(viaTool.ok, true);
  assert.equal(viaApp.ok, true);
  assert.equal(viaApp.payload.serial, viaTool.payload.n);
  assert.equal(viaApp.payload.subject, viaTool.payload.e);
});

/* ==================== 4. 失败原因分类 ==================== */

test('空串与纯空白 → empty', () => {
  const keypair = freshKeypair();
  for (const input of ['', '   ', '\n\t ', null, undefined]) {
    assert.deepEqual(verifyLicenseCode(input, keypair.publicKey), { ok: false, reason: 'empty' });
  }
});

test('前缀、分隔符、字符集不对 → format', () => {
  const keypair = freshKeypair();
  const { code } = issue(keypair);

  for (const broken of [
    code.replace('GW1-', 'GW2-'),
    code.replace('.', ''), // 丢了分隔符
    `${code}.`, // 多一个点
    'GW1-ABC', // 没有签名段
    '完全不是码',
    `GW1-${split(code).segment}.!!!`, // 签名段有非法字符
  ]) {
    assert.deepEqual(verifyLicenseCode(broken, keypair.publicKey), { ok: false, reason: 'format' }, broken.slice(0, 24));
  }
});

test('载荷段不是合法 JSON → payload', () => {
  const keypair = freshKeypair();
  const bogusSegment = base32Encode(utf8ToBytes('这不是 JSON'));
  const { signature } = split(issue(keypair).code);
  const code = `GW1-${bogusSegment}.${signature}`;

  assert.deepEqual(verifyLicenseCode(code, keypair.publicKey), { ok: false, reason: 'payload' });
});

test('载荷 JSON 合法但字段缺失或类型不对 → payload', () => {
  const keypair = freshKeypair();
  for (const payloadJson of ['{}', '{"e":1,"t":"sup","d":"2026-10-08","n":1}', '{"e":"a","t":"sup","n":1.5}', 'null', '[1,2]']) {
    const code = buildCode(payloadJson, keypair.privateJwk);
    assert.deepEqual(verifyLicenseCode(code, keypair.publicKey), { ok: false, reason: 'payload' }, payloadJson);
  }
});

test('档位不认识 → edition（且必须排在验签之前就判掉）', () => {
  const keypair = freshKeypair();
  const code = buildCode('{"e":"a@b.com","t":"pro","d":"2026-10-08","n":1}', keypair.privateJwk);
  assert.deepEqual(verifyLicenseCode(code, keypair.publicKey), { ok: false, reason: 'edition' });
});

test('签名长度不对 → signature', () => {
  const keypair = freshKeypair();
  const { segment } = split(issue(keypair).code);
  const short = bytesToBase64Url(new Uint8Array(63));
  const long = bytesToBase64Url(new Uint8Array(65));

  assert.deepEqual(verifyLicenseCode(`GW1-${segment}.${short}`, keypair.publicKey), { ok: false, reason: 'signature' });
  assert.deepEqual(verifyLicenseCode(`GW1-${segment}.${long}`, keypair.publicKey), { ok: false, reason: 'signature' });
});

/* ==================== 5. 篡改 ==================== */

test('改载荷内容但留着原签名 → signature（不能只靠 JSON 解析通过就算数）', () => {
  const keypair = freshKeypair();
  const { code } = issue(keypair, { seq: 42 });
  const { signature } = split(code);

  // 把序号改成 9999，重新 Base32 编码，但沿用原签名
  const tamperedJson = encodePayload({ subject: 'me@outlook.com', date: '2026-10-08', seq: 9999 });
  const tamperedSegment = toolBase32Encode(Buffer.from(tamperedJson, 'utf8'));

  assert.deepEqual(verifyLicenseCode(`GW1-${tamperedSegment}.${signature}`, keypair.publicKey), {
    ok: false,
    reason: 'signature',
  });
});

test('改签名段一个字符 → signature', () => {
  const keypair = freshKeypair();
  const { segment, signature } = split(issue(keypair).code);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const broken = mutateChar(signature, 5, alphabet);

  assert.notEqual(broken, signature);
  assert.deepEqual(verifyLicenseCode(`GW1-${segment}.${broken}`, keypair.publicKey), { ok: false, reason: 'signature' });
});

test('换成别人的公钥 → signature（公钥来自 A、码来自 B）', () => {
  const mine = freshKeypair();
  const other = freshKeypair();
  const { code } = issue(other);

  assert.deepEqual(verifyLicenseCode(code, mine.publicKey), { ok: false, reason: 'signature' });
});

/* ==================== 6. 输入容错 ==================== */

test('微信/邮件里粘出来常带换行与空格，应当照常通过', () => {
  const keypair = freshKeypair();
  const { code } = issue(keypair);
  const wrapped = `${code.slice(0, 40)}\n  ${code.slice(40, 90)}\r\n${code.slice(90)}`;

  assert.equal(verifyLicenseCode(wrapped, keypair.publicKey).ok, true);
  assert.equal(normalizeLicenseCode(wrapped), code);
});

test('前缀与 Base32 段大小写不敏感，但签名绑定的是「大写段」这个正规形式', () => {
  const keypair = freshKeypair();
  const { code } = issue(keypair);
  const { segment, signature } = split(code);
  const lowered = `gw1-${segment.toLowerCase()}.${signature}`;

  // 小写写法两份实现都要接住
  assert.equal(verifyLicenseCode(lowered, keypair.publicKey).ok, true);
  assert.equal(verifyCode(lowered, keypair.publicKey).ok, true);

  // 反过来：先对小写段签，再拿来验 —— 不成立。正规形式只有大写一种。
  const key = crypto.createPrivateKey({ key: keypair.privateJwk, format: 'jwk' });
  const sigOverLower = crypto.sign(null, Buffer.from(segment.toLowerCase(), 'ascii'), key);
  assert.deepEqual(verifyLicenseCode(`GW1-${segment}.${bytesToBase64Url(sigOverLower)}`, keypair.publicKey), {
    ok: false,
    reason: 'signature',
  });
});

/* ==================== 7. 公钥兜底（fail-closed） ==================== */

test('公钥为空时任何码都必须被拒（fail-closed，且与仓库当前是否已 keygen 无关）', () => {
  const keypair = freshKeypair();
  const { code } = issue(keypair);

  // 显式传空公钥，而不是依赖「仓库里那行还是空串」——
  // 后者在 keygen 之后就不再成立，一条随仓库状态变化的测试等于没测
  assert.deepEqual(verifyLicenseCode(code, ''), { ok: false, reason: 'key' });
  assert.deepEqual(verifyLicenseCode('GW1-AAAA.AAAA', ''), { ok: false, reason: 'key' });
});

test('★ 发版自检：内置公钥已配置，且只认自己私钥签出来的码', () => {
  assert.equal(
    isLicenseKeyUsable(LICENSE_PUBLIC_KEY),
    true,
    'LICENSE_PUBLIC_KEY 还没回填（或填错了）：这个包发出去，用户拿什么码都激活不了',
  );

  // 反向证明：随便生成一把密钥签出来的码，内置公钥必须不认。
  // 这一条才是「公钥没写错、也没被写成万能钥匙」的真正证据。
  const stranger = freshKeypair();
  const { code } = issue(stranger);
  assert.deepEqual(verifyLicenseCode(code), { ok: false, reason: 'signature' });
});

test('公钥可用的判据：非空、32 字节、且不是全零', () => {
  const good = makeKeypair().publicKeyB64Url;

  assert.equal(isLicenseKeyUsable(good), true);
  assert.equal(isLicenseKeyUsable(''), false);
  assert.equal(isLicenseKeyUsable('AAAA'), false, '长度不足');
  assert.equal(isLicenseKeyUsable(bytesToBase64Url(new Uint8Array(32))), false, '全零必须判为不可用');
  assert.equal(isLicenseKeyUsable('!!!!'), false, '非法字符');
});

test('全零公钥即便绕过长度检查也不能放行（严格验签模式兜住 ZIP215 的小阶点语义）', () => {
  const zeroKey = bytesToBase64Url(new Uint8Array(32));
  const zeroSignature = bytesToBase64Url(new Uint8Array(64));
  const segment = base32Encode(utf8ToBytes('{"e":"a","t":"sup","d":"2026-10-08","n":1}'));

  assert.deepEqual(verifyLicenseCode(`GW1-${segment}.${zeroSignature}`, zeroKey), { ok: false, reason: 'key' });
});

/* ==================== 8. 工具侧自检 ==================== */

test('tools.parseCode 的原因码与 App 端同一套语义', () => {
  const keypair = freshKeypair();
  const { code } = issue(keypair);

  assert.equal(parseCode('').reason, 'empty');
  assert.equal(parseCode('乱码').reason, 'format');
  assert.equal(parseCode(code.replace('GW1-', 'GW2-')).reason, 'format');

  const { segment } = split(code);
  assert.equal(parseCode(`GW1-${segment}.${bytesToBase64Url(new Uint8Array(10))}`).reason, 'signature');

  const parsed = parseCode(code);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.e, 'me@outlook.com');
  assert.equal(parsed.signature.length, 64);
});

test('每个失败原因都有给人看的中文说明', () => {
  for (const reason of ['empty', 'format', 'payload', 'edition', 'signature', 'key']) {
    const text = describeLicenseFailure(reason);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, reason);
  }
});
