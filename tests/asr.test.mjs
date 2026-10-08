/**
 * 语音识别适配层：把「系统识别器返回了什么」翻译成 AsrOutcome。
 *
 * ── 为什么值得单独测 ──────────────────────────────────────────
 * 这层的契约是「整函数不抛错」，而它最容易漏的一支是：
 * **识别引擎出错时返回的 resultCode 与「用户主动取消」完全同形**（都是 RESULT_CANCELED）。
 * 真机上先踩了一次 —— 系统弹完「似乎出错了呢」，格物这边静默回到原状，
 * 用户以为 App 坏了。能区分的只有 extras 里带不带 ERROR_CODE。
 *
 * expo-intent-launcher 与 react-native 都是原生模块，node 里加载不了，全部 mock。
 * 注意必须用 `await import()` 加载被测模块 —— 静态 import 会赶在 mock 注册之前求值。
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/** 每个用例通过它改「系统这次返回什么」 */
let respond = async () => ({ resultCode: -1, extra: {} });
/** 记下最后一次传进系统的 intent 参数 */
let lastCall = null;

mock.module('react-native', { namedExports: { Platform: { OS: 'android' } } });

mock.module('expo-intent-launcher', {
  namedExports: {
    startActivityAsync: async (action, options) => {
      lastCall = { action, options };
      return respond();
    },
  },
});

const { listenOnce, asrMessage, ASR_AVAILABLE } = await import('../src/lib/ai/asr.ts');

/* ==================== 夹具 ==================== */

/** Activity.RESULT_OK */
const OK = -1;
/** Activity.RESULT_CANCELED */
const CANCELED = 0;

const RESULTS = 'android.speech.extra.RESULTS';
const ERROR_CODE = 'android.speech.extra.ERROR_CODE';

/** 让系统这次返回「成功 + 这些识别结果」 */
function succeed(extra) {
  respond = async () => ({ resultCode: OK, extra });
}

/** 让系统这次返回「取消」（无错误码） */
function cancel(extra = {}) {
  respond = async () => ({ resultCode: CANCELED, extra });
}

/** 让系统这次返回「取消 + 错误码」，即引擎出错 */
function engineError(code = 2) {
  respond = async () => ({ resultCode: CANCELED, extra: { [ERROR_CODE]: code } });
}

/* ==================== 1. 成功 ==================== */

test('识别成功：取回第一条识别文本', async () => {
  succeed({ [RESULTS]: ['厨房橱柜二放了一包牛肉面'] });
  assert.deepEqual(await listenOnce(), { kind: 'ok', text: '厨房橱柜二放了一包牛肉面' });
});

test('结果只给了单个字符串也要认（各家引擎回来的类型并不统一）', async () => {
  succeed({ [RESULTS]: '一包牛肉面' });
  assert.deepEqual(await listenOnce(), { kind: 'ok', text: '一包牛肉面' });
});

test('结果数组里有空串与 null 时，跳到第一条真正的文本', async () => {
  succeed({ [RESULTS]: [null, '   ', '有效的那条'] });
  assert.deepEqual(await listenOnce(), { kind: 'ok', text: '有效的那条' });
});

test('识别到的文本两端空白会被裁掉', async () => {
  succeed({ [RESULTS]: ['  一包牛肉面  '] });
  assert.deepEqual(await listenOnce(), { kind: 'ok', text: '一包牛肉面' });
});

/* ==================== 2. 没听清 ==================== */

test('识别完成但没拿到文本 → nomatch（三种形态一致，不因引擎给数组还是字符串而分叉）', async () => {
  succeed({});
  assert.deepEqual(await listenOnce(), { kind: 'nomatch' });

  succeed({ [RESULTS]: [] });
  assert.deepEqual(await listenOnce(), { kind: 'nomatch' });

  succeed({ [RESULTS]: ['   ', ''] });
  assert.deepEqual(await listenOnce(), { kind: 'nomatch' });

  succeed({ [RESULTS]: '   ' });
  assert.deepEqual(await listenOnce(), { kind: 'nomatch' });
});

