/**
 * 柜子详情页「每格展示几件」的源码级守护。
 *
 * 这一页没有可 import 的逻辑（整文件是 JSX + react-native），
 * 而它踩过的坑**不报错**：
 *
 *   1. 每格的上限是「每行几格 × 6」（按屏宽算，见 `tilesPerRow`）——
 *      这是这一页一直以来的设计（2026-10-16 曾短暂改成写死的 18，已按用户要求回退）。
 *      上限与「+N」的计数必须**共用同一个表达式**：两边写岔了只是显示出一个错的 N，
 *      不崩、不报错，用户会以为数错了。
 *   2. 「+N」原来是一块**纯展示**的 `View`：用户看得见「还有 9 件」，
 *      却点不开、也没有别的地方能看全（2026-10-16 报的 bug）。
 *      它必须是一个真的能点的控件，并且点了要能就地展开这一格。
 *
 * 两件事都只能读源码断言 —— 与 routing.test.mjs / pro-page.test.mjs 同一个理由。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/app/cabinet/[id].tsx', import.meta.url), 'utf8');

test('★ 每格上限是「每行几格 × 6」这条随屏宽走的表达式，截断与计数共用它', () => {
  assert.match(
    src,
    /const tilesPerRow = useMemo\(\(\) => \{/,
    'tilesPerRow 必须还在 —— 上限按屏宽算（每行几格 × 6）是这一页的设计',
  );

  assert.match(
    src,
    /section\.items\.slice\(0, tilesPerRow \* 6\)/,
    '折叠态必须按 tilesPerRow * 6 截断',
  );

  assert.match(
    src,
    /section\.items\.length - tilesPerRow \* 6/,
    '★「+N」的 N 必须和上面的截断用同一个表达式 —— 两边写岔只会显示出错的数量，不报错',
  );

  assert.ok(
    !/slice\(0, \d+\)/.test(src),
    '不要写死成固定的件数 —— 上限跟着屏宽走（2026-10-16 试过固定 18，用户要求回退）',
  );
});

test('★★★ 「+N」必须可点，并且点了能就地展开这一格（它曾经是块画着数字的死方块）', () => {
  /* 关键的判据：它是 Pressable 且 onPress 真的接了展开逻辑。
     只断言「有 +N 这个字」是不够的 —— 上一版正是那样一块 View。 */
  assert.match(
    src,
    /onPress=\{\(\) => toggleSlot\(section\.key\)\}/,
    '「+N」必须接上 toggleSlot —— 不接就是回退成不可点的死方块',
  );

  assert.match(
    src,
    /expandedSlots\.has\(section\.key\)\s*\?\s*section\.items\s*:\s*section\.items\.slice\(0, tilesPerRow \* 6\)/,
    '展开态要真的把整格的物品都渲染出来，而不是只改个标题',
  );

  assert.match(src, /收起/, '展开之后必须给得出「收起」—— 不然 60 件的格子会把下面几格推到很远的屏幕外');
});
