/**
 * 老库升级回归 —— 「做错就打不开数据库」的那一步，单独一组。
 *
 * 为什么单独一个文件、而不是塞进 db.test.mjs：
 * 迁移只有在**进程第一次打开数据库**时才会跑（index.ts 里 dbPromise 是单例），
 * 而 db.test.mjs 的第一个用例就已经把新库开好了，之后再也回不到「从老库启动」的场景。
 * Node 的测试跑在每个文件各自的进程里，于是把这一步单独放一个文件，
 * 就能在 import 数据层之前，先把一个**真的 v2 库**摆到磁盘上。
 *
 * 造老库的办法不是手抄一份 v2 的建表 SQL —— 抄来的 DDL 会随主脚本一起腐坏，
 * 测着测着就和真实历史脱节。这里反过来：先跑当前脚本建出 v3 表，
 * 再把 v3 新增的列**删掉**、把 v2 那一步的 ALTER 重做一遍，
 * 得到的就是「v1 建库、一路 ALTER 升到 v2」的真实形状：
 * 没有 quantity，且 sort_order 排在**表末尾**（而不是建表脚本里写的位置）。
 * 这一点很关键 —— 它正是「禁 SELECT *」那条规矩的现场。
 */

import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workDir = mkdtempSync(join(tmpdir(), 'gewu-migrate-test-'));
const dbPath = join(workDir, 'gewu.db');

// 这两个 import 都不碰 expo-sqlite，可以放心先加载
const { openShimDatabase, closeAllShimDatabases } = await import('./support/sqlite.mjs');
const { CREATE_META, CREATE_TABLES, SCHEMA_VERSION } = await import('../src/lib/db/schema.ts');

