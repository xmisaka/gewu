/**
 * 支持者档权益（纯逻辑层）的测试。
 *
 * 这里**不碰数据库**：本文件只 import `src/lib/entitlement.ts`，
 * 它刻意不依赖 `@/lib/db`（那份依赖 expo-sqlite，在 node:test 里加载不了）。
 * 存取与 React 运行时由各自那一层负责，也就不在这里测。
 *
 * 覆盖：码 → 权益态的折算、四类拒绝、门控表的形状、
 * 以及两条「判错不会报错但后果很大」的规则（皮肤白名单、玄夜不可锁）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  checkActivation,
  entitlementFromCode,
  FREE_ENTITLEMENT,
  isThemeLocked,
  SUPPORTER_FEATURES,
  SUPPORTER_THEME_KEYS,
} from '../src/lib/entitlement.ts';

import { buildCode, encodePayload, makeKeypair } from '../tools/license.mjs';

/*
 * 主题常量从**源码里读**，而不是 import `src/constants/theme.ts`：
 * 那个文件 import 了 react-native，在 node:test 里根本加载不了。
 * 读源码只为拿两个列表，正则完全够用，也不会因为平台差异而假失败。
 */
const themeSource = readFileSync(new URL('../src/constants/theme.ts', import.meta.url), 'utf8');

