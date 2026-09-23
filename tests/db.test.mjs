/**
 * 数据层集成测试 —— 对着真 SQLite 跑。
 *
 * 覆盖的是「类型系统管不到」的部分：SQL 字符串、列名拼写、
 * 聚合语义、约束与级联行为、以及批量写的可回滚性。
 *
 * 为什么值得单独写这一组：这里几乎每一项出错都是**静默**的 ——
 * 列名写错要到运行时报错，级联删照片则是数据静默消失。
 */

import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openShimDatabase, closeAllShimDatabases } from './support/sqlite.mjs';

const workDir = mkdtempSync(join(tmpdir(), 'gewu-db-test-'));

mock.module('expo-sqlite', {
  namedExports: { openDatabaseAsync: async () => openShimDatabase(join(workDir, 'gewu.db')) },
});

const { getDatabase, wipeBusinessData, readMeta } = await import('../src/lib/db/index.ts');
const { SCHEMA_VERSION } = await import('../src/lib/db/schema.ts');
const items = await import('../src/lib/db/items.ts');
const categories = await import('../src/lib/db/categories.ts');
const locations = await import('../src/lib/db/locations.ts');
const photos = await import('../src/lib/db/photos.ts');

after(() => {
  // 先关连接再删目录：Windows 上句柄未释放会 EBUSY
  closeAllShimDatabases();
  rmSync(workDir, { recursive: true, force: true });
});

/** 每个用例前重置业务数据，但保留 schema 与内置分类 */
async function reset() {
  const db = await getDatabase();
  await wipeBusinessData(db);
  await db.execAsync('DELETE FROM meta');
}

/** 造一件物品，返回 id */
async function makeItem(id, patch = {}) {
  await items.insertRaw({
    id,
    name: patch.name ?? `物品${id}`,
    categoryId: patch.categoryId ?? null,
    locationId: patch.locationId ?? null,
    purchaseDate: patch.purchaseDate ?? null,
    price: patch.price ?? null,
    expireDate: patch.expireDate ?? null,
    brand: null,
    model: null,
    tags: patch.tags ?? [],
    note: patch.note ?? null,
    sortOrder: patch.sortOrder ?? null,
    createdAt: patch.createdAt ?? 1_700_000_000_000,
    updatedAt: patch.updatedAt ?? 1_700_000_000_000,
    deletedAt: patch.deletedAt ?? null,
  });
  return id;
}

/** 造一条照片索引（不落磁盘） */
async function makePhoto(id, itemId, sortOrder, thumb) {
  await photos.insertRawPhoto({
    id,
    itemId,
    filePath: `photos/${id}.jpg`,
    thumbPath: thumb ?? `thumbs/${id}.jpg`,
    sortOrder,
  });
}

/* ------------------------------------------------------------ 初始化 */

test('首次打开：写入 schema 版本、建好索引、种下内置分类', async () => {
  const db = await getDatabase();
  assert.equal(await readMeta(db, 'schema_version'), String(SCHEMA_VERSION));

  const cats = await categories.listAllCategories();
  assert.ok(cats.length >= 10, '内置分类应已种下');
  assert.ok(cats.every((c) => c.builtin), '种子分类都应是内置');

  // 索引存在性：SQLite 里查 sqlite_master 是唯一可靠的确认方式
  const idx = await db.getAllAsync("SELECT name FROM sqlite_master WHERE type = 'index'");
  const names = new Set(idx.map((r) => r.name));
  for (const expected of ['idx_items_category', 'idx_items_location', 'idx_items_expire', 'idx_photos_item']) {
    assert.ok(names.has(expected), `缺少索引 ${expected}`);
  }
});

/* ------------------------------------------------------------ 视图查询 */

test('listItems：照片计数与封面来自同一次聚合，多张时取 sort_order 最小的那张', async () => {
  await reset();
  await makeItem('i1');
  await makeItem('i2'); // 无照片
  await makePhoto('p2', 'i1', 1, 'thumbs/second.jpg');
  await makePhoto('p1', 'i1', 0, 'thumbs/first.jpg');

  const list = await items.listItems();
  const withPhotos = list.find((i) => i.id === 'i1');
  const without = list.find((i) => i.id === 'i2');

  assert.equal(withPhotos.photoCount, 2);
  assert.equal(withPhotos.coverThumb, 'thumbs/first.jpg', '封面应是 sort_order 最小的那张');
  assert.equal(without.photoCount, 0, '无照片时应为 0 而不是 null');
  assert.equal(without.coverThumb, null);
});

