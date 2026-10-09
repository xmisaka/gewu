/**
 * 标签纯逻辑测试。
 *
 * 这一组几乎全是「不报错但结果不对」的项：
 *   · 归一化忘了折叠大小写 → 候选里冒出两个「Tag」和「tag」
 *   · 排序写成字典序 → 常用标签被埋在后面（功能还在，只是没人用得到）
 *   · 筛选写反成 AND → 稀疏打标签的库里十次九次空屏
 *   · 改名的目标已存在时忘了去重 → 同一条物品上出现两个同名标签
 * 所以断言要盯**具体的顺序与条数**，不能只断「不为空」。
 *
 * 最后一条用例刻意写成「从一整句输入一路走到聚合结果」：
 * 单测每个函数都过，串起来仍然可能因为中间某一步没接上而落空
 * （retrieve.ts 的「问位置」缺口就是这么连着复发两次的）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeTag,
  tagKey,
  normalizeTags,
  splitTagsText,
  joinTagsText,
  addTags,
  removeTag,
  sortTagCounts,
  aggregateTagCounts,
  matchesAnyTag,
  applyTagTransform,
  filterTags,
} = await import('../src/lib/tags.ts');

/* ------------------------------------------------------------ 归一化 */

test('归一化：去首尾空白、折叠内部空白', () => {
  assert.equal(normalizeTag('  办公  '), '办公');
  assert.equal(normalizeTag('智能   家居'), '智能 家居');
  assert.equal(normalizeTag('a\t b'), 'a b');
});

test('归一化：去掉双引号 —— 它会让按标签筛选静默失效', () => {
  // 库里存的是 ["办公","备用"]，筛选靠 `tags LIKE '%"办公"%'` 定界。
  // 标签自带 " 会破坏这个定界，结果是筛不出东西且不报错。
  assert.equal(normalizeTag('办"公'), '办公');
  assert.equal(normalizeTag('"备用"'), '备用');
});

test('判重键折叠大小写，展示保留原文', () => {
  assert.equal(tagKey('Tag'), tagKey('tag'));
  assert.equal(tagKey(' TAG '), 'tag');
  const list = normalizeTags(['Tag', 'tag', 'TAG']);
  assert.deepEqual(list, ['Tag'], '同键只留第一次出现的写法');
});

/* ------------------------------------------------------------ 文本 ↔ 标签 */

test('切分：顿号、中英文逗号、空白都是分隔符（与手输口径一致）', () => {
  assert.deepEqual(splitTagsText('办公、备用'), ['办公', '备用']);
  assert.deepEqual(splitTagsText('办公,备用'), ['办公', '备用']);
  assert.deepEqual(splitTagsText('办公，备用'), ['办公', '备用']);
  assert.deepEqual(splitTagsText('办公 备用'), ['办公', '备用']);
  // ★ 不擅自把 `/` 之类当分隔符 —— 加了会把「24/7」这种标签切坏
  assert.deepEqual(splitTagsText('24/7、出差'), ['24/7', '出差']);
});

test('切分：空串与纯分隔符得到空数组，不是 [""]', () => {
  assert.deepEqual(splitTagsText(''), []);
  assert.deepEqual(splitTagsText('  '), []);
  assert.deepEqual(splitTagsText('、、,，'), []);
});

test('切分：同一行里重复写只留一个，且保留输入顺序', () => {
  assert.deepEqual(splitTagsText('备用、办公、备用'), ['备用', '办公']);
});

test('写回：顿号分隔，且与切分互为逆运算', () => {
  assert.equal(joinTagsText(['办公', '备用']), '办公、备用');
  assert.deepEqual(splitTagsText(joinTagsText(['办公', '备用'])), ['办公', '备用']);
  assert.equal(joinTagsText(['办公', '', '  ', '备用']), '办公、备用');
});

/* ------------------------------------------------------------ 增删 */

test('并集：已选在前，重复项不重复出现', () => {
  assert.deepEqual(addTags(['办公'], ['备用', '办公']), ['办公', '备用']);
});

test('摘除：按判重键比对，大小写不同也摘得掉', () => {
  assert.deepEqual(removeTag(['Tag', '备用'], 'tag'), ['备用']);
  assert.deepEqual(removeTag(['办公'], '不存在'), ['办公']);
});

/* ------------------------------------------------------------ 聚合与排序 */

test('聚合：计数是「用了这个标签的件数」，同一条里写两遍只算一次', () => {
  const list = aggregateTagCounts([
    { tags: ['办公', '备用'] },
    { tags: ['办公', '办公'] },
    { tags: ['办公'] },
  ]);
  assert.equal(list.find((t) => t.tag === '办公').count, 3);
  assert.equal(list.find((t) => t.tag === '备用').count, 1);
});

test('聚合：排序按频次降序，同频次才比拼音', () => {
  const list = aggregateTagCounts([
    { tags: ['少用'] },
    { tags: ['常用'] },
    { tags: ['常用'] },
    { tags: ['中等'] },
    { tags: ['中等'] },
  ]);
  // 常用(chang) 与 中等(zhong) 都是 2 次，拼音决定先后 → 常用在前
  assert.deepEqual(list.map((t) => t.tag), ['常用', '中等', '少用']);
});