test('成功但 extras 整个缺失 → nomatch，既不许抛错、也不当成用户取消', async () => {
  succeed(undefined);
  assert.deepEqual(await listenOnce(), { kind: 'nomatch' });
});

/* ==================== 3. 取消与出错（真机踩过的那条） ==================== */

test('用户主动退出（CANCELED 且无错误码）→ canceled，界面应当保持安静', async () => {
  cancel();
  assert.deepEqual(await listenOnce(), { kind: 'canceled' });

  // 带点别的东西但没有错误码，仍然是取消
  cancel({ [RESULTS]: [] });
  assert.deepEqual(await listenOnce(), { kind: 'canceled' });
});

test('★ 引擎出错：同样是 CANCELED，但 extras 里有 ERROR_CODE → failed 而不是 canceled', async () => {
  engineError(2);
  assert.deepEqual(await listenOnce(), { kind: 'failed' });
});

test('错误码是 0 也要算失败（0 是「有值」，不是「没有」）', async () => {
  engineError(0);
  assert.deepEqual(await listenOnce(), { kind: 'failed' });
});

test('错误码嵌套/dirty 时不误判：非对象 extras 一律算取消', async () => {
  respond = async () => ({ resultCode: CANCELED, extra: '看起来像错误码的字符串' });
  assert.deepEqual(await listenOnce(), { kind: 'canceled' });

  respond = async () => ({ resultCode: CANCELED, extra: null });
  assert.deepEqual(await listenOnce(), { kind: 'canceled' });
});

/* ==================== 4. 没有识别器 ==================== */

test('没有 Activity 能处理该 intent → unsupported（而不是把异常抛给界面）', async () => {
  respond = async () => {
    throw new Error('ActivityNotFoundException');
  };
  assert.deepEqual(await listenOnce(), { kind: 'unsupported' });
});

test('原生层抛任何异常都收敛成 unsupported，绝不外抛', async () => {
  for (const boom of [new Error('x'), '字符串', null, { code: 1 }]) {
    respond = async () => {
      throw boom;
    };
    await assert.doesNotReject(() => listenOnce());
    assert.deepEqual(await listenOnce(), { kind: 'unsupported' });
  }
});

/* ==================== 5. 传给系统的参数 ==================== */

test('用的是自由说模型而不是网页搜索模型（后者会把长句当关键词截断）', async () => {
  succeed({ [RESULTS]: ['x'] });
  await listenOnce();

  assert.equal(lastCall.action, 'android.speech.action.RECOGNIZE_SPEECH');
  assert.equal(lastCall.options.extra['android.speech.extra.LANGUAGE_MODEL'], 'free_form');
  assert.equal(lastCall.options.extra['android.speech.extra.LANGUAGE'], 'zh-CN');
  assert.equal(lastCall.options.extra['android.speech.extra.MAX_RESULTS'], 1);
});

test('提示语随参数传入，缺省时也有一句能读的话', async () => {
  succeed({ [RESULTS]: ['x'] });
  await listenOnce('说出物品和保质期');
  assert.equal(lastCall.options.extra['android.speech.extra.PROMPT'], '说出物品和保质期');

  await listenOnce();
  const fallback = lastCall.options.extra['android.speech.extra.PROMPT'];
  assert.equal(typeof fallback, 'string');
  assert.ok(fallback.length > 0);
});

/* ==================== 6. 文案 ==================== */

test('可见失败态都有中文说明，取消态刻意留空', () => {
  for (const kind of ['unsupported', 'nomatch', 'failed']) {
    const text = asrMessage({ kind });
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, kind);
  }
  assert.equal(asrMessage({ kind: 'canceled' }), '', '取消不该弹提示');
  assert.equal(asrMessage({ kind: 'ok', text: 'x' }), '', '成功也不该弹提示');
});

test('failed 的文案要给出可行动的下一步，而不是只说「失败了」', () => {
  const text = asrMessage({ kind: 'failed' });
  assert.match(text, /授权|设置/, '该告诉用户去哪里处理');
  assert.match(text, /手动/, '该给出另一条路');
});

/* ==================== 7. 平台开关 ==================== */

test('Android 上语音通道可用（本文件 mock 的就是 android）', () => {
  assert.equal(ASR_AVAILABLE, true);
});
