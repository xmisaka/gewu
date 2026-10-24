/**
 * 「换封面」入口 —— 守护测试。
 *
 * 背景（2026-10-24）：用户问「多图能不能选某张当封面」。
 * 答案其实是**早就支持** —— 详情页点大图进全屏，底部有「设为封面」。
 * 但他找不到，因为要三步才够得着，而且缩略条上看不出哪张是封面。
 * 于是补了两样东西：缩略条上的封面星标 + 长按缩略图换封面。
 *
 * 这条链上**没有一处会报错**：
 *   · 长按没接上 → 功能回到「只有全屏里有」，用户继续找不到；
 *   · 星标条件写错（比如写成 i === activePhoto）→ 它变成「选中标记」的复读，
 *     而「哪张是封面」这个信息依然不存在；
 *   · setCover 不归零 activePhoto → 照片重排后大图位显示成另一张，
 *     看着像「我点错了」，但代码没有任何异常。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const detailSource = read('../src/app/item/[id]/index.tsx');

/**
 * 抽出详情页缩略条那一段（从 contentContainerStyle 到下面那行提示）。
 *
 * ★ 不用 `/photos\.length > 1[\s\S]*?\) : null\}/`：里面嵌着三元与 map，
 *   第一个 `) : null}` 会提前截断。这里用两个**唯一**的锚点切区间，再自检。
 */
function thumbStrip() {
  const from = detailSource.indexOf('contentContainerStyle={styles.thumbStrip}');
  const to = detailSource.indexOf('styles.thumbHint');
  assert.ok(from >= 0 && to > from, '找不到缩略条那一段 —— 结构变了，这条守护测试需要跟着改');

  const text = detailSource.slice(from, to);
  assert.ok(
    /onPress=/.test(text) && /PhotoThumb/.test(text),
    '抽出来的不是缩略条（缺 onPress 或 PhotoThumb）—— 下面的断言不可信',
  );
  return text;
}

/** 抽 setCover 的整段实现，用于检查「换完要不要归零下标」 */
function setCoverBody() {
  const match = /const setCover = useCallback\([\s\S]*?\r?\n  \);/.exec(detailSource);
  assert.ok(match, '在详情页里找不到 setCover —— 换封面的落库入口被改名或删掉了');
  assert.ok(
    /promotePhoto/.test(match[0]),
    'setCover 里没有 promotePhoto —— 抽到的可能只是参数表，下面的断言不可信',
  );
  return match[0];
}

/* ==================== 1. 缩略条上必须能换封面 ==================== */

test('★ 缩略图接了长按换封面（否则入口又只剩全屏那条，用户继续找不到）', () => {
  const strip = thumbStrip();

  assert.ok(
    /onLongPress=/.test(strip),
    '缩略条上没有 onLongPress —— 「长按换封面」这条路断了，功能退回藏在全屏查看器里',
  );
  assert.ok(
    /setCover\(p\.filePath\)/.test(strip),
    '长按没有接到 setCover(p.filePath) —— 换封面的落库入口没被调用',
  );
});

test('★ 首张不接长按（它已经是封面，按下去是空操作）', () => {
  const strip = thumbStrip();

  assert.ok(
    /onLongPress=\{i === 0 \? undefined :/.test(strip),
    '首张也接了长按 —— 封面点「设为封面」什么都不变，属于用户最难判断的反馈',
  );
});

test('★★ 星标挂在「封面」上，不能挂成「当前选中」', () => {
  const strip = thumbStrip();

  assert.ok(
    /\{i === 0 \? \(/.test(strip),
    '封面星标的条件是 i === 0 —— 改成 activePhoto 会让它变成选中标记的复读，' +
      '而「哪张是封面」这个信息依然不存在',
  );
  assert.ok(
    /styles\.coverBadge/.test(strip),
    '找不到封面星标 —— 缩略条上又看不出哪张是封面了',
  );
});

/* ==================== 2. 换完之后大图位不能错位 ==================== */

test('★★ setCover 把大图位拨回第 1 张（照片重排后 activePhoto 会指错人）', () => {
  const body = setCoverBody();

  assert.ok(
    /setActivePhoto\(0\)/.test(body),
    'setCover 没有把 activePhoto 归零 —— 照片重排后大图位会显示成另一张，' +
      '用户以为「我点的明明是这张」',
  );
});
