/**
 * AI 配置层的测试（Key 掩码、用量滚动与落盘、默认关闭）。
 *
 * 这一层的错误全是静默的，而且都发生在「用户看不见的地方」：
 *   - 跨月没归零 → 界面一直显示上个月的累计数，不报错、也无迹象
 *   - 掩码写错 → 把真 Key 的一部分露在设置页上，或者把短 Key 掩成看不出是什么
 *   - 默认值写成「开」→ 用户什么都没点，App 就已经能联网了
 * 前两条用户很难发现，第三条用户根本发现不了。所以逐条钉。
 *
 * `config.ts` 刻意不 import expo / react-native，也不静态 import `../db`
 * （库那一步是 `await import('../db')` 惰性引入），因此可以在 node:test 里直接跑。
 *
 * ★ 有几个用例会真的走到「读库 / 写库」那条分支 —— 在 Node 里 expo-sqlite 加载不了，
 *   于是它必然落进各自的 catch。这正是产品要的那条降级路径
 *   （「库还没热起来时按未配置走」「写不进去只在本次会话生效」），
 *   所以不是取巧，是把降级行为也钉住了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_CHAT_MODEL,
  AI_ENDPOINT,
  AI_TIMEOUT_MS,
  AI_UPLOAD_MAX_EDGE,
  AI_UPLOAD_QUALITY,
  AI_VISION_MODEL,
  AI_VISION_TIMEOUT_MS,
  EMPTY_USAGE,
  ENV_API_KEY,
  currentAiKey,
  estimateMonthlyCost,
  hasAiKey,
  isAiEnabled,
  maskKey,
  parseUsage,
  readAiUsage,
  rollUsage,
  saveAiEnabled,
  saveAiKey,
  bumpUsage,
} from '../src/lib/ai/config.ts';

/* ============================================================ 常量口径 */

test('超时与上传副本的数值不能漂（每条链路各有一处依赖它）', () => {
  // 与 stock.ts 的 REQUEST_TIMEOUT_MS 取同一个数：都是「用户正等着的一次联网」
  assert.equal(AI_TIMEOUT_MS, 12_000);

  /*
   * 识图单独放宽到 60 秒。弱网实测（6.75 KB/s）下，光把 1024px 的副本传上去就要几十秒，
   * 掐在 30 秒只会逼用户重试，而重试会撞上「同一时刻只允许一条请求」的限流。
   */
  assert.equal(AI_VISION_TIMEOUT_MS, 60_000);
  assert.ok(AI_VISION_TIMEOUT_MS > AI_TIMEOUT_MS, '识图必须比纯文本宽 —— 它要多传一张图');

  assert.equal(AI_UPLOAD_MAX_EDGE, 1024);
  // 0.8 → 0.7 同样是照弱网体积调的，见 config.ts 的注释；改它要连着看上传耗时
  assert.equal(AI_UPLOAD_QUALITY, 0.7);
  assert.ok(AI_UPLOAD_QUALITY > 0 && AI_UPLOAD_QUALITY <= 1);
});

test('两个模型都必须是免费档 —— 界面那句「≈ ¥0.00」就建立在这上面', () => {
  // 哪天把某一档换成付费模型，这两条会先红，提醒去核对界面上写的钱
  assert.equal(AI_VISION_MODEL.free, true);
  assert.equal(AI_CHAT_MODEL.free, true);
  assert.ok(AI_VISION_MODEL.id.length > 0 && AI_CHAT_MODEL.id.length > 0);
  // 识图与问答共用同一个 OpenAI 兼容端点，差别只在消息体里有没有 image_url
  assert.ok(AI_ENDPOINT.startsWith('https://'));
  assert.ok(AI_ENDPOINT.endsWith('/chat/completions'));
});

/* ============================================================ 用量 */

test('rollUsage：月份不同就**整套清零**，而不是只换个标签', () => {
  const last = { month: '2026-09', vision: 40, chat: 118 };
  assert.deepEqual(rollUsage(last, '2026-10'), { month: '2026-10', vision: 0, chat: 0 });
});

test('rollUsage：同月再调一次是幂等的，原样返回', () => {
  const usage = { month: '2026-10', vision: 40, chat: 118 };
  assert.equal(rollUsage(usage, '2026-10'), usage);
});

test('rollUsage：没有历史记录时给一份干净的当月用量', () => {
  assert.deepEqual(rollUsage(null, '2026-10'), { month: '2026-10', vision: 0, chat: 0 });
  assert.deepEqual(rollUsage(undefined, '2026-10'), { month: '2026-10', vision: 0, chat: 0 });
});

test('bumpUsage：两条通道分开记，互不串台', () => {
  const base = { month: '2026-10', vision: 1, chat: 2 };
  assert.deepEqual(bumpUsage(base, 'vision'), { month: '2026-10', vision: 2, chat: 2 });
  assert.deepEqual(bumpUsage(base, 'chat'), { month: '2026-10', vision: 1, chat: 3 });
});