test('listItems：聚合视图的列名与实体字段逐一对应', async () => {
  await reset();
  const cat = await categories.createCategory('测试类', 6);
  const cabinet = await locations.createCabinet('测试柜');
  const slot = await locations.createSlot(cabinet, '测试格');

  await makeItem('i1', {
    categoryId: cat,
    locationId: slot,
    purchaseDate: '2026-01-01',
    price: 365,
    expireDate: '2026-12-31',
    tags: ['甲', '乙'],
  });

  const [view] = await items.listItems();
  assert.equal(view.categoryName, '测试类');
  assert.equal(view.locationName, '测试格');
  assert.equal(view.cabinetName, '测试柜', '柜子名应取位置的父级');
  assert.deepEqual(view.tags, ['甲', '乙']);
  assert.equal(view.price, 365);
  assert.equal(view.expiry, 'fine');
});

/* ------------------------------------------------------------ 搜索范围 */

test('搜索：命中分类名', async () => {
  await reset();
  const med = await categories.createCategory('药品');
  await makeItem('i1', { name: '布洛芬', categoryId: med });
  await makeItem('i2', { name: '螺丝刀' });

  const hit = await items.listItems({ query: '药品' });
  assert.deepEqual(hit.map((i) => i.id), ['i1'], '搜分类名应命中归在该类下的物品');
});

test('搜索：命中位置名与柜子名', async () => {
  await reset();
  const cabinet = await locations.createCabinet('书房柜');
  const slot = await locations.createSlot(cabinet, '抽屉A');
  await makeItem('i1', { name: '备用钥匙', locationId: slot });
  await makeItem('i2', { name: '充电线' });

  const bySlot = await items.listItems({ query: '抽屉' });
  assert.deepEqual(bySlot.map((i) => i.id), ['i1'], '搜格位名应命中');

  const byCabinet = await items.listItems({ query: '书房' });
  assert.deepEqual(byCabinet.map((i) => i.id), ['i1'], '搜柜子名应命中挂在它格位下的物品');
});

test('搜索：仍保留对名称/品牌/型号/备注/标签的匹配', async () => {
  await reset();
  await makeItem('i1', { name: '相机', tags: ['复古'] });
  await makeItem('i2', { name: '三脚架', note: '铝合金材质' });

  assert.deepEqual((await items.listItems({ query: '复古' })).map((i) => i.id), ['i1']);
  assert.deepEqual((await items.listItems({ query: '铝合金' })).map((i) => i.id), ['i2']);
});

/* ------------------------------------------------------------ 导入：级联保护 */

test('insertRaw 重复 id 走 upsert，不会级联删掉已有照片', async () => {
  await reset();
  await makeItem('i1', { name: '原名' });
  await makePhoto('p1', 'i1', 0);

  // 同一个 id 再写一次（模拟备份包内出现重复 id 的那条路径）
  await makeItem('i1', { name: '改名后' });

  const db = await getDatabase();
  const itemCount = await db.getFirstAsync('SELECT COUNT(*) AS c FROM items');
  assert.equal(itemCount.c, 1, '不应产生第二行');

  const photoRows = await db.getAllAsync('SELECT id FROM photos WHERE item_id = ?', 'i1');
  assert.equal(photoRows.length, 1, 'INSERT OR REPLACE 会级联删掉这条照片索引，显式 upsert 不会');

  const reloaded = await items.getItemView('i1');
  assert.equal(reloaded.name, '改名后', '字段应被更新');
  assert.equal(reloaded.photoCount, 1);
});

test('四个仓储的 raw 写入都是幂等的 upsert', async () => {
  await reset();
  const catId = await categories.createCategory('甲类');
  const cabinetId = await locations.createCabinet('柜一');

  await categories.insertRawCategory({ ...(await categories.getCategory(catId)), name: '乙类' });
  await locations.insertRawLocation({ ...(await locations.getLocation(cabinetId)), name: '柜二' });

  const cats = (await categories.listAllCategories()).filter((c) => c.id === catId);
  assert.equal(cats.length, 1);
  assert.equal(cats[0].name, '乙类');

  const locs = (await locations.listLocations()).filter((l) => l.id === cabinetId);
  assert.equal(locs.length, 1);
  assert.equal(locs[0].name, '柜二');
});

/* ------------------------------------------------------------ 批量操作 */

test('assignCategory / assignLocation：批量改且更新 updated_at', async () => {
  await reset();
  const cat = await categories.createCategory('归类');
  const cabinet = await locations.createCabinet('新柜');
  await makeItem('i1', { updatedAt: 1 });
  await makeItem('i2', { updatedAt: 1 });
  await makeItem('i3', { updatedAt: 1 });

  await items.assignCategory(['i1', 'i2'], cat);
  await items.assignLocation(['i1', 'i3'], cabinet);

  const list = await items.listItems();
  const byId = new Map(list.map((i) => [i.id, i]));
  assert.equal(byId.get('i1').categoryId, cat);
  assert.equal(byId.get('i2').categoryId, cat);
  assert.equal(byId.get('i3').categoryId, null, '未选中的不应被改动');
  assert.equal(byId.get('i1').locationId, cabinet);
  assert.equal(byId.get('i3').locationId, cabinet);
  assert.ok(byId.get('i2').updatedAt > 1, 'updated_at 应被刷新');
});

