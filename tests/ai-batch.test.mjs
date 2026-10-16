/**
 * 格物 · 批量识图的调度与归类
 *
 * 钉的是那批「判错了也不报错」的规则 —— 条目状态怎么流转、哪条算能保存、
 * 用户改过的值会不会被模型结果冲掉、进度怎么数。这些在界面上出错时
 * 只会表现为「少了一项」「名字变回去了」，不会崩、不会有异常，
 * 所以只能靠断言兜住（与 policy.test.mjs 同一个理由）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEditResult,
  applyResult,
  applyUniform,
  attachPhoto,
  assign,
  isSavable,
  markFailed,
  markRunning,
  newEntry,
  progressLabel,
  progressOf,
  removeEntry,
  rename,
  savableCount,
  toDrafts,
  toggleSelected,
} from '../src/lib/ai/batch.ts';
import {
  clearEditing,
  peekEditing,
  putEditResult,
  putEditing,
  takeEditResult,
} from '../src/lib/ai/batch-draft.ts';
import { EMPTY_FIELDS } from '../src/lib/ai/extract.ts';

/** 一条条目，默认是「刚建出来的 pending」 */
const make = (over = {}) => ({ ...newEntry('k', null), ...over });

/** 造一次成功的识别结果 */
const ok = (fields, confidence = 0.9) => ({
  fields: { ...EMPTY_FIELDS, ...fields },
  filled: Object.keys(fields),
  confidence,
});

/* ------------------------------------------------------------- 初始与流转 */

test('newEntry：默认勾选、空名字、pending', () => {
  const e = newEntry('a', { filePath: 'photos/x.jpg', thumbPath: 'thumbs/x.jpg' });
  assert.equal(e.status, 'pending');
  assert.equal(e.selected, true, '批量的默认意图就是「全都要」');
  assert.equal(e.name, '');
  assert.equal(e.photo?.filePath, 'photos/x.jpg');
});

test('markRunning / markFailed：状态与文案都落上去', () => {
  let list = [make()];
  list = markRunning(list, 'k');
  assert.equal(list[0].status, 'running');

  list = markFailed(list, 'k', '等了太久还没返回');
  assert.equal(list[0].status, 'failed');
  assert.equal(list[0].notice, '等了太久还没返回');
});

test('applyResult(null)：一个字段都没读出来 → empty，不是 failed', () => {
  const list = applyResult([make()], 'k', null);
  assert.equal(list[0].status, 'empty');
  assert.equal(list[0].fields.name, null);
});

/* ------------------------------------------------------------- 关键不变量 */

test('★★ applyResult：模型没给出的字段**绝不覆盖**条目现值', () => {
  // 用户先补了名字与到期日，然后（排队中）识别结果才回来
  const before = [make({ name: '我自己起的名字', expireDate: '2027-01-01' })];
  const after = applyResult(before, 'k', ok({ brand: '德芙' }));

  assert.equal(after[0].name, '我自己起的名字', '模型返回 name=null 时不能把用户敲的名字清空');
  assert.equal(after[0].expireDate, '2027-01-01', '到期日同理');
  assert.equal(after[0].fields.brand, '德芙', '但模型真给了值的字段要写进 fields');
  assert.equal(after[0].status, 'done');
});

test('applyResult：模型给了值就覆盖', () => {
  const after = applyResult([make()], 'k', ok({ name: '德芙巧克力', expireDate: '2026-12-01' }));
  assert.equal(after[0].name, '德芙巧克力');
  assert.equal(after[0].expireDate, '2026-12-01');
});

test('applyResult 保留 fields 原样 —— 界面靠它判断挂不挂 AI 标', () => {
  const after = applyResult([make()], 'k', ok({ name: '德芙巧克力' }));
  // 用户随后改名，fields 不该跟着变
  const renamed = rename(after, 'k', '巧克力（过年买的）');
  assert.equal(renamed[0].name, '巧克力（过年买的）');
  assert.equal(renamed[0].fields.name, '德芙巧克力');
});

/* ------------------------------------------------------------- 可保存判定 */

test('isSavable：勾了 + 有名字才算', () => {
  assert.equal(isSavable(make({ name: '杯子' })), true);
  assert.equal(isSavable(make({ name: '杯子', selected: false })), false, '没勾的不算');
  assert.equal(isSavable(make({ name: '  ' })), false, '只有空白也不算有名字');
});

test('★★ isSavable：识别失败的条目，补上名字照样能存', () => {
  const failed = markFailed([make()], 'k', '连不上模型')[0];
  assert.equal(isSavable(failed), false, '还没名字时不能存');
  const fixed = rename([failed], 'k', '不知道是啥，先记着')[0];
  assert.equal(
    isSavable(fixed),
    true,
    '判据刻意不看 status —— 照片早就落盘了，丢掉它反而制造孤儿文件',
  );
});

