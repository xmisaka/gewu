/**
 * 支持者权益说明页（`src/app/pro.tsx`）的守护测试。
 *
 * 这一页本身没有「逻辑」可测，它全是展示。但它的几处**静默失效**很贵：
 *
 *   1. 加了第四项权益，页面上的 `FEATURE_ORDER` 没跟上 —— 界面少一项，不报错；
 *   2. 三处入口里有一处漏改，回到老路径 —— 用户在那个语境下又看不到权益了；
 *   3. 路由没在 root 布局注册 —— 跳过去是一片空白（或落到 tab 首屏）；
 *   4. 「支持者档包含 AI」写成了一整句，却漏了「Key 是你自己的」——
 *      读起来就是「付了钱还得自付 API 费」，与事实相反，但页面看着完全正常。
 *
 * 所以这里全部用**源码级断言**：不 import React 组件（node:test 里加载不了
 * react-native / expo-router），只读文件、比字符串。粗，但这几件事本来就只
 * 关心「有没有写到」，不关心它是怎么渲染的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FREE_BASELINE, SUPPORTER_FEATURES } from '../src/lib/entitlement.ts';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const proSource = read('../src/app/pro.tsx');

/* ==================== 1. 展示的权益项 = 门控表 ==================== */

test('★ 说明页列出的权益项与门控表完全一致（加了第四项而页面没跟上，会静默少一项）', () => {
  const match = /FEATURE_ORDER[^=]*=\s*\[([^\]]+)\]/.exec(proSource);
  assert.ok(match, '在 pro.tsx 里找不到 FEATURE_ORDER');

  const listed = [...match[1].matchAll(/'([^']+)'/g)].map((piece) => piece[1]);
  assert.deepEqual(
    listed,
    Object.keys(SUPPORTER_FEATURES),
    '页面上的权益项与 SUPPORTER_FEATURES 对不上 —— 要么漏了一项，要么顺序变了',
  );
});

test('免费档的基准清单没被清空，且页面上真的在用它', () => {
  /* 对比页少一栏，用户会默认「免费=试用版」—— 那比原来「权益看不见」更糟。
     这一栏是这一版刻意加的，别在后续重构里被顺手删掉。 */
  assert.ok(FREE_BASELINE.length >= 5, '免费档能力列得太少，撑不起「完整版」这个印象');
  assert.ok(
    /FREE_BASELINE\.map/.test(proSource),
    'pro.tsx 没有渲染 FREE_BASELINE —— 要么删了那一栏，要么换了别的数据源',
  );
});

test('★ AI 那项与「Key 是你自己的」同屏 —— 分开写会被读成「付了钱还要自付 API 费」', () => {
  assert.ok(/不代出/.test(proSource), 'pro.tsx 里没交代格物不代出 Key');
  assert.ok(/不按量收费/.test(proSource), 'pro.tsx 里没交代不按量收费');
});

test('★★ 「批量识图」必须出现在支持者功能说明与权益对比里（漏一处就是静默少一项）', () => {
  /* AI 一族有四个入口，批量识图是最省事的那个。它曾经只活在录入页右上角一枚图标里，
     权益文案一个字都没提 —— 结果是没人知道它属于支持者档。三处文案各写一遍，必然漂。 */
  assert.ok(
    SUPPORTER_FEATURES.ai.proSide.includes('批量识图'),
    '`SUPPORTER_FEATURES.ai.proSide`（支持者功能说明）漏了「批量识图」',
  );
  assert.ok(
    SUPPORTER_FEATURES.ai.sheetBody.includes('批量识图'),
    '`SUPPORTER_FEATURES.ai.sheetBody`（门控浮层正文）漏了「批量识图」',
  );
  assert.ok(
    /批量识图/.test(proSource),
    'pro.tsx 的权益对比（AI 那一行的子项）没写「批量识图」—— 对比表是决策的地方，少一项等于那一项不存在',
  );
});

/* ==================== 2. 三处入口 + 路由注册 ==================== */

test('★ 三个入口都汇聚到权益页（漏一处，那个语境下就又看不到权益了）', () => {
  const entrances = {
    'app/supporter.tsx 的「还没买」段': '../src/app/supporter.tsx',
    'SupporterGateSheet 的浮层底部': '../src/components/domain/SupporterGateSheet.tsx',
    'app/(tabs)/mine.tsx 的支持格物卡': '../src/app/(tabs)/mine.tsx',
  };

  for (const [where, path] of Object.entries(entrances)) {
    assert.ok(/['"]\/pro['"]/.test(read(path)), `${where} 没有指向 /pro 的入口`);
  }
});

test('★ pro 必须是 root Stack 路由，且已在布局里注册', () => {
  const layout = read('../src/app/_layout.tsx');
  assert.ok(/name="pro"/.test(layout), 'pro 没在 root 布局注册');

  /* 放进 (tabs) 就是一个静默的坏交互：tab 不压栈，从浮层或我的页进去再返回，
     安卓会落到第一格（物品页）而不是来处。检查它没有被写成 tab 页。 */
  assert.equal(
    /app\/\(tabs\)\/pro\.tsx/.test(layout),
    false,
    'pro 被写成了 tab 页 —— tab 不压栈，「回到来处」这条就不成立了',
  );
});

/* ==================== 3. 说明页用的文案字段 ==================== */

test('说明页用到的三个文案字段都有实词（留空不报错，页面上是一道空白）', () => {
  for (const key of Object.keys(SUPPORTER_FEATURES)) {
    const copy = SUPPORTER_FEATURES[key];
    for (const field of ['tagline', 'freeSide', 'proSide']) {
      assert.ok(
        typeof copy[field] === 'string' && copy[field].length >= 6,
        `${key}.${field} 太短或为空`,
      );
    }
  }
});