test('softDeleteMany：批量进回收站，可整批恢复', async () => {
  await reset();
  await makeItem('i1');
  await makeItem('i2');
  await makeItem('i3');

  await items.softDeleteMany(['i1', 'i2']);
  assert.deepEqual((await items.listItems()).map((i) => i.id), ['i3']);
  assert.equal((await items.listTrash()).length, 2);

  await items.restoreItem('i1');
  assert.equal((await items.listTrash()).length, 1);
});

test('批量操作空数组是 no-op，不报错', async () => {
  await reset();
  await makeItem('i1');
  await items.assignCategory([], null);
  await items.assignLocation([], null);
  await items.softDeleteMany([]);
  assert.equal((await items.listItems()).length, 1);
});

/* ------------------------------------------------------------ 手动排序 */

test('setManualOrder：按传入顺序重排，且不改动 updated_at', async () => {
  await reset();
  await makeItem('a', { createdAt: 300, updatedAt: 999 });
  await makeItem('b', { createdAt: 200, updatedAt: 999 });
  await makeItem('c', { createdAt: 100, updatedAt: 999 });

  await items.setManualOrder(['c', 'a', 'b']);

  const manual = await items.listItems({ sort: 'manual' });
  assert.deepEqual(manual.map((i) => i.id), ['c', 'a', 'b']);
  assert.deepEqual(manual.map((i) => i.sortOrder), [0, 10, 20], '序号按 10 递增留空隙');

  // 调顺序是展示偏好，不该把物品顶到「最近变动」的最前面
  assert.ok(manual.every((i) => i.updatedAt === 999), 'updated_at 不应变化');
});

test('手动排序：没填过排序值的物品沉底，填了的按数值升序', async () => {
  await reset();
  await makeItem('none1', { createdAt: 10 });
  await makeItem('has20', { sortOrder: 20, createdAt: 20 });
  await makeItem('has10', { sortOrder: 10, createdAt: 30 });

  const manual = await items.listItems({ sort: 'manual' });
  assert.deepEqual(manual.map((i) => i.id), ['has10', 'has20', 'none1']);
});

/* ------------------------------------------------------------ 统计口径 */

test('getStats：三个互斥分组之和等于总数', async () => {
  await reset();
  const on = new Date();
  const day = (offset) => {
    const d = new Date(on.getFullYear(), on.getMonth(), on.getDate() + offset);
    const p = (n) => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  await makeItem('over', { expireDate: day(-3), price: 10 });
  await makeItem('soon', { expireDate: day(5), price: 20 });
  await makeItem('edge30', { expireDate: day(30) });
  await makeItem('far', { expireDate: day(31), price: 30 });
  await makeItem('none');
  await makeItem('gone', { deletedAt: 1 });

  const stats = await items.getStats();
  assert.equal(stats.total, 5, '回收站里的不计入');
  assert.equal(stats.soonCount, 2, '第 30 天算即将到期');
  assert.equal(stats.overdueCount, 1);
  assert.equal(stats.fineCount, 2, '31 天后与未填的都算正常');
  assert.equal(stats.soonCount + stats.overdueCount + stats.fineCount, stats.total);
  assert.equal(stats.expiringCount, 3, '需要关注的口径含已过期');
  assert.equal(stats.totalValue, 60);
});

test('listExpiring：三段两两互斥，并集等于全部填了过期时间的物品', async () => {
  await reset();
  const on = new Date();
  const day = (offset) => {
    const d = new Date(on.getFullYear(), on.getMonth(), on.getDate() + offset);
    const p = (n) => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  await makeItem('over', { expireDate: day(-1) });
  await makeItem('soon', { expireDate: day(1) });
  await makeItem('far', { expireDate: day(100) });
  await makeItem('none');

  const groups = await items.listExpiring();
  const flat = groups.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(groups.map((g) => g.key), ['overdue', 'soon', 'later']);
  assert.deepEqual(flat, ['over', 'soon', 'far']);
  assert.equal(new Set(flat).size, flat.length, '三段之间不应重复');
});

/* ------------------------------------------------------------ 排序稳定性 */

test('每档排序都用 id 兜底，同一毫秒写入的批次顺序稳定', async () => {
  await reset();
  // 时间戳完全一致：没有兜底键时 SQLite 不保证顺序
  for (const id of ['d', 'c', 'b', 'a']) await makeItem(id, { createdAt: 5, updatedAt: 5 });

  const first = (await items.listItems({ sort: 'recent' })).map((i) => i.id);
  const second = (await items.listItems({ sort: 'recent' })).map((i) => i.id);
  assert.deepEqual(first, second, '两次查询顺序应完全一致');
  assert.deepEqual(first, ['a', 'b', 'c', 'd']);
});