test('savableCount 数得对', () => {
  const list = [
    make({ name: 'a' }),
    make({ name: 'b', selected: false }),
    make({ name: '' }),
    make({ name: 'c', status: 'failed' }),
  ];
  assert.equal(savableCount(list), 2);
});

/* ------------------------------------------------------------- 进度 */

test('progressOf：done / empty / failed 都算「跑完」，running 单算', () => {
  const list = [
    make({ status: 'pending' }),
    make({ status: 'running' }),
    make({ status: 'done' }),
    make({ status: 'empty' }),
    make({ status: 'failed' }),
  ];
  assert.deepEqual(progressOf(list), { total: 5, finished: 3, running: 1 });
});

test('progressLabel：三个分支都不重叠', () => {
  assert.equal(progressLabel({ total: 0, finished: 0, running: 0 }, 0), '没有待识别的照片');
  assert.match(
    progressLabel({ total: 9, finished: 3, running: 1 }, 0),
    /识别中 3\/9/,
    '在跑的时候要提示别退出',
  );
  assert.match(progressLabel({ total: 9, finished: 9, running: 0 }, 7), /7 条可保存/);
});

/* ------------------------------------------------------------- 批量改 */

test('applyUniform：只作用于仍勾选的条目', () => {
  const list = [
    make({ key: 'a' }),
    make({ key: 'b', selected: false }),
  ];
  const after = applyUniform(list, { categoryId: 'c1', locationId: 'l1' });
  assert.equal(after[0].categoryId, 'c1');
  assert.equal(after[0].locationId, 'l1');
  assert.equal(after[1].categoryId, null, '用户明确去掉勾的，不去碰它');
});

test('toggleSelected / removeEntry 只动目标那一条', () => {
  const list = [make({ key: 'a' }), make({ key: 'b' })];
  const toggled = toggleSelected(list, 'b');
  assert.equal(toggled[0].selected, true);
  assert.equal(toggled[1].selected, false);

  const removed = removeEntry(list, 'a');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].key, 'b');
});

test('assign 只改传进来的那几个字段', () => {
  const list = assign([make({ name: 'x' })], 'k', { locationId: 'l9' });
  assert.equal(list[0].locationId, 'l9');
  assert.equal(list[0].name, 'x', '没传的字段不该被清掉');
});

test('attachPhoto 挂上照片，别的字段不动', () => {
  const list = attachPhoto([make({ name: 'x' })], 'k', { filePath: 'p.jpg', thumbPath: 't.jpg' });
  assert.equal(list[0].photo?.filePath, 'p.jpg');
  assert.equal(list[0].name, 'x');
});

/* ------------------------------------------------------------- 组装草稿 */

test('toDrafts：字段来源分两处 —— 用户草稿 vs 模型原始输出', () => {
  const entry = applyResult([make()], 'k', ok({ name: '德芙巧克力', brand: '德芙', price: 12.5 }))[0];
  const edited = assign(rename([entry], 'k', '巧克力'), 'k', { locationId: 'l1' });

  const [draft] = toDrafts(edited, {});
  assert.equal(draft.name, '巧克力', '名称取用户改过的');
  assert.equal(draft.locationId, 'l1');
  assert.equal(draft.brand, '德芙', '品牌这类清单行没有编辑位，直接取模型输出');
  assert.equal(draft.price, 12.5);
});

test('toDrafts：跳过不能保存的，defaults 只兜没设过的', () => {
  const list = [
    make({ key: 'a', name: '有名字' }),
    make({ key: 'b', name: '' }),
  ];
  const drafts = toDrafts(list, { locationId: 'fallback' });
  assert.equal(drafts.length, 1, '没名字的不该进草稿');
  assert.equal(drafts[0].locationId, 'fallback');

  // 条目自己设过位置时，不被 defaults 覆盖
  const withLoc = assign(list, 'a', { locationId: 'own' });
  assert.equal(toDrafts(withLoc, { locationId: 'fallback' })[0].locationId, 'own');
});

test('toDrafts：空数组进、空数组出（保存按钮在 0 件时不该被调用）', () => {
  assert.deepEqual(toDrafts([]), []);
});

/* ----------------------------------------------------- 分类映射（阶段二修） */