test('bumpUsage：负数、小数、NaN 一概当 0，脏数据不能把计数带歪', () => {
  const base = { month: '2026-10', vision: 5, chat: 5 };
  assert.deepEqual(bumpUsage(base, 'vision', -3).vision, 5);
  assert.deepEqual(bumpUsage(base, 'vision', Number.NaN).vision, 5);
  assert.deepEqual(bumpUsage(base, 'vision', Number.POSITIVE_INFINITY).vision, 5);
});

test('bumpUsage：小数按步长取向下整，且不改动传进来的那个对象', () => {
  const base = { month: '2026-10', vision: 1, chat: 0 };
  assert.equal(bumpUsage(base, 'vision', 2.9).vision, 3);
  assert.equal(base.vision, 1, 'bumpUsage 不该就地改用量对象');
});

test('parseUsage：正常 JSON 原样恢复', () => {
  assert.deepEqual(parseUsage('{"month":"2026-10","vision":3,"chat":9}'), {
    month: '2026-10',
    vision: 3,
    chat: 9,
  });
});

test('parseUsage：坏数据一律当作没用过，而不是抛错', () => {
  assert.deepEqual(parseUsage(null), EMPTY_USAGE);
  assert.deepEqual(parseUsage(''), EMPTY_USAGE);
  assert.deepEqual(parseUsage('{ 半截'), EMPTY_USAGE);
  assert.deepEqual(parseUsage('null'), EMPTY_USAGE);
});

test('parseUsage：负数与非数字字段归零，月份非字符串则留空', () => {
  assert.deepEqual(parseUsage('{"month":42,"vision":-5,"chat":"很多"}'), {
    month: '',
    vision: 0,
    chat: 0,
  });
  assert.deepEqual(parseUsage('{"vision":1.9}'), { month: '', vision: 1, chat: 0 });
});

test('estimateMonthlyCost：免费档下恒为 0，但它是个函数 —— 换付费模型时数字会自己变', () => {
  assert.equal(estimateMonthlyCost({ month: '2026-10', vision: 42, chat: 118 }), 0);
  assert.equal(estimateMonthlyCost(EMPTY_USAGE), 0);
  // 结论依赖上面那条「两个模型都是免费档」，两处必须同时成立
});

/* ============================================================ 掩码 */

test('maskKey：空 Key 就是空串（设置页那一行据此显示「未配置」）', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('   '), '');
  assert.equal(maskKey(undefined), '');
});

test('maskKey：长 Key 只露头 6 位与尾 4 位', () => {
  const key = 'sk-abcdef1234567890abcd3f2a';
  const masked = maskKey(key);
  assert.ok(masked.startsWith('sk-abc'), masked);
  assert.ok(masked.endsWith('3f2a'), masked);
  assert.ok(masked.includes('••••••'), masked);
  // 中间那段真字符一个都不能露
  assert.ok(!masked.includes('7890'), `掩码里漏出了 Key 中段：${masked}`);
});

test('maskKey：短 Key 退化成「首字符 + 点」，不能掩成一个看不出是什么的东西', () => {
  assert.equal(maskKey('sk-123'), 's••••');
  assert.equal(maskKey('12345678'), '1••••');
});

test('maskKey：长度 9 就进入长档（边界不能反）', () => {
  assert.equal(maskKey('123456789'), '123456••••••6789');
});

/* ============================================================ 默认值 */

test('★ 默认是关的：不填 Key、不开开关，就不存在任何联网链路', () => {
  // 这几行必须跑在下面那些 saveXxx 用例之前 —— 它们会改模块级状态
  assert.equal(isAiEnabled(), false);
});

test('Key 的取值顺序：用户填的优先，没填回落编译期那份', () => {
  // 测试环境通常没设 EXPO_PUBLIC_ZHIPU_API_KEY，此时两者都该是空
  assert.equal(currentAiKey(), ENV_API_KEY);
  assert.equal(hasAiKey(), ENV_API_KEY.length > 0);
});

test('saveAiKey：即使库写不进去，本次会话内也要立刻生效', async () => {
  // 在 Node 里 `await import('../db')` 必然失败，于是落进 catch ——
  // 那正是产品要的降级：「写不进去就只在本次会话生效，界面会照实提示」
  await saveAiKey('sk-test-abcdefghijklmn');
  assert.equal(currentAiKey(), 'sk-test-abcdefghijklmn');
  assert.equal(hasAiKey(), true);
});

test('saveAiKey：传空串即清除，回落编译期那份', async () => {
  await saveAiKey('   ');
  assert.equal(currentAiKey(), ENV_API_KEY);
});

test('saveAiEnabled：开关状态当场生效，且同样不依赖库写成功', async () => {
  await saveAiEnabled(true);
  assert.equal(isAiEnabled(), true);
  await saveAiEnabled(false);
  assert.equal(isAiEnabled(), false);
});

test('readAiUsage：读不到库时给一份当月清零的用量，而不是抛错', async () => {
  assert.deepEqual(await readAiUsage('2026-10'), { month: '2026-10', vision: 0, chat: 0 });
});
