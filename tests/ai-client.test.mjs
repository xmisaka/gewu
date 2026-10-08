/**
 * AI 网络层：超时、状态码分类、请求形状。
 *
 * ── 最要紧的一条 ──────────────────────────────────────────────
 * 智谱免费 Flash 系列的限制是「同一时刻只允许 1 条并发请求」。
 * 这里原来用的是一个「只 reject、不 cancel」的超时：超时后那条请求仍在服务端
 * 占着唯一的并发位，而用户已经可以重试了 —— 第二次就和第一条撞成 2 并发被拒（HTTP 429）。
 * 真机上的观感是「刚打开 AI 就嫌我调用太频繁」，可用户其实只点了一两下。
 *
 * expo-image-manipulator 是原生模块，node 里加载不了，mock 掉；
 * fetch 靠替换全局，Key 走 EXPO_PUBLIC_ZHIPU_API_KEY 环境变量。
 */

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/* 必须在 import 被测模块之前设好：ENV_API_KEY 是模块加载时求值的常量 */
process.env.EXPO_PUBLIC_ZHIPU_API_KEY = 'test-key';

const { askText, askVision, AiError, describeAiError } = await import('../src/lib/ai/client.ts');
const { AI_TIMEOUT_MS, AI_VISION_TIMEOUT_MS, AI_ENDPOINT, AI_CHAT_MODEL, AI_VISION_MODEL } =
  await import('../src/lib/ai/config.ts');

const realFetch = globalThis.fetch;

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

/** 换掉 fetch 并记下每次调用的参数 */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

/** 服务端回一个指定状态码 */
function respondWith(status) {
  return async () => new Response('{"error":{"message":"x"}}', { status });
}

/** 一个永远不返回、只等被 abort 的 fetch —— 用来验超时到底有没有取消 */
function hangUntilAbort(sink) {
  return (_url, init) => {
    sink.signal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    });
  };
}

/* ==================== 1. 超时必须真的取消请求 ==================== */

test('★ 超时要把请求真的 abort 掉，而不是只让自己这边「不等了」', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const sink = {};
  stubFetch(hangUntilAbort(sink));

  const pending = askText('sys', 'hi');
  mock.timers.tick(AI_TIMEOUT_MS);

  await assert.rejects(pending, (err) => err instanceof AiError && err.kind === 'timeout');
  assert.equal(sink.signal.aborted, true, '请求没被取消 —— 它会继续占着服务端那条并发位，重试就撞 429');
});

test('每次请求都带一个 signal（不带就取消不了）', async () => {
  const calls = stubFetch(async () => Response.json({ choices: [{ message: { content: 'ok' } }] }));
  await askText('s', 'u');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('识图的超时比文本宽：12 秒不掐，满 30 秒才掐', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const sink = {};
  stubFetch(hangUntilAbort(sink));

  const pending = askVision('prompt', 'BASE64');
  const rejected = assert.rejects(pending, (err) => err instanceof AiError && err.kind === 'timeout');

  mock.timers.tick(AI_TIMEOUT_MS);
  assert.equal(sink.signal.aborted, false, '12 秒就掐识图太早：上传加推理本来就更慢');

  mock.timers.tick(AI_VISION_TIMEOUT_MS - AI_TIMEOUT_MS);
  assert.equal(sink.signal.aborted, true);
  await rejected;
});

/* ==================== 2. 状态码分类 ==================== */

test('429 重试一次后仍失败，文案说清是「免费模型一次只让发一条」', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return new Response('{"error":{"message":"rate limited"}}', { status: 429 });
  });

  const pending = askText('s', 'u');
  const rejected = assert.rejects(pending, (err) => {
    assert.equal(err.kind, 'api');
    assert.match(err.message, /一条请求/);
    return true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(2_000);
  await rejected;

  assert.equal(calls, 2, '持续限流时只重试一次 —— 多试只会把队列压得更长');
});

test('★ 429 只是「上一条还没释放」时，自动重试一次就成功', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"error":{"message":"rate limited"}}', { status: 429 })
      : Response.json({ choices: [{ message: { content: '看清楚了' } }] });
  });

  const pending = askText('s', 'u');
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(2_000);

  assert.equal(await pending, '看清楚了', '用户不该看到这个错误 —— 等两秒就好了');
  assert.equal(calls, 2);
});

test('401 / 403 指向 Key 本身', async () => {
  for (const status of [401, 403]) {
    stubFetch(respondWith(status));
    await assert.rejects(askText('s', 'u'), (err) => err.kind === 'api' && /Key/.test(err.message));
  }
});

test('其它非 2xx 带上状态码，但不泄露服务端原文', async () => {
  stubFetch(respondWith(500));
  await assert.rejects(askText('s', 'u'), (err) => {
    assert.equal(err.kind, 'api');
    assert.match(err.message, /500/);
    assert.doesNotMatch(err.message, /\{"error"/);
    return true;
  });
});

test('fetch 直接抛（断网 / DNS 失败）→ network，而不是 timeout', async () => {
  stubFetch(() => {
    throw new TypeError('Network request failed');
  });
  await assert.rejects(askText('s', 'u'), (err) => err.kind === 'network');
});

/* ==================== 3. 成功与畸形响应 ==================== */

test('正常返回取 choices[0].message.content，不改写模型给的内容', async () => {
  stubFetch(async () => Response.json({ choices: [{ message: { content: '  一包牛肉面  ' } }] }));
  assert.equal(await askText('s', 'u'), '  一包牛肉面  ');
});

test('缺 choices / content 为空 → 抛错，而不是把空串当成答案', async () => {
  const bodies = [
    {},
    { choices: [] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: '   ' } }] },
    { error: { message: 'model not found' } },
  ];
  for (const body of bodies) {
    stubFetch(async () => Response.json(body));
    await assert.rejects(askText('s', 'u'), (err) => err.kind === 'api', JSON.stringify(body));
  }
});

test('响应体不是 JSON → 抛错', async () => {
  stubFetch(async () => new Response('<html>502 Bad Gateway</html>', { status: 200 }));
  await assert.rejects(askText('s', 'u'), (err) => err.kind === 'api');
});

/* ==================== 4. 请求形状 ==================== */

test('端点、鉴权头、模型名、非流式', async () => {
  const calls = stubFetch(async () => Response.json({ choices: [{ message: { content: 'ok' } }] }));

  await askText('系统提示', '用户问题');
  assert.equal(calls[0].url, AI_ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');

  const textBody = JSON.parse(calls[0].init.body);
  assert.equal(textBody.model, AI_CHAT_MODEL.id);
  assert.equal(textBody.stream, false);
  assert.equal(textBody.messages[0].content, '系统提示');
  assert.equal(textBody.messages[1].content, '用户问题');

  await askVision('看图', 'BASE64');
  const visionBody = JSON.parse(calls[1].init.body);
  assert.equal(visionBody.model, AI_VISION_MODEL.id);

  const parts = visionBody.messages[0].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts.find((p) => p.type === 'image_url').image_url.url, 'data:image/jpeg;base64,BASE64');
});

/* ==================== 5. 文案 ==================== */

test('四种失败指向四种不同的动作', () => {
  assert.match(describeAiError(new AiError('x', 'no-key')), /Key/);
  assert.match(describeAiError(new AiError('x', 'network')), /网络/);
  assert.match(describeAiError(new AiError('x', 'timeout')), /再试|重试/);
  assert.match(describeAiError(new Error('别的东西')), /稍后/);
});