test('聚合：频次并列时顺序由拼音决定，与录入先后无关', () => {
  // 频次全是 1 时，若实现退化成「谁先出现谁在前」，候选列表会随录入顺序乱跳
  const expected = ['暗色', '白色', '橙色']; // an < bai < cheng
  assert.deepEqual(
    aggregateTagCounts([{ tags: ['橙色', '白色', '暗色'] }]).map((t) => t.tag),
    expected,
  );
  assert.deepEqual(
    aggregateTagCounts([{ tags: ['暗色', '橙色', '白色'] }]).map((t) => t.tag),
    expected,
  );
});

test('聚合：大小写与空白差异会并成一个候选，展示用第一次出现的写法', () => {
  const list = aggregateTagCounts([{ tags: ['Tag'] }, { tags: ['tag '] }, { tags: [' TAG'] }]);
  assert.equal(list.length, 1);
  assert.equal(list[0].tag, 'Tag');
  assert.equal(list[0].count, 3);
});

test('sortTagCounts：不改动入参数组', () => {
  const input = [
    { tag: 'b', count: 1 },
    { tag: 'a', count: 5 },
  ];
  const sorted = sortTagCounts(input);
  assert.equal(input[0].tag, 'b', '原数组顺序应保持不变');
  assert.equal(sorted[0].tag, 'a');
});

/* ------------------------------------------------------------ 筛选匹配 */

test('筛选：一个都不选 = 全部命中（不是「全都不命中」）', () => {
  assert.equal(matchesAnyTag(['办公'], []), true);
  assert.equal(matchesAnyTag([], []), true);
});

test('筛选：含任一所选即命中（OR）', () => {
  assert.equal(matchesAnyTag(['办公'], ['办公', '备用']), true);
  assert.equal(matchesAnyTag(['备用'], ['办公', '备用']), true);
  assert.equal(matchesAnyTag(['其它'], ['办公', '备用']), false);
});

test('筛选：大小写不敏感', () => {
  assert.equal(matchesAnyTag(['Tag'], ['tag']), true);
});

/* ------------------------------------------------------------ 全局改写 */

test('改名：整条物品上的那个标签被换掉，其余不动', () => {
  assert.deepEqual(applyTagTransform(['办公', '备用'], { type: 'rename', from: '办公', to: '办公用品' }), [
    '办公用品',
    '备用',
  ]);
});

test('合并：改成一个已存在的标签后自动去重，不会出现两个同名', () => {
  // 「合并」不是另一套代码，它就是改名到一个已存在的名字
  assert.deepEqual(
    applyTagTransform(['办公', '办公用品'], { type: 'rename', from: '办公', to: '办公用品' }),
    ['办公用品'],
    '合完只剩一个，且留在原来靠前的位置',
  );
});

test('改名：from 大小写不同也命中；to 为空白时退化成删除', () => {
  assert.deepEqual(applyTagTransform(['Tag'], { type: 'rename', from: 'tag', to: '标签' }), ['标签']);
  assert.deepEqual(applyTagTransform(['办公', '备用'], { type: 'rename', from: '办公', to: '   ' }), ['备用']);
});

test('删除：按判重键摘除，其余保持顺序', () => {
  assert.deepEqual(applyTagTransform(['a', 'b', 'c'], { type: 'delete', tag: 'b' }), ['a', 'c']);
  assert.deepEqual(applyTagTransform(['A'], { type: 'delete', tag: 'a' }), []);
});

/* ------------------------------------------------------------ 候选搜索 */

test('搜索：子串、大小写不敏感；留空返回全部', () => {
  const list = [
    { tag: '办公', count: 3 },
    { tag: '办公用品', count: 1 },
    { tag: '备用', count: 2 },
  ];
  assert.equal(filterTags(list, '').length, 3);
  assert.deepEqual(filterTags(list, '办公').map((t) => t.tag), ['办公', '办公用品']);
  assert.deepEqual(filterTags(list, '  ').length, 3);
  assert.deepEqual(filterTags(list, 'B').length, 0);
});

/* ------------------------------------------------------------ 整串链路 */

test('从一整句输入一路走到聚合结果（不是单测词表）', () => {
  // 用户在一行里敲下的东西：混了顿号、逗号、多余空格、重复项
  const typed = '  办公、备用 , 办公 ，易碎  ';
  const tags = splitTagsText(typed);
  assert.deepEqual(tags, ['办公', '备用', '易碎'], '第一步：切分去重');

  const text = joinTagsText(tags);
  assert.equal(text, '办公、备用、易碎', '第二步：写回 tagsText（表单的唯一真源）');

  // 落库：tags 是 JSON 字符串
  const stored = { tags: JSON.parse(JSON.stringify(tags)) };
  const library = aggregateTagCounts([stored, { tags: ['备用'] }]);
  assert.deepEqual(
    library.map((t) => `${t.tag}:${t.count}`),
    ['备用:2', '办公:1', '易碎:1'],
    '第三步：候选按频次排，备用在最前',
  );

  // 第四步：按「备用」筛，这条记录要命中
  assert.equal(matchesAnyTag(stored.tags, ['备用']), true);
  assert.equal(matchesAnyTag(stored.tags, ['易碎']), true);
  assert.equal(matchesAnyTag(stored.tags, ['不存在']), false);
});