function readKeyList(name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]+)\\]`).exec(themeSource);
  assert.ok(match, `没在 theme.ts 里找到 ${name}`);
  return match[1]
    .split(',')
    .map((piece) => piece.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

const LIGHT_THEME_KEYS = readKeyList('LIGHT_THEME_KEYS');
const DARK_THEME_KEY = /DARK_THEME_KEY:\s*ThemeKey\s*=\s*'([^']+)'/.exec(themeSource)?.[1];

/* ==================== 夹具 ==================== */

function freshKeypair() {
  const { privateJwk, publicKeyB64Url } = makeKeypair();
  return { privateJwk, publicKey: publicKeyB64Url };
}

/** 用测试密钥签一个码；验的时候要把 publicKey 一起传进去 */
function issue(keypair, overrides = {}) {
  const payload = { subject: 'me@outlook.com', date: '2026-10-08', seq: 42, ...overrides };
  return buildCode(encodePayload(payload), keypair.privateJwk);
}

/* ==================== 1. 码 → 权益态 ==================== */

test('有效码折成支持者档，签发日期与标识都带出来', () => {
  const keypair = freshKeypair();
  const code = issue(keypair, { subject: 'zhangsan@outlook.com', date: '2026-10-08' });

  const ent = entitlementFromCode(code, keypair.publicKey);
  assert.equal(ent.entitled, true);
  assert.equal(ent.edition, 'sup');
  assert.equal(ent.issuedOn, '2026-10-08');
  assert.equal(ent.label, 'zhangsan@outlook.com');
  assert.equal(ent.code, code, '存回去的就是验通的那串码');
});

test('中文标识能原样带出来（载荷是 UTF-8，不走 JSON 转义）', () => {
  const keypair = freshKeypair();
  const code = issue(keypair, { subject: '张三' });

  assert.equal(entitlementFromCode(code, keypair.publicKey).label, '张三');
});

test('首尾空白被去掉、前缀大小写不敏感，但签名段的大小写一个字符都不能动', () => {
  const keypair = freshKeypair();
  const code = issue(keypair);

  // 前缀写成小写、前后带空白：仍然验得过
  const messy = `  ${code.slice(0, 3).toLowerCase()}${code.slice(3)}  `;
  const ent = entitlementFromCode(messy, keypair.publicKey);
  assert.equal(ent.entitled, true);
  assert.equal(ent.code, messy.trim(), '存下来的是去掉首尾空白后的那一串（前缀大小写原样保留）');

  /*
   * 为什么不做「整体大写化」这种更彻底的规范化：签名段是 base64url，
   * 大小写是**有信息量的**，整体大写会把签名毁掉。
   * 所以能做的只有 trim，其余交给验签时的内部规范化（消息取大写段）。
   */
  assert.equal(
    entitlementFromCode(`${code.slice(0, 3)}${code.slice(3).toLowerCase()}`, keypair.publicKey).entitled,
    false,
    '把载荷段之外的内容整体小写会破坏签名段 —— 这正是不能「彻底规范化」的原因',
  );
});

/* ==================== 2. 拒绝路径一律降为免费档 ==================== */

test('空串、空白、null、undefined 都回免费档（不能因为「没填」就默认给权限）', () => {
  for (const value of ['', '   ', '\n', null, undefined]) {
    assert.deepEqual(entitlementFromCode(value), FREE_ENTITLEMENT);
  }
});

test('字符串但形状不对 → 免费档', () => {
  assert.deepEqual(entitlementFromCode('随便写点什么'), FREE_ENTITLEMENT);
  assert.deepEqual(entitlementFromCode('GW2-AAAA.AAAA'), FREE_ENTITLEMENT);
});

test('★ 别的密钥签出来的码必须被拒（否则公钥等于形同虚设）', () => {
  const real = freshKeypair();
  const stranger = freshKeypair();
  const code = issue(stranger);

  assert.deepEqual(entitlementFromCode(code, real.publicKey), FREE_ENTITLEMENT);
});

/**
 * 改掉签名段里**有意义的**一个字符，用来验「被改过的码会被拒」。
 *
 * ★ 为什么不能改末尾 —— 这个用例曾经是**间歇性假失败**的（约每 6 次红 1 次）：
 * base64 每 4 个字符编码 3 字节，64 字节的签名最后只剩 1 个字节，
 * 于是末字符里 4 个 bit 是**填充位**，解码时被丢掉。
 * 改末字符有一半左右的概率落在填充位上 —— 解码出来的字节完全相同，
 * 签名照样验通，断言就红了，而代码其实一点问题都没有。
 * 改**第一个**字符必然动到首字节的高位，没有这种巧合。
 */
function tamperSignature(code) {
  const at = code.indexOf('.') + 1;
  assert.ok(at > 0, '码里必须有签名段');
  const original = code[at];
  return `${code.slice(0, at)}${original === 'A' ? 'B' : 'A'}${code.slice(at + 1)}`;
}

test('库里的历史遗留值若是被改过的，自然降为免费档（档位是算出来的，读不出来）', () => {
  const keypair = freshKeypair();
  const tampered = tamperSignature(issue(keypair));

  assert.deepEqual(entitlementFromCode(tampered, keypair.publicKey), FREE_ENTITLEMENT);
});

/* ==================== 3. checkActivation：校验与落盘分离 ==================== */

test('checkActivation 通过时给出权益态，且不改动入参', () => {
  const keypair = freshKeypair();
  const raw = `  ${issue(keypair)}  `;
  const snapshot = raw;

  const outcome = checkActivation(raw, keypair.publicKey);
  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.entitlement.entitled, true);
  assert.equal(raw, snapshot, '纯函数不该动传进来的字符串');
});

test('checkActivation 拒绝时带上原因与可直接显示的一句话', () => {
  const empty = checkActivation('');
  assert.equal(empty.kind, 'rejected');
  assert.equal(empty.reason, 'empty');
  assert.ok(empty.message.length > 0, '拒绝必须附带人话文案，界面不再另写一份');

  const junk = checkActivation('不是码');
  assert.equal(junk.kind, 'rejected');
  assert.equal(junk.reason, 'format');

  const keypair = freshKeypair();
  const stray = checkActivation(issue(keypair), freshKeypair().publicKey);
  assert.equal(stray.kind, 'rejected');
  assert.equal(stray.reason, 'signature');
});

test('公钥为空串时一律拒绝，且原因是 key（这条与仓库是否已 keygen 无关）', () => {
  const keypair = freshKeypair();
  const outcome = checkActivation(issue(keypair), '');

  assert.equal(outcome.kind, 'rejected');
  assert.equal(outcome.reason, 'key');
});

/* ==================== 4. 门控表 ==================== */

test('三处功能都有门控文案，且都写明了「免费档没有被拿掉什么」', () => {
  /*
   * 注意：本文件是 .mjs，`--experimental-strip-types` 只处理 .ts ——
   * 这里写 `as const` / `as readonly string[]` 会直接 SyntaxError（不是类型报错，是解析失败）。
   */
  for (const key of ['theme', 'batch', 'ai', 'stats']) {
    const copy = SUPPORTER_FEATURES[key];
    assert.ok(copy, `${key} 缺文案`);
    assert.equal(copy.sheetTitle, '支持者功能');
    assert.ok(copy.sheetBody.length > 20, `${key} 的正文太短，讲不清边界`);
    assert.ok(
      /免费档|不受影响|照旧/.test(copy.sheetBody),
      `${key} 的正文没有交代免费档的处境 —— 这是没有商店背书时最该讲清的一句`,
    );
  }
});

test('★ 锁的恰好是那三套会员色，免费三套都不在其中', () => {
  assert.deepEqual([...SUPPORTER_THEME_KEYS], ['zhusha', 'ouhe', 'yanzhi']);

  /* 免费档必须有**三套**浅色可用，这不是随手定的数字：
     只给一套时，用户在「我到底能不能换个颜色」这件事上完全没有商量余地，
     而换肤不该是付费墙的第一道。这条断言就是防止以后有人又把它收窄回去
     （那也正是这一版在修的问题 —— 从「只有素笺免费」改回来）。 */
  const freeKeys = LIGHT_THEME_KEYS.filter((key) => !SUPPORTER_THEME_KEYS.includes(key));
  assert.deepEqual(freeKeys, ['sujian', 'dianqing', 'qingci'], '免费档应恰好是这三套');

  for (const key of SUPPORTER_THEME_KEYS) {
    assert.equal(isThemeLocked(key, false), true, `${key} 在免费档应被挡住`);
    assert.equal(isThemeLocked(key, true), false, `${key} 在支持者档应放行`);
  }
  for (const key of freeKeys) {
    assert.equal(isThemeLocked(key, false), false, `${key} 是免费的，不该被挡`);
    assert.equal(isThemeLocked(key, true), false, `${key} 在支持者档当然也放行`);
  }
});

test('★ 免费三套排在展示顺序的最前面 —— 选择器的分组靠它', () => {
  /* 选择器里免费的不带标、会员的带「支持者」标。顺序一旦交叉，
     界面就变成「隔一个锁一个」，用户得逐个去点数才知道哪些能用。
     这条把「分界必须是一刀切开」钉住，不然改列表顺序时没人会想到这一层。 */
  const lockedIndexes = SUPPORTER_THEME_KEYS.map((key) => LIGHT_THEME_KEYS.indexOf(key));
  const lastFree = LIGHT_THEME_KEYS.findLastIndex((key) => !SUPPORTER_THEME_KEYS.includes(key));
  assert.ok(
    lastFree < Math.min(...lockedIndexes),
    '免费套必须在会员套之前 —— 否则界面上会「隔一个锁一个」',
  );
});

test('★★ 玄夜永远不被锁：它不是权益，是系统深色时的接管档', () => {
  assert.equal(DARK_THEME_KEY, 'xuanye', '主题表里读不到玄夜的键，正则没匹配上');
  assert.equal(
    SUPPORTER_THEME_KEYS.includes(DARK_THEME_KEY),
    false,
    '把玄夜列进门控表 = 深色模式用户没有主题可用，那是坏掉的功能而不是权益',
  );
  assert.equal(isThemeLocked(DARK_THEME_KEY, false), false);
});

test('门控表覆盖的键都在真实主题列表里（防手滑写错一个不存在的主题名）', () => {
  assert.deepEqual(
    LIGHT_THEME_KEYS,
    ['sujian', 'dianqing', 'qingci', 'zhusha', 'ouhe', 'yanzhi'],
    '浅色主题列表变了',
  );

  for (const key of SUPPORTER_THEME_KEYS) {
    assert.ok(
      LIGHT_THEME_KEYS.includes(key),
      `${key} 不是可选浅色之一 —— 写错主题名不会报错，只会静默锁不住`,
    );
  }
});
