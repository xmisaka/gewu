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
import { readdirSync, readFileSync, statSync } from 'node:fs';

import {
  checkActivation,
  checkNewItems,
  entitlementFromCode,
  FREE_BASELINE,
  FREE_ENTITLEMENT,
  FREE_ITEM_LIMIT,
  isQuotaFull,
  isThemeLocked,
  itemLimit,
  quotaLeft,
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

test('四处功能都有门控文案，且都写明了「免费档没有被拿掉什么」', () => {
  /*
   * 注意：本文件是 .mjs，`--experimental-strip-types` 只处理 .ts ——
   * 这里写 `as const` / `as readonly string[]` 会直接 SyntaxError（不是类型报错，是解析失败）。
   */
  for (const key of ['theme', 'aiPro', 'stats', 'inventory']) {
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

test('★★ 门控表的键必须恰好是这四项 —— 多一个少一个都是产物与文案对不上', () => {
  /* 2026-10-17 重新划档：`'ai'` 拆成 `'aiPro'`（只含批量识图与问一问），
     新增 `'inventory'`（家庭财产清册从免费转为收费）。
     键名是四处文案（entitlement / ai.tsx / pro.tsx / 官网）共同的锚，改这里就要连带改那四处。 */
  assert.deepEqual(
    Object.keys(SUPPORTER_FEATURES),
    ['theme', 'aiPro', 'stats', 'inventory'],
    '门控表的项变了 —— 记得同步 app/ai.tsx、app/pro.tsx、官网 rc.py 与 shared.py 的文案',
  );
  assert.equal(
    Object.keys(SUPPORTER_FEATURES).includes('ai'),
    false,
    "`'ai'` 这个键必须彻底删掉：它看起来仍像「整个 AI 一族」，留着的代价是" +
      ' 有人照着它把门控加回单张识物或语音录入',
  );
});

/* ==================== 4.5 免费档件数上限 ==================== */

test('★★ 免费档件数上限是 150，且支持者档不限', () => {
  assert.equal(FREE_ITEM_LIMIT, 150, '件数上限被改了 —— 官网、说明页与这行注释要一起改');
  assert.equal(itemLimit(true), null, '支持者档必须不限件数，返回 null 而不是 Infinity');
  assert.equal(itemLimit(false), 150);
});

test('★★ 配额换算：剩余件数夹在 0 以上，超额也不能是负数', () => {
  assert.equal(quotaLeft(0, false), 150);
  assert.equal(quotaLeft(149, false), 1);
  assert.equal(quotaLeft(150, false), 0);
  assert.equal(quotaLeft(200, false), 0, '老用户超额时剩余必须是 0，不能是 -50');
  assert.equal(quotaLeft(999, true), null, '支持者档没有「剩几件」这回事');

  assert.equal(isQuotaFull(149, false), false);
  assert.equal(isQuotaFull(150, false), true);
  assert.equal(isQuotaFull(151, false), true, '定额以上一律算满 —— 只挡新增，不动存量');
  assert.equal(isQuotaFull(999, true), false);
});

test('★★ 按「整批」判：剩 3 件时选 9 张必须整批挡住，不能放进去 3 件', () => {
  /* 半推半就地存一半是最糟的结果：界面报「已保存 9 件」，列表里只多了 3 件，
     剩下 6 条还挂在待存列表里 —— 没有任何线索能让人看出发生了什么。 */
  assert.equal(checkNewItems(147, 3, false).ok, true, '刚好放得下就该放行');
  const blocked = checkNewItems(147, 9, false);
  assert.equal(blocked.ok, false, '放不下要整批挡住');
  assert.equal(blocked.left, 3);
  assert.ok(blocked.message, '挡住时必须给出一句话，否则用户只看到按钮没反应');
  assert.match(blocked.message, /150/, '这句话里要出现上限数字，不然用户不知道到底是多少');
  assert.match(
    blocked.message,
    /照旧|不受影响/,
    '必须先讲「已记下的照旧能用」—— 用户第一反应是「我的东西会不会被锁 / 被删」，而这里都不会',
  );

  assert.equal(checkNewItems(500, 9, true).ok, true, '支持者档超额也照旧能记新的');
  assert.equal(checkNewItems(0, 1, false).ok, true);
  assert.equal(checkNewItems(0, 1, false).message, null, '放行时不该带提示语');
});

test('★ 免费档基准清单里写清了件数、且含放开后的识物与语音', () => {
  /* 这一栏是「免费档是完整版」的证据。件数上限与「单张识物 · 语音录入」
     是 2026-10-17 这一版的核心变化，两样都不能只活在代码里。 */
  assert.ok(
    FREE_BASELINE.some((line) => line.includes(String(FREE_ITEM_LIMIT))),
    `免费档基准清单没写件数上限 —— 用户在最该知道的地方看不到 ${FREE_ITEM_LIMIT} 这个数`,
  );
  assert.ok(
    FREE_BASELINE.some((line) => line.includes('识别') || line.includes('识物')),
    '免费档基准清单漏了识物',
  );
  assert.ok(
    FREE_BASELINE.some((line) => line.includes('语音')),
    '语音录入已经放开到免费档，基准清单里必须有它',
  );
  assert.equal(
    FREE_BASELINE.some((line) => line.includes('清册')),
    false,
    '清册已转为支持者功能，不能出现在免费档基准清单里',
  );
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

/* ==================== 5. 件数闸门真的接到了四条规定上 ==================== */

/**
 * 递归收集 `src/` 下的 .ts/.tsx 相对路径。
 * 这份测试要扫调用点，不能只 import 纯逻辑 —— 那些页面都装了 react-native。
 */
function walkSource() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url))) {
      const rel = `${dir}/${entry}`;
      if (statSync(new URL(`../${rel}`, import.meta.url)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry)) out.push(rel);
    }
  };
  walk('src');
  return out;
}

test('★★★ 每一条「新增物品」的路径都过了件数闸门（漏一处就是一道免费绕道）', () => {
  /*
   * 免费档 150 件的闸门只在**新增**这一侧。新增物品的路径有四条：
   *   录入页 · 批量识图 · 语音录入 · 复制一件
   * 每一条都得先问一次 `useQuotaGuard()`。
   *
   * ★ 这条是全量扫描而不是逐个文件点名：以后再加第五个「新建」入口时，
   *   漏挂闸门不会报错，只会让那一条路永远不限额 —— 而没有任何人会去测
   *   「我明明记满 150 件了，为什么这里还能存进去」。
   * ★ 排除 `lib/db/`（`createItem` 的实现本身）与备份恢复（走 `insertRaw`，
   *   那是用户把自己已有的数据搬回来，不该被上限挡住）。
   * ★★ 判据是 **`useQuotaGuard()`（带括号，真的调了一次）**，不是 `useQuotaGuard`：
   *   只查名字的话，`import { useQuotaGuard } from '…'` 那一行就能让它通过 ——
   *   变异验证时当场抓到过这种假绿（把调用和闸门整段删掉，断言照样全绿）。
   */
  const CALL = /\bcreateItemsBatch\(|\bcreateItem\(/;
  const offenders = [];
  let checked = 0;
  for (const rel of walkSource()) {
    if (rel.startsWith('src/lib/db/')) continue;
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    if (!CALL.test(src)) continue;
    checked += 1;
    if (!src.includes('useQuotaGuard()')) offenders.push(rel);
  }

  assert.ok(checked >= 4, `只扫到 ${checked} 个新增入口，路径大概率写错了`);
  assert.deepEqual(
    offenders,
    [],
    `这些文件会新增物品却没挂件数闸门：${offenders.join(', ')}`,
  );
});

test('★ 闸门判「这一次要存几件」，不是「满了没有」', () => {
  /* 单件路径传 1、批量路径传 `picked.length`。写成「满了没有」时，
     剩 3 件额度选 9 张会被放进去 3 件 —— 界面报「已保存 9 件」，列表只多 3 条。 */
  const batch = readFileSync(new URL('../src/app/batch.tsx', import.meta.url), 'utf8');
  assert.match(
    batch,
    /quotaGuard\(picked\.length\)/,
    '批量页应当把「这次要存的件数」交给闸门，而不是传 1 或先判满没满',
  );
  const compose = readFileSync(new URL('../src/app/compose.tsx', import.meta.url), 'utf8');
  assert.match(compose, /await quotaGuard\(1\)/, '录入页一次只存一件，传 1');
});

test('★★ 判满之后只提示、不抛错 —— 表单外面没有 catch', () => {
  /* `ItemForm` 里是裸的 `await onSubmit(...)`。闸门抛异常＝一条未处理异常：
     用户看不到任何解释，表单停在原地，看起来像「点了保存没反应」。
     批量页停在 review 并把话说在列表下方，录入页走弹窗。 */
  for (const rel of ['src/app/compose.tsx', 'src/app/item/[id]/duplicate.tsx']) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert.match(
      src,
      /if \(!quota\.ok\) \{[\s\S]{0,200}return;/,
      `${rel} 判满之后应当直接 return，不能 throw`,
    );
    assert.equal(
      /throw new .*[Qq]uota|throw new Error\('记满/.test(src),
      false,
      `${rel} 不要为配额抛异常`,
    );
  }
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
