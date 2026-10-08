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
  AI_PROVIDERS,
  AI_VISION_MODEL,
  AI_VISION_TIMEOUT_MS,
  DEFAULT_PROVIDER_KEY,
  activeProvider,
  activeProviderKey,
  chatModelName,
  customEndpointSettings,
  endpointUrl,
  findProvider,
  providerSupportsVision,
  saveAiProvider,
  saveCustomEndpoint,
  visionModelName,
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

/* ============================================================ 供应商表 */

test('★ 供应商表的三条不变量：标识唯一、端点合法、模型名非空', () => {
  const keys = AI_PROVIDERS.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length, '标识重复 —— 存进 meta 的选择会指向错的那家');

  for (const p of AI_PROVIDERS) {
    assert.ok(p.name.length > 0, `${p.key} 没有名字`);
    assert.ok(p.signupNote.length > 0, `${p.key} 没写清门槛，用户会以为接大模型一定要花钱`);

    if (p.key === 'custom') {
      /* 自定义那家的地址与模型名都由用户填，表里留空是设计 */
      assert.equal(p.endpoint, '');
      assert.equal(p.chatModel, '');
      assert.equal(p.visionModel, '');
      continue;
    }

    assert.ok(p.chatModel.length > 0, `${p.key} 没给问答模型名`);
    assert.ok(p.endpoint.startsWith('https://'), `${p.key} 的端点必须是 https`);
    assert.ok(
      p.endpoint.endsWith('/chat/completions'),
      `${p.key} 的端点要一路写到 /chat/completions —— 各家拼法不同，留一半让用户猜必然出事`,
    );
    assert.ok(p.keyUrl.startsWith('https://'), `${p.key} 要给出去哪拿 Key 的地址`);
  }
});

test('★ DeepSeek 必须标成「看不了图」—— 它的 V4 是纯文本模型', () => {
  /* 这一条是整张表里最容易搞错、后果也最直接的一格：
     填了模型名，用户一选它，识物就会在点下去的瞬间坏掉，
     而报的是模型侧的错，完全看不出是「这家本来就不支持」。 */
  const deepseek = findProvider('deepseek');
  assert.equal(deepseek.visionModel, null, 'DeepSeek 没有可用的视觉模型，别填名字');
});

test('至少有一家支持识图，否则识物功能形同不存在', () => {
  assert.ok(
    AI_PROVIDERS.some((p) => p.visionModel !== null && p.visionModel !== ''),
    '一家能识图的都没有',
  );
});

test('没选过时用默认那家，且默认那家一定在表里', () => {
  assert.equal(activeProviderKey(), DEFAULT_PROVIDER_KEY);
  assert.ok(AI_PROVIDERS.some((p) => p.key === DEFAULT_PROVIDER_KEY));
  assert.equal(activeProvider().key, DEFAULT_PROVIDER_KEY);
});

test('findProvider：不认识的标识兜回默认那家，而不是返回 undefined', () => {
  /* 返回 undefined 的话，上层第一次读 .name 就会崩 —— 而触发条件是
     「用户存过一个已经不存在的供应商标识」（换了表、或手工改过库） */
  assert.equal(findProvider('不存在的供应商').key, DEFAULT_PROVIDER_KEY);
  assert.equal(findProvider('').key, DEFAULT_PROVIDER_KEY);
});

test('解析函数与当前供应商一致：端点、两个模型名', () => {
  const p = activeProvider();
  assert.equal(endpointUrl(), p.endpoint);
  assert.equal(visionModelName(), p.visionModel ?? '');
  assert.equal(chatModelName(), p.chatModel);
  assert.equal(providerSupportsVision(), true, '默认那家是支持识图的');
});

test('切到 DeepSeek：端点跟着换，且识图模型名变成空串', async () => {
  await saveAiProvider('deepseek');
  try {
    assert.equal(activeProviderKey(), 'deepseek');
    assert.equal(endpointUrl(), 'https://api.deepseek.com/chat/completions');
    assert.equal(chatModelName(), 'deepseek-v4-flash');
    assert.equal(visionModelName(), '', '看不了图时必须给空串，界面靠它决定藏不藏识物入口');
    assert.equal(providerSupportsVision(), false);
  } finally {
    await saveAiProvider(DEFAULT_PROVIDER_KEY);
  }
});

test('★ 切供应商会把运行时 Key 一起换掉', async () => {
  /* 不换的话：用户切到 DeepSeek 却还在用智谱的 Key，服务端回 401，
     而界面上 Key 那一行显示得好好的（它有内容），排查会非常绕 */
  await saveAiKey('sk-zhipu-key-123456');
  assert.equal(currentAiKey(), 'sk-zhipu-key-123456');

  await saveAiProvider('deepseek');
  assert.equal(currentAiKey(), '', '换了供应商就不该继续用上一家的 Key');

  await saveAiProvider(DEFAULT_PROVIDER_KEY);
  await saveAiKey('   ');
});

test('自定义端点：填了才生效，没填时端点为空串（由 client 拦住并给提示）', async () => {
  await saveAiProvider('custom');
  try {
    assert.equal(endpointUrl(), '');
    assert.equal(chatModelName(), '');
    assert.equal(providerSupportsVision(), false, '没填识图模型名＝用不了识物');

    await saveCustomEndpoint({ endpoint: 'https://example.com/v1/chat/completions', chat: 'my-model' });
    assert.equal(endpointUrl(), 'https://example.com/v1/chat/completions');
    assert.equal(chatModelName(), 'my-model');

    /* 只补识图模型名时，另外两项不能被清掉 —— patch 语义 */
    await saveCustomEndpoint({ vision: 'my-vision' });
    assert.equal(endpointUrl(), 'https://example.com/v1/chat/completions');
    assert.equal(chatModelName(), 'my-model');
    assert.equal(visionModelName(), 'my-vision');
    assert.equal(providerSupportsVision(), true);

    assert.deepEqual(customEndpointSettings(), {
      endpoint: 'https://example.com/v1/chat/completions',
      vision: 'my-vision',
      chat: 'my-model',
    });
  } finally {
    await saveCustomEndpoint({ endpoint: '', vision: '', chat: '' });
    await saveAiProvider(DEFAULT_PROVIDER_KEY);
  }
});
