/**
 * 格物 · 主题配色的准入校验
 *
 * 这些断言守的是一件事：**对比度是准入条件，不是事后优化。**
 *
 * 为什么值得为它单独写一个文件：配色问题是**静默**的。
 * 把 ink3 调浅一格、给新主题随手挑个品牌色，界面不会报错、不会崩，
 * 只是有人在地铁上看不清那行小字 —— 而这种事没人会回来提 issue。
 * 改色的人（包括我自己）需要一个当场变红的信号。
 *
 * 令牌从**源码里读**，不 import `src/constants/theme.ts`：
 * 那个文件 import 了 react-native，在 node:test 里根本加载不了。
 *
 * 阈值与本机技能 `theme-palette-audit/scripts/contrast.py` 保持一致 ——
 * 那边是设计时的工具，这边是提交前的守门人，两边同源才不会各说各话。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const themeSource = readFileSync(new URL('../src/constants/theme.ts', import.meta.url), 'utf8');

/* ------------------------------------------------------------ 解析 */

const THEME_BLOCK = themeSource.slice(
  themeSource.indexOf('export const THEMES'),
  themeSource.indexOf('export function isDarkTheme'),
);

/** 每套主题：{ mode, tokens } */
const themes = {};
/*
 * ★ 换行写成 `\r?\n`：theme.ts 是 CRLF 行尾，而 Windows 上不同编辑器/脚本
 *   写回时行尾会来回变。只认 `\n` 的话正则静默匹配不到任何主题 ——
 *   而下面那些「逐套检查」会因此全部跳过、测试显示绿色的通过。
 *   所以同时还有一条断言专门核对「解析出了哪几套」，见第一个用例。
 */
for (const m of THEME_BLOCK.matchAll(/\r?\n {2}(\w+): \{\r?\n([\s\S]*?)\r?\n {2}\},\r?\n/g)) {
  const [, key, chunk] = m;
  const body = chunk.slice(chunk.indexOf('tokens: {'));
  const tokens = {};
  for (const t of body.matchAll(/^ {6}(\w+): '([^']+)',/gm)) tokens[t[1]] = t[2];
  themes[key] = { mode: /mode: '(\w+)'/.exec(chunk)[1], tokens };
}

const LIGHT_THEME_KEYS = (() => {
  const m = /LIGHT_THEME_KEYS\s*=\s*\[([^\]]+)\]/.exec(themeSource);
  return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
})();

const DARK_THEME_KEY = /DARK_THEME_KEY:\s*ThemeKey\s*=\s*'([^']+)'/.exec(themeSource)?.[1];

/** TokenName 联合里声明的令牌数 */
const TOKEN_COUNT = (themeSource.match(/^ {2}\| '[a-zA-Z0-9]+';?$/gm) ?? []).length;

/* ------------------------------------------------------------ WCAG 对比度 */

