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
    quantity: patch.quantity ?? null,
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

/**
 * 造一个内置分类。
 *
 * 为什么不直接用种子里那些：`reset()` 会把 categories 整表清掉，
 * 而播种只在 `open()` 里跑一次（进程内由 dbPromise 保证），不会补回来。
 * 走 insertRawCategory 是「导入备份」那条真实通路，同样能置 builtin = 1。
 */
async function makeBuiltinCategory(id, name, months = null) {
  await categories.insertRawCategory({
    id,
    name,
    parentId: null,
    defaultExpireMonths: months,
    sortOrder: 0,
    builtin: true,
  });
  return id;
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
  assert.equal(stats.attentionCount, 3, '没有一件启用库存，两个口径此时相等');
  assert.equal(stats.totalValue, 60);
});

test('getStats：attentionCount 把「该补货」并进来，且与到期部分去重', async () => {
  await reset();
  const on = new Date();
  const day = (offset) => {
    const d = new Date(on.getFullYear(), on.getMonth(), on.getDate() + offset);
    const p = (n) => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  await makeItem('lowOnly', { quantity: 1 });
  await makeItem('lowAndExpiring', { quantity: 0, expireDate: day(2) });
  await makeItem('okStock', { quantity: 8 });
  await makeItem('expiringOnly', { expireDate: day(-1) });
  await makeItem('farAway', { expireDate: day(90) });
  await makeItem('plain');

  const stats = await items.getStats();
  assert.equal(stats.expiringCount, 2, '到期口径：只数填了过期时间且 ≤30 天的');
  assert.equal(
    stats.attentionCount,
    3,
    '待办口径：lowOnly + lowAndExpiring + expiringOnly；lowAndExpiring 两个条件都命中，只算一件',
  );
  /* ★ 这一条是这次改动的要害：角标数与提醒页里实际列出的行数必须相等。
     提醒页列的是「该补货了」+「已过期」+「30 天内到期」三组去重后的并集。 */
  const groups = await items.listExpiring();
  const low = await items.listLowStock();
  const ids = new Set();
  for (const g of groups) {
    if (g.key === 'later') continue;
    for (const it of g.items) ids.add(it.id);
  }
  for (const it of low) ids.add(it.id);
  assert.equal(stats.attentionCount, ids.size, '角标必须等于提醒页里能数出来的件数');
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

/* ------------------------------------------------------------ 分类管理 */

test('分类：新建带上默认保质期，重名（含只差大小写）被拒', async () => {
  await reset();
  const id = await categories.createCategory('相机镜头', 24);

  const created = (await categories.listCategories()).find((c) => c.id === id);
  assert.equal(created.name, '相机镜头');
  assert.equal(created.defaultExpireMonths, 24);
  assert.equal(created.builtin, false, '新建的一律是自定义分类');

  await assert.rejects(() => categories.createCategory('相机镜头'), /已经有/, '同名应被拒');
  await categories.createCategory('USB');
  await assert.rejects(() => categories.createCategory('usb'), /已经有/, '只差大小写也算重名');
  await assert.rejects(() => categories.createCategory('   '), /不能为空/);
  await assert.rejects(() => categories.createCategory('一'.repeat(13)), /最多/);
});

test('分类：改名与改保质期，撞到别人名字时报错且不写入', async () => {
  await reset();
  const a = await categories.createCategory('甲类', 12);
  const b = await categories.createCategory('乙类');

  await categories.updateCategory(a, '甲类改', 6);
  const renamed = (await categories.listCategories()).find((c) => c.id === a);
  assert.equal(renamed.name, '甲类改');
  assert.equal(renamed.defaultExpireMonths, 6);

  // 改成自己当前的名字不该算冲突（判重要把自己排除在外）
  await categories.updateCategory(a, '甲类改', 6);

  await assert.rejects(() => categories.updateCategory(a, '乙类', 6), /已经有/);
  const after = await categories.listCategories();
  assert.equal(after.find((c) => c.id === a).name, '甲类改', '失败后不应被写坏');
  assert.equal(after.find((c) => c.id === b).name, '乙类', '被撞的那条也不该被动过');
});

test('分类：自定义可删且物品回到未分类，内置不可删', async () => {
  await reset();
  const custom = await categories.createCategory('临时类');
  await makeBuiltinCategory('b1', '数码');
  await makeItem('i1', { categoryId: custom });
  await makeItem('i2', { categoryId: custom });

  assert.equal((await categories.deleteCategory(custom)).ok, true);

  const list = await items.listItems();
  assert.equal(list.length, 2, '删分类不能连物品一起删');
  assert.ok(
    list.every((i) => i.categoryId === null && i.categoryName === null),
    '物品应回到未分类',
  );

  const refused = await categories.deleteCategory('b1');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /内置/);
  assert.equal((await categories.getCategory('b1')).name, '数码', '内置分类应还在');
});

test('分类：顺序按传入数组整体重写，空数组是 no-op', async () => {
  await reset();
  const a = await categories.createCategory('一');
  const b = await categories.createCategory('二');
  const c = await categories.createCategory('三');

  await categories.applyCategoryOrder([c, a, b]);
  const ordered = await categories.listCategories();
  assert.deepEqual(ordered.map((x) => x.id), [c, a, b]);
  assert.deepEqual(ordered.map((x) => x.sortOrder), [0, 1, 2], '重写后应是连续序号');

  await categories.applyCategoryOrder([]);
  assert.deepEqual((await categories.listCategories()).map((x) => x.id), [c, a, b]);
});

test('分类：内置分类改名后旧名不复活，总数与内置标记都不变', async () => {
  await reset();
  await makeBuiltinCategory('b1', '数码');
  const before = await categories.listCategories();

  await categories.updateCategory('b1', '电子产品', null);

  const after = await categories.listCategories();
  assert.equal(after.length, before.length, '总数不变 —— 播种不该按旧名补第二条回来');
  assert.equal(after.find((c) => c.id === 'b1').name, '电子产品');
  assert.ok(!after.some((c) => c.name === '数码'), '旧名不该重新出现');
  assert.equal(after.find((c) => c.id === 'b1').builtin, true, '改名不该丢掉内置标记');
});

test('分类：整表被清空后不会自动补种（否则内置名会被占用）', async () => {
  await reset();
  assert.equal((await categories.listCategories()).length, 0, 'wipeBusinessData 之后分类表应是真的空的');

  // 「药品」是内置名。能建成功，说明播种没有在每次开库时重跑
  // —— 若有人把 seedCategories 挪回按名补的写法，这里会直接抛「已经有」。
  const id = await categories.createCategory('药品', 24);
  assert.equal((await categories.listCategories()).find((c) => c.id === id).builtin, false);
});

/* ------------------------------------------------------------ 标签 */

test('标签候选：按频次聚合，回收站里的不算', async () => {
  await reset();
  await makeItem('t1', { tags: ['办公', '备用'] });
  await makeItem('t2', { tags: ['办公'] });
  await makeItem('t3', { tags: ['办公'], deletedAt: 1_700_000_000_001 });

  const list = await items.listTagCounts();
  assert.deepEqual(
    list.map((t) => `${t.tag}:${t.count}`),
    ['办公:2', '备用:1'],
    '回收站里的那条不该把「办公」灌到 3',
  );
});

test('按标签筛选：整词命中，「办公」不会命中「办公用品」', async () => {
  await reset();
  await makeItem('a', { name: 'A', tags: ['办公'] });
  await makeItem('b', { name: 'B', tags: ['办公用品'] });

  // 库里存的是 ["办公"]，筛选靠两侧引号定界；漏了引号这里会命中两条
  assert.deepEqual((await items.listItems({ tags: ['办公'] })).map((x) => x.id), ['a']);
  assert.deepEqual((await items.listItems({ tags: ['办公用品'] })).map((x) => x.id), ['b']);
});

test('按标签筛选：多个标签是「含任一」（OR），空数组等于不筛', async () => {
  await reset();
  await makeItem('a', { tags: ['办公'] });
  await makeItem('b', { tags: ['备用'] });
  await makeItem('c', { tags: ['易碎'] });

  assert.deepEqual(
    (await items.listItems({ tags: ['办公', '备用'] })).map((x) => x.id).sort(),
    ['a', 'b'],
    'OR：只含其中一个也要出来',
  );
  assert.equal((await items.listItems({ tags: [] })).length, 3, '★ 空数组是「不筛」，不是「全不命中」');
});

test('按标签筛选：标签里的 _ 和 % 不会被当成 LIKE 通配符', async () => {
  await reset();
  await makeItem('a', { tags: ['备_用'] });
  await makeItem('b', { tags: ['备份用'] });
  await makeItem('c', { tags: ['折%扣'] });
  await makeItem('d', { tags: ['折上扣'] });

  // 不转义的话 `%"备_用"%` 会连「备份用」一起捞出来 —— 静默多匹配，最难查
  assert.deepEqual((await items.listItems({ tags: ['备_用'] })).map((x) => x.id), ['a']);
  assert.deepEqual((await items.listItems({ tags: ['折%扣'] })).map((x) => x.id), ['c']);
});

test('标签改名：跨全部物品（含回收站），且不动 updated_at', async () => {
  await reset();
  await makeItem('a', { tags: ['办公', '备用'], updatedAt: 111 });
  await makeItem('b', { tags: ['办公'], updatedAt: 222, deletedAt: 333 });
  await makeItem('c', { tags: ['易碎'], updatedAt: 444 });

  const changed = await items.rewriteTags({ type: 'rename', from: '办公', to: '办公用品' });
  assert.equal(changed, 2, '只报真的被改过的件数');

  assert.deepEqual((await items.getRawItem('a')).tags, ['办公用品', '备用']);
  assert.deepEqual((await items.getRawItem('b')).tags, ['办公用品'], '★ 回收站里的也要改，否则恢复后旧名复活');
  assert.deepEqual((await items.getRawItem('c')).tags, ['易碎'], '不相关的物品一个字段都不该动');

  // ★ 这条是整块的关键：列表默认按「最近变动」排，改时间戳会让几百件物品集体跳到最前
  assert.equal((await items.getRawItem('a')).updatedAt, 111, '改名是改元数据，不该动 updated_at');
  assert.equal((await items.getRawItem('b')).updatedAt, 222);
});

test('标签合并：改成一个已存在的标签后同一条上自动去重', async () => {
  await reset();
  await makeItem('a', { tags: ['办公', '办公用品'] });

  assert.equal(await items.rewriteTags({ type: 'rename', from: '办公', to: '办公用品' }), 1);
  assert.deepEqual((await items.getRawItem('a')).tags, ['办公用品'], '合完只剩一个，不出现两个同名');
});

test('标签删除：从所有物品上摘掉，物品本身不动', async () => {
  await reset();
  await makeItem('a', { tags: ['办公', '备用'] });
  await makeItem('b', { tags: ['办公'] });

  assert.equal(await items.rewriteTags({ type: 'delete', tag: '办公' }), 2);
  assert.deepEqual((await items.getRawItem('a')).tags, ['备用']);
  assert.deepEqual((await items.getRawItem('b')).tags, []);
  assert.equal((await items.listItems()).length, 2, '物品本身不该被删');
});

test('标签改完之后候选立刻反映新状态（没有中间缓存）', async () => {
  await reset();
  await makeItem('a', { tags: ['办公'] });

  await items.rewriteTags({ type: 'rename', from: '办公', to: '办公用品' });
  const list = await items.listTagCounts();
  assert.deepEqual(list.map((t) => t.tag), ['办公用品'], '旧名不该还在候选里');

  await items.rewriteTags({ type: 'delete', tag: '办公用品' });
  assert.deepEqual(await items.listTagCounts(), [], '最后一个用它的物品摘掉后，候选里就该消失');
});

test('批量加标签：并集，不动原有标签，且更新 updated_at', async () => {
  await reset();
  await makeItem('a', { tags: ['办公'], updatedAt: 111 });
  await makeItem('b', { tags: [], updatedAt: 222 });
  await makeItem('c', { tags: ['易碎'], updatedAt: 333 });

  await items.addTagsToItems(['a', 'b'], ['备用', '办公']);

  assert.deepEqual((await items.getRawItem('a')).tags, ['办公', '备用'], '并集 + 去重，原有标签留在前面');
  assert.deepEqual((await items.getRawItem('b')).tags, ['备用', '办公'], '原本没有标签的按选中顺序追加');
  assert.deepEqual((await items.getRawItem('c')).tags, ['易碎'], '没选中的一件都不该动');
  assert.equal((await items.getRawItem('c')).updatedAt, 333, '没选中的时间戳也不该动');

  // 与 rewriteTags 的口径**故意相反**：这是用户对选中项的编辑动作，与批量补分类同类
  assert.notEqual((await items.getRawItem('a')).updatedAt, 111, '批量加标签要动 updated_at');
  assert.notEqual((await items.getRawItem('b')).updatedAt, 222);
});

test('批量加标签：空标签或空选中都是 no-op，不报错', async () => {
  await reset();
  await makeItem('a', { tags: ['办公'], updatedAt: 111 });

  await items.addTagsToItems(['a'], []);
  await items.addTagsToItems([], ['备用']);
  await items.addTagsToItems(['a'], ['  ', '']);

  assert.deepEqual((await items.getRawItem('a')).tags, ['办公']);
  assert.equal((await items.getRawItem('a')).updatedAt, 111, 'no-op 不该顺手改时间戳');
});

/* ------------------------------------------------------------ 同名检出 */

test('同名检出：只认在库的，且能排掉自己', async () => {
  await reset();
  await makeItem('a', { name: 'Type-C 数据线 1 米' });
  await makeItem('b', { name: 'Type-C 数据线 2 米' });
  await makeItem('c', { name: 'Type-C 数据线 1 米', deletedAt: 1_700_000_000_001 });

  const hits = await items.findItemsByName('Type-C 数据线 1 米');
  assert.deepEqual(hits.map((h) => h.id), ['a'], '★ 回收站里的不算 —— 用户已经删掉它了，再提示同名只是噪音');

  const excluding = await items.findItemsByName('Type-C 数据线 1 米', 'a');
  assert.deepEqual(excluding, [], '★ 编辑模式要排掉自己，否则改个标点就提示「你和你自己重名」');
});

test('同名检出：忽略首尾空白与 ASCII 大小写，但不折叠内部空白', async () => {
  await reset();
  await makeItem('a', { name: 'USB 线' });
  await makeItem('b', { name: ' Type-C ' });

  assert.deepEqual((await items.findItemsByName('usb 线')).map((h) => h.id), ['a'], 'COLLATE NOCASE');
  assert.deepEqual((await items.findItemsByName('Type-C')).map((h) => h.id), ['b'], '两侧空白不算差异');
  // 内部空白的差异 SQL 里折叠不了：宁可漏报也不能误报
  // （误报会让用户以为库里真有两件，翻半天找不到）
  assert.deepEqual(await items.findItemsByName('Type-C 线'), []);
});

test('同名检出：空名字直接返回空，不扫全表', async () => {
  await reset();
  await makeItem('a', { name: '东西' });
  assert.deepEqual(await items.findItemsByName(''), []);
  assert.deepEqual(await items.findItemsByName('   '), []);
});

test('同名检出：带上所在位置，提示里才说得清「最近一件在哪」', async () => {
  await reset();
  const cabinet = await locations.createCabinet('书房柜');
  const slot = await locations.createSlot(cabinet, '第一格');
  await makeItem('a', { name: '充电宝', locationId: slot });

  const [hit] = await items.findItemsByName('充电宝');
  assert.equal(hit.locationName, '第一格');
  assert.equal(hit.cabinetName, '书房柜', '格位要能带出它的柜子，否则提示里只有「第一格」等于没说');
});