test('★★ applyResult：模型给的分类名要能对上库里的分类才生效', () => {
  const cats = [
    { id: 'c1', name: '食品' },
    { id: 'c2', name: '药品' },
  ];
  const hit = applyResult([make()], 'k', ok({ name: '巧克力', categoryName: '食品' }), cats);
  assert.equal(hit[0].categoryId, 'c1', '对得上就该落成 id');

  const miss = applyResult([make()], 'k', ok({ name: '巧克力', categoryName: '零食' }), cats);
  assert.equal(miss[0].categoryId, null, '对不上就当它没填 —— 别把不存在的分类名漏进界面');

  const noList = applyResult([make()], 'k', ok({ name: '巧克力', categoryName: '食品' }));
  assert.equal(noList[0].categoryId, null, '没传分类清单时不该瞎猜');
});

/* ----------------------------------------------------- 详细编辑回写 */

/** 一份「详细编辑」产出的种子 */
const editSeed = (over = {}) => ({
  name: 'x',
  categoryId: null,
  locationId: null,
  expireDate: null,
  warrantyUntil: null,
  brand: null,
  model: null,
  price: null,
  quantity: null,
  purchaseDate: null,
  tags: [],
  note: null,
  ...over,
});

test('applyEditResult：用户显式改的字段全量覆盖（与 applyResult 的取舍正好相反）', () => {
  const before = applyResult([make()], 'k', ok({ name: '德芙巧克力', brand: '德芙', price: 12.5 }))[0];
  const after = applyEditResult(
    [before],
    'k',
    editSeed({
      name: '巧克力',
      categoryId: 'c1',
      locationId: 'l1',
      expireDate: '2027-01-01',
      brand: null, // 用户清空了品牌 —— 这也是意图，要覆盖
      model: 'X-1',
      price: 9.9,
      quantity: 3,
      purchaseDate: '2026-10-01',
      tags: ['零食'],
      note: '过年买的',
    }),
  )[0];

  assert.equal(after.name, '巧克力');
  assert.equal(after.fields.brand, null, '用户清空的字段要跟着清空');
  assert.equal(after.fields.model, 'X-1');
  assert.equal(after.fields.price, 9.9);
  assert.equal(after.fields.quantity, 3);
  assert.deepEqual(after.fields.tags, ['零食']);
  assert.equal(after.fields.note, '过年买的');
  assert.equal(after.expireDate, '2027-01-01');
  assert.equal(after.categoryId, 'c1');
  assert.equal(after.locationId, 'l1');
});

test('applyEditResult → toDrafts：详细编辑里填的保修期必须一路带进草稿', () => {
  /* ★ 这条守的是**静默丢值**：ItemForm 上摆着「保修至」这一行，
     而批量流程若在条目或 toDrafts 那一步漏掉它，用户在详细编辑里填的日期
     会在保存成功后消失 —— 保存没报错、清单也清空了，只有一个值没了。 */
  const edited = applyEditResult([make({ key: 'k', name: '电水壶' })], 'k', {
    ...editSeed({ name: '电水壶' }),
    warrantyUntil: '2028-03-01',
  });

  assert.equal(edited[0].warrantyUntil, '2028-03-01', '要落在条目自带的草稿上');
  assert.equal(toDrafts(edited, {})[0].warrantyUntil, '2028-03-01', '还要带进最终的草稿');
  assert.equal(toDrafts(edited, {})[0].expireDate, null, '保修期不该串成过期时间');
});

test('applyEditResult：只动那一条，其他条目纹丝不动', () => {
  const list = [make({ key: 'a', name: 'A' }), make({ key: 'b', name: 'B' })];
  const after = applyEditResult(list, 'b', editSeed({ name: 'B 改过了' }));
  assert.equal(after[0].name, 'A');
  assert.equal(after[1].name, 'B 改过了');
});

test('applyEditResult：key 不在清单里时原样返回（不抛错）', () => {
  const after = applyEditResult([make({ key: 'a' })], 'not-there', editSeed({ name: 'x' }));
  assert.equal(after.length, 1);
  assert.equal(after[0].name, '');
});

/* ----------------------------------------------------- 详细编辑的跨页槽 */

test('batch-draft：editing 槽是 peek + 显式 clear（可重复读）', () => {
  putEditing({ key: 'k1', seed: editSeed({ name: '甲' }) });
  assert.equal(peekEditing()?.key, 'k1');
  assert.equal(peekEditing()?.key, 'k1', 'peek 不能清空 —— 编辑页每次渲染都得拿得到');
  clearEditing();
  assert.equal(peekEditing(), null);
});

test('batch-draft：result 槽取走即清空（清单页只会取一次）', () => {
  putEditResult({ key: 'k2', seed: editSeed({ name: '乙' }) });
  assert.equal(takeEditResult()?.key, 'k2');
  assert.equal(
    takeEditResult(),
    null,
    '取过一次就该空了，否则下次进这一页会被当成新结果又应用一遍',
  );
});