/** 造一个 v2 老库；必须在数据层第一次 open 之前调用 */
function buildLegacyV2() {
  const raw = new DatabaseSync(dbPath);
  raw.exec(CREATE_META);
  raw.exec(CREATE_TABLES);

  // 退回到 v1 的形状，再补上 v2 那一步的 ALTER
  raw.exec('ALTER TABLE items DROP COLUMN quantity;');
  raw.exec('ALTER TABLE items DROP COLUMN sort_order;');
  raw.exec('ALTER TABLE items ADD COLUMN sort_order INTEGER;');

  raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2');

  const insert = raw.prepare(
    `INSERT INTO items
       (id, name, category_id, location_id, purchase_date, price, expire_date,
        brand, model, tags, note, sort_order, created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  insert.run(
    'old-1',
    '老物品一',
    '2026-01-02',
    15.8,
    '2026-12-31',
    '海天',
    '金标生抽',
    '[]',
    '老库里的备注',
    0,
    1_700_000_000_000,
    1_700_000_000_000,
  );
  insert.run(
    'old-2',
    '老物品二',
    null,
    null,
    null,
    null,
    null,
    '[]',
    null,
    null,
    1_700_000_100_000,
    1_700_000_100_000,
  );

  const cols = raw.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  raw.close();

  // 前置自检：老库必须真的是「没有 quantity、sort_order 在末尾」，
  // 否则下面的断言会变成在测一个不存在的场景
  assert.ok(!cols.includes('quantity'), '前置条件不成立：老库里已经有 quantity 了');
  assert.equal(cols[cols.length - 1], 'sort_order', '前置条件不成立：sort_order 没排在末尾');
}

buildLegacyV2();

// 老库造好之后再挂 mock：index.ts 一旦 import 就会立刻 open()
mock.module('expo-sqlite', {
  namedExports: { openDatabaseAsync: async () => openShimDatabase(dbPath) },
});

const { getDatabase, readMeta } = await import('../src/lib/db/index.ts');
const items = await import('../src/lib/db/items.ts');

after(() => {
  closeAllShimDatabases();
  rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ 升级 */

test('v2 → v3：老库能打开，版本推进到最新，老数据一条不少', async () => {
  const db = await getDatabase();

  assert.equal(await readMeta(db, 'schema_version'), String(SCHEMA_VERSION));

  const cols = await db.getAllAsync('PRAGMA table_info(items)');
  assert.ok(
    cols.some((c) => c.name === 'quantity'),
    'quantity 列没补上 —— 这一步失败意味着老用户升级后库存功能整个不可用',
  );

  const list = await items.listItems();
  assert.equal(list.length, 2, '老数据不该在迁移中丢失');
  assert.deepEqual(
    list.map((i) => i.id).sort(),
    ['old-1', 'old-2'],
  );
});

test('v2 → v3：老数据的 quantity 一律是 null，不会被误读成「剩 0」', async () => {
  const list = await items.listItems();
  for (const item of list) {
    assert.equal(item.quantity, null, `${item.id} 的 quantity 应是 null`);
    assert.equal(item.stock, 'none', '老数据不该显示库存胶囊');
  }
});

test('v2 → v3：ALTER 补的列排在表末尾时，其余字段仍逐列读对', async () => {
  // 这条正是「禁止 SELECT *」的现场：老库里 sort_order 在末尾，
  // SELECT_VIEW 若偷懒用 i.*，价格 / 日期就会错位到别的列上。
  const one = await items.getItemView('old-1');
  assert.ok(one);
  assert.equal(one.name, '老物品一');
  assert.equal(one.price, 15.8);
  assert.equal(one.purchaseDate, '2026-01-02');
  assert.equal(one.expireDate, '2026-12-31');
  assert.equal(one.brand, '海天');
  assert.equal(one.model, '金标生抽');
  assert.equal(one.note, '老库里的备注');
  assert.equal(one.sortOrder, 0, 'v2 就写好的排序值不能被新列挤掉');
  assert.equal(one.updatedAt, 1_700_000_000_000);
});

test('迁移幂等：版本号被打回 2 后重开，加列那一步重跑一次也不报错', async () => {
  const db = await getDatabase();
  // 模拟「上次迁移跑到一半被系统杀掉」：schema_version 还停在 2。
  // 下次启动会重跑 v3 那一步 —— 判列先于加列，必须什么都不发生。
  await db.runAsync('UPDATE meta SET value = ? WHERE key = ?', '2', 'schema_version');

  // 加个查询串拿到一个**全新**的模块实例，绕开单例，真的再 open 一次
  const reopened = await import('../src/lib/db/index.ts?reopen=1');
  const db2 = await reopened.getDatabase();

  const cols = await db2.getAllAsync('PRAGMA table_info(items)');
  assert.equal(
    cols.filter((c) => c.name === 'quantity').length,
    1,
    'quantity 只应有一列 —— 多一列说明判列失效、加了两遍',
  );
  assert.equal(await reopened.readMeta(db2, 'schema_version'), String(SCHEMA_VERSION));
  assert.equal((await items.listItems()).length, 2, '重开不该影响数据');
});

/* ------------------------------------------------------------ 写路径 */

test('v3 写路径：在老库上升级后，加减、夹取、低库存筛选都能跑', async () => {
  const { adjustQuantity, setQuantity, listLowStock } = items;

  // 老数据没启用库存 → adjustQuantity 直接返回 null，不能顺手把它变成 0
  assert.equal(await adjustQuantity('old-1', 1), null, '未启用库存的物品不该被加减');
  assert.equal((await items.getItemView('old-1')).quantity, null, '不该被写成 0');

  // 启用库存后再加减
  await setQuantity('old-1', 3);
  assert.equal((await items.getItemView('old-1')).quantity, 3);

  assert.equal(await adjustQuantity('old-1', -1), 3, '应返回变动前的数量供撤销');
  assert.equal((await items.getItemView('old-1')).quantity, 2);

  // ★ 0 再减：仍返回旧值 0 —— 调用方靠 `!== null` 判断，不是真值判断
  await setQuantity('old-1', 0);
  assert.equal(await adjustQuantity('old-1', -1), 0, '返回 0 是合法结果，不能被当成「没动」');
  assert.equal((await items.getItemView('old-1')).quantity, 0, '0 再减仍是 0，不能变负数');

  // 负数 / 小数落库前要被收拾干净
  await setQuantity('old-1', -5);
  assert.equal((await items.getItemView('old-1')).quantity, 0, '表单里输 -5 不该原样落库');

  // 低库存筛选：只有 old-1 到了线
  await setQuantity('old-1', 1);
  await setQuantity('old-2', 5);
  assert.deepEqual(
    (await listLowStock()).map((i) => i.id),
    ['old-1'],
  );

  // 退订回单件
  await setQuantity('old-1', null);
  assert.equal((await items.getItemView('old-1')).quantity, null);
  assert.deepEqual(
    (await listLowStock()).map((i) => i.id),
    [],
    '退订后不该再出现在补货清单里',
  );
});

test('数量变化不改 updated_at —— 否则首页「最近变动」会被打乱', async () => {
  const { setQuantity, adjustQuantity } = items;
  const before = (await items.getItemView('old-2')).updatedAt;

  await setQuantity('old-2', 4);
  await adjustQuantity('old-2', -1);

  const after = await items.getItemView('old-2');
  assert.equal(after.quantity, 3);
  assert.equal(after.updatedAt, before, 'updated_at 是内容编辑的时间戳，不该被库存周转带着走');
});
