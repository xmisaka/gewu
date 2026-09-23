/**
 * 位置视图筛选单测。
 *
 * 这个筛选器管的是「搜柜子名还是格位名」这种容易想当然的语义，
 * 而且它返回的对象会直接进 CabinetGrid —— 一旦把不该露的格位留下，
 * 或者把该留的柜子剔掉，界面会安静地少东西。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterCabinets } from '../src/lib/search.ts';

/** 造一个柜子视图（只填筛选用得到的字段） */
function cabinet(id, name, slots = [], patch = {}) {
  const built = slots.map(([slotId, slotName, itemCount]) => ({
    slot: { id: slotId, name: slotName, parentId: id, note: null, builtin: false, sortOrder: 0 },
    itemCount,
    thumbs: [],
  }));
  return {
    id,
    name,
    parentId: null,
    note: null,
    builtin: false,
    sortOrder: 0,
    looseCount: 0,
    slots: built,
    totalCount: built.reduce((sum, s) => sum + s.itemCount, 0),
    occupiedSlots: built.filter((s) => s.itemCount > 0).length,
    ...patch,
  };
}

const FIXTURE = () => [
  cabinet('c1', '书房柜', [
    ['s1', '抽屉A', 3],
    ['s2', '抽屉B', 0],
  ]),
  cabinet('c2', '阳台柜', [['s3', '工具箱', 5]]),
  cabinet('c3', '储物间', [], { note: '堆放杂物和行李箱' }),
];

const ids = (list) => list.map((c) => c.id);
const slotIds = (c) => c.slots.map((s) => s.slot.id);

test('空关键词原样返回同一个数组引用，不做无意义的重建', () => {
  const input = FIXTURE();
  assert.equal(filterCabinets(input, ''), input);
  assert.equal(filterCabinets(input, '   '), input, '只有空白也算空');
});

test('命中柜子名：柜子留下，它的格位一个不少', () => {
  const out = filterCabinets(FIXTURE(), '书房');
  assert.deepEqual(ids(out), ['c1']);
  assert.deepEqual(slotIds(out[0]), ['s1', 's2'], '搜到柜子就该看到它全部格位');
});

test('只命中格位名：柜子留在结果里，但只挂命中的格位', () => {
  const out = filterCabinets(FIXTURE(), '抽屉B');
  assert.deepEqual(ids(out), ['c1'], '格位命中也得让柜子出现，否则找不到那一格在哪');
  assert.deepEqual(slotIds(out[0]), ['s2']);
  assert.equal(out[0].name, '书房柜');
});

test('柜子名与格位名都搜：不同柜子的命中互不干扰', () => {
  const out = filterCabinets(FIXTURE(), '柜');
  assert.deepEqual(ids(out), ['c1', 'c2'], '「储物间」不含「柜」字，不该被带上');
  assert.deepEqual(slotIds(out[0]), ['s1', 's2'], '柜名命中 → 格位全保留');
  assert.deepEqual(slotIds(out[1]), ['s3']);
});

test('柜子备注也参与匹配', () => {
  const out = filterCabinets(FIXTURE(), '行李箱');
  assert.deepEqual(ids(out), ['c3']);
});

test('全都没命中就返回空数组，不是原列表', () => {
  assert.deepEqual(filterCabinets(FIXTURE(), '车库'), []);
});

test('大小写与两侧空白都不影响命中', () => {
  const input = [cabinet('c1', 'Tool Cabinet', [['s1', 'Screwdrivers', 1]])];
  assert.deepEqual(ids(filterCabinets(input, '  tool  ')), ['c1']);
  assert.deepEqual(ids(filterCabinets(input, 'SCREW')), ['c1']);
});

test('筛选不改动入参：原对象的格位数组保持完整', () => {
  const input = FIXTURE();
  const before = slotIds(input[0]);
  filterCabinets(input, '抽屉B');
  assert.deepEqual(slotIds(input[0]), before, '命中格位的那条路径会新建对象，不能就地改');
  assert.deepEqual(ids(input), ['c1', 'c2', 'c3']);
});

test('柜名命中时复用原对象，格位命中时才需要复制', () => {
  const input = FIXTURE();
  const out = filterCabinets(input, '书房');
  assert.equal(out[0], input[0], '没有任何裁剪时不必新建对象');

  const trimmed = filterCabinets(input, '抽屉B');
  assert.notEqual(trimmed[0], input[0], '裁剪了格位就必须是新对象，否则会污染缓存');
  assert.notEqual(trimmed[0].slots, input[0].slots);
});