function toLinear(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* 文字与语义：硬指标 —— 达不到就是「看不清」，不是「不太好看」 */
const TEXT_CHECKS = [
  ['正文 / 底色', 'ink', 'canvas', 10],
  ['正文 / 卡片面', 'ink', 'surface', 10],
  ['次级文字 / 底色', 'ink2', 'canvas', 5],
  ['三级文字 / 底色', 'ink3', 'canvas', 3],
  ['四级文字 / 底色', 'ink4', 'canvas', 1.4],
  ['品牌色 / 底色', 'brand', 'canvas', 4.5],
  ['品牌字 / 品牌浅底', 'brand', 'brandBg', 4.5],
  ['深品牌 / 底色', 'brandDeep', 'canvas', 4.5],
  ['语义·正常 / 浅底', 'sage', 'sageBg', 4.5],
  ['语义·警告 / 浅底', 'amber', 'amberBg', 4.5],
  ['语义·危险 / 浅底', 'clay', 'clayBg', 4.5],
  ['品牌底上的字', 'onAccent', 'brand', 4.5],
];

/* 面层级：软指标 —— 达不到界面会「糊」，但不会到看不清的程度 */
const SURFACE_CHECKS = [
  ['卡片面 / 画布', 'surface', 'canvas', 1.05],
  ['内嵌槽位 / 卡片面', 'inset', 'surface', 1.08],
  ['细分隔线 / 画布', 'line', 'canvas', 1.15],
  ['细线2 / 画布', 'line2', 'canvas', 1.08],
  ['品牌浅底 / 卡片面', 'brandBg', 'surface', 1.06],
  ['画布 / 页面底', 'canvas', 'paper', 1.02],
];

/* ------------------------------------------------------------ 结构 */

test('主题表解析得到全部七套（六套浅色 + 玄夜）', () => {
  /* 解析失败时下面那些逐套的断言会「因为没数据而全过」——
     这类静默是最坏的。所以先把「解析出来了什么」本身钉住。 */
  assert.deepEqual(Object.keys(themes).sort(), [
    'dianqing',
    'ouhe',
    'qingci',
    'sujian',
    'xuanye',
    'yanzhi',
    'zhusha',
  ]);
  assert.equal(themes[DARK_THEME_KEY].mode, 'dark');
  for (const key of LIGHT_THEME_KEYS) {
    assert.equal(themes[key].mode, 'light', `${key} 被列进浅色却标了 dark`);
  }
});

test('★ 每套主题的令牌一个都不能少', () => {
  /* 少了键 TS 也会报错，这里再钉一道是为了挡住「用 any 绕过去」这种改法 ——
     缺一个令牌会在运行期表现为某个角落不换肤，而且不报错。 */
  assert.ok(TOKEN_COUNT >= 25, `没解析到 TokenName（拿到 ${TOKEN_COUNT} 个），正则该更新了`);
  for (const [key, def] of Object.entries(themes)) {
    assert.equal(
      Object.keys(def.tokens).length,
      TOKEN_COUNT,
      `${key} 的令牌数不对（应有 ${TOKEN_COUNT} 个，实际 ${Object.keys(def.tokens).length}）`,
    );
  }
});

test('★ 每套主题的令牌键名完全一致（防抄一套改色时漏改键名）', () => {
  const reference = Object.keys(themes.sujian.tokens).sort();
  for (const [key, def] of Object.entries(themes)) {
    assert.deepEqual(Object.keys(def.tokens).sort(), reference, `${key} 的键名与素笺不一致`);
  }
});

/* ------------------------------------------------------------ 对比度 */

test('★★ 文字与语义色的对比度：每套主题都要达标', () => {
  const failures = [];
  for (const [key, def] of Object.entries(themes)) {
    for (const [label, fg, bg, min] of TEXT_CHECKS) {
      const value = contrast(def.tokens[fg], def.tokens[bg]);
      if (value < min) {
        failures.push(`${key} 的「${label}」= ${value.toFixed(2)}，低于 ${min}`);
      }
    }
  }
  assert.deepEqual(failures, [], `对比度不达标（改色后请重跑技能里的 contrast.py）：\n${failures.join('\n')}`);
});

test('★ 面层级的可见度：卡片浮不浮得起来', () => {
  const failures = [];
  for (const [key, def] of Object.entries(themes)) {
    for (const [label, fg, bg, min] of SURFACE_CHECKS) {
      const value = contrast(def.tokens[fg], def.tokens[bg]);
      if (value < min) {
        failures.push(`${key} 的「${label}」= ${value.toFixed(3)}，低于 ${min}`);
      }
    }
  }
  assert.deepEqual(failures, [], `面层级不够分明（界面会发糊）：\n${failures.join('\n')}`);
});

test('★★ 语义三色锁在绿黄红：任何一套都不许改色相', () => {
  /* 这是全项目最容易被「顺手调好看一点」破坏的约束。
     用户靠色相分辨状态 —— 一旦某套主题把 sage 调成蓝色，
     那个 App 里的「正常」就再也不成立了，而截图里看不出任何异常。 */
  function hueOf(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return null;
    let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue *= 60;
    return hue < 0 ? hue + 360 : hue;
  }

  /* 区间放宽即可，只为挡住「跳到另一个色系」这种改法 */
  const BANDS = { sage: [70, 160], amber: [25, 70], clay: [0, 32] };

  for (const [key, def] of Object.entries(themes)) {
    for (const [token, [lo, hi]] of Object.entries(BANDS)) {
      const hue = hueOf(def.tokens[token]);
      assert.ok(hue != null, `${key} 的 ${token} 是无彩色，语义色不能没有色相`);
      const inBand = hue >= lo && hue <= hi;
      const wrapped = hue + 360 >= lo && hue + 360 <= hi; // clay 的红跨过 0°
      assert.ok(
        inBand || wrapped,
        `${key} 的 ${token} 色相 ${hue.toFixed(0)}° 掉出了 ${lo}~${hi}° —— 语义色只许调明度，不许改色相`,
      );
    }
  }
});

test('纯白与 onAccent 该固定的地方要固定', () => {
  /* pure 是「压在任何底色上都保证能读」的绝对色（彩色块上的白字），
     它不参与换肤。浅色六套都应是纯白；玄夜可以不同（暖金品牌色上要压深墨）。 */
  for (const [key, def] of Object.entries(themes)) {
    assert.equal(def.tokens.pure, '#FFFFFF', `${key} 的 pure 被改动了`);
  }
  for (const key of LIGHT_THEME_KEYS) {
    assert.equal(themes[key].tokens.onAccent, '#FFFFFF', `${key} 的品牌色够深，应压白字`);
  }
});
