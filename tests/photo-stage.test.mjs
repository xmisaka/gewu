/**
 * 大图位的像素供给 —— 守护测试。
 *
 * 这条链上没有任何一行会在出错时报错：喂错了图，界面照常渲染，只是**变糊**。
 * 用户看得到一个模糊的封面，开发者看不到任何信号。所以这里全部用源码级断言。
 *
 * 背景（2026-10-14 实测）：
 *   - 详情页大图位是**整屏宽 × 230dp**：`Screen` 与那一层的 `ScrollView` 都不给
 *     水平内边距（`item/[id]/index.tsx` 的 `scroll` 只有 `paddingBottom`）。
 *     360dp 屏 @3x = **1080 物理像素**。
 *   - 而 `thumbPath` 是 `THUMB_WIDTH = 320` 宽的 JPEG（q0.75）。
 *     320 → 1080 是 **3.4 倍上采样**；`contentFit="cover"` 按宽度定标，纵向同倍。
 *   - 于是「同一张照片，全屏查看器清晰、详情页大图位糊」——
 *     差别只在取 `filePath`（1600）还是 `thumbPath`（320）。
 *
 * 三件**静默失效**的事，各钉一条：
 *   1. 有人把大图位的 `filePath` 改回（或删成只剩）`thumb` —— 糊，不报错；
 *   2. 有人「顺手」把 `MAX_EDGE` 调小到屏宽以下 —— 原图也不够了，一样糊；
 *   3. 有人矫枉过正，把列表/相册的小缩略图也换成原图 —— 不糊了，但全库照片被反复
 *      解码，滚动掉帧。小位子继续吃 thumb 才对。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const mediaSource = read('../src/components/domain/media.tsx');
const detailSource = read('../src/app/item/[id]/index.tsx');
const pipelineSource = read('../src/lib/photos/pipeline.ts');

/** 360dp 屏 @3x —— 大图位的物理宽度，也是「够清晰」的像素下限 */
const SCREEN_PX = 1080;

/**
 * 抽出一个导出函数的整段源码。
 *
 * ★ 必须写成 `\r?\n\}\r?\n`（行尾的 `}`，CRLF 也要认）：
 *   仓库里的源文件是 **CRLF**；而且只写 `\n\}` 会**提前停在 props 的 `}: {` 上**
 *   —— 那行的第一个字符就是 `}`，于是抽出来的「函数体」只有参数表，
 *   底下所有断言都在一个空壳上跑，看着像「组件没写」。
 *   所以后面每条都要先过一道「抽全了没」的自检。
 */
function extractFunction(source, name) {
  const match = new RegExp(`export function ${name}\\b[\\s\\S]*?\\r?\\n\\}\\r?\\n`).exec(source);
  assert.ok(match, `在 media.tsx 里找不到 ${name}`);
  return match[0];
}

/* ==================== 1. PhotoStage 必须优先吃原图 ==================== */

test('★ 大图位取的是 filePath（原图），thumb 只作兜底', () => {
  const stage = extractFunction(mediaSource, 'PhotoStage');
  assert.ok(
    /contentFit=/.test(stage),
    'PhotoStage 只抽到了参数表没抽到函数体 —— 抽取正则又提前截断了，下面的断言全是假绿',
  );

  assert.ok(
    /filePath/.test(stage),
    'PhotoStage 不收 filePath —— 只吃 thumb 的话，整屏宽的大图位必然糊',
  );
  assert.ok(
    /absoluteUri\(\s*filePath\s*\|\|\s*thumb\s*\)/.test(stage),
    'PhotoStage 没有写成 `absoluteUri(filePath || thumb)` —— 偏好顺序变了，原图会被 thumb 顶掉',
  );
});

test('PhotoThumb（小位子）继续吃 thumb，别换成原图', () => {
  const thumb = extractFunction(mediaSource, 'PhotoThumb');
  assert.ok(
    /contentFit=/.test(thumb),
    'PhotoThumb 只抽到了参数表没抽到函数体 —— 抽取正则又提前截断了，下面的断言全是假绿',
  );
  assert.ok(
    /absoluteUri\(\s*thumb\s*\)/.test(thumb),
    'PhotoThumb 不再直接吃 thumb —— 列表/相册若改用原图，滚动会因为反复解码大图掉帧',
  );
});

/* ==================== 2. 调用点必须把 filePath 传进去 ==================== */

test('★ 详情页大图位同时给了 filePath 与 thumb（这是那一次糊的现场）', () => {
  const tag = /<PhotoStage\b([\s\S]*?)\/>/.exec(detailSource);
  assert.ok(tag, '在 item/[id]/index.tsx 里找不到 <PhotoStage />');

  const props = tag[1];
  assert.ok(/filePath=/.test(props), '详情页没有给 PhotoStage 传 filePath —— 大图位又会退回 320px 的缩略图');
  assert.ok(/\.filePath/.test(props), 'filePath 不是从照片记录上取的（写成常量或其它字段都会静默糊掉）');
  assert.ok(/thumb=/.test(props), '兜底链断了：原图文件万一丢了就只剩白框');
});

/* ==================== 3. 原图本身必须够大 ==================== */

test('★ MAX_EDGE 不低于屏宽物理像素 —— 调小它，原图也不够用了', () => {
  const match = /const MAX_EDGE = (\d+)/.exec(pipelineSource);
  assert.ok(match, '在 pipeline.ts 里找不到 MAX_EDGE');

  const maxEdge = Number(match[1]);
  assert.ok(
    maxEdge >= SCREEN_PX,
    `MAX_EDGE = ${maxEdge} < ${SCREEN_PX}（360dp@3x 的屏宽）—— 长边压到屏宽以下，大图位再怎么取原图也是放大`,
  );
});

test('缩略图仍然明显小于原图（两者混同＝缩略图这份工作白做了）', () => {
  const thumbWidth = Number(/const THUMB_WIDTH = (\d+)/.exec(pipelineSource)?.[1]);
  const maxEdge = Number(/const MAX_EDGE = (\d+)/.exec(pipelineSource)?.[1]);

  assert.ok(Number.isFinite(thumbWidth), '在 pipeline.ts 里找不到 THUMB_WIDTH');
  assert.ok(
    thumbWidth < maxEdge,
    `THUMB_WIDTH = ${thumbWidth} 与 MAX_EDGE = ${maxEdge} 已经不分大小 —— ` +
      '要么缩略图失去了意义，要么原图被压到了缩略图的规格',
  );
});
