/* 探针：v3 迁移（加 cost_mode / use_count）在真 SQLite 上是否安全 + 幂等。
   刻意复用 v2 的建表脚本文本，模拟「老库升级」而不是新库。 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gewu-probe-'));
const db = new DatabaseSync(join(dir, 'v2.db'));
const log = [];
function ok(label, cond, extra) {
  log.push((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  -> ' + extra : ''));
}

// ---- 1) 建一个 v2 老库（列序里没有新列） ----
db.exec(`
CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category_id TEXT, location_id TEXT,
  purchase_date TEXT, price REAL, expire_date TEXT, brand TEXT, model TEXT,
  tags TEXT NOT NULL DEFAULT '[]', note TEXT, sort_order INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
INSERT INTO meta (key,value) VALUES ('schema_version','2');
INSERT INTO items (id,name,purchase_date,price,tags,created_at,updated_at)
  VALUES ('t1','双人帐篷','2025-08-05',1280,'[]',1,1);
`);
const colsBefore = db.prepare('PRAGMA table_info(items)').all().map((r) => r.name);
ok('v2 老库确认无 use_count 列', !colsBefore.includes('use_count'));

// ---- 2) 先复现「索引写进建表脚本」的错误顺序，拿到真实报错 ----
let wrongOrderErr = '';
try {
  db.exec('CREATE INDEX idx_items_use ON items (use_count);');
} catch (e) {
  wrongOrderErr = e.message;
}
ok('索引早于迁移会当场报错（复现既有坑位）', /no such column/.test(wrongOrderErr), JSON.stringify(wrongOrderErr));

// ---- 3) 正确顺序：先迁移 ----
const hasColumn = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
const migrateTo3 = () => {
  if (!hasColumn('items', 'cost_mode')) db.exec('ALTER TABLE items ADD COLUMN cost_mode TEXT;');
  if (!hasColumn('items', 'use_count')) db.exec('ALTER TABLE items ADD COLUMN use_count INTEGER;');
};
migrateTo3();
const colsAfter = db.prepare('PRAGMA table_info(items)').all().map((r) => r.name);
ok('ALTER 成功加两列', colsAfter.includes('cost_mode') && colsAfter.includes('use_count'));
ok(
  '新列排在表末尾（老新库列序不同 -> 必须显式列名）',
  colsAfter.indexOf('use_count') > colsAfter.indexOf('created_at'),
  'use_count@' + colsAfter.indexOf('use_count') + ', created_at@' + colsAfter.indexOf('created_at'),
);

const old = db.prepare('SELECT id,name,price,cost_mode,use_count FROM items WHERE id=?').get('t1');
ok('老行两个新列都是 NULL（未指定）', old.cost_mode === null && old.use_count === null, JSON.stringify(old));

// ---- 4) 幂等：再跑两次不应报错 ----
let idem = 'ok';
try {
  migrateTo3();
  migrateTo3();
} catch (e) {
  idem = e.message;
}
ok('迁移可重复执行（幂等）', idem === 'ok', idem);

// ---- 5) 索引在迁移之后建，这次不该报错 ----
db.prepare('CREATE INDEX IF NOT EXISTS idx_items_use ON items (use_count);').run();
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
ok('迁移后建索引成功', idx.includes('idx_items_use'), idx.join(','));

// ---- 6) 部分索引：只给「按次」的物品建索引，不给全体物品加负担 ----
db.prepare("CREATE INDEX IF NOT EXISTS idx_items_cost_mode ON items (cost_mode) WHERE cost_mode = 'usage'").run();
const idx2 = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
ok('支持部分索引（WHERE cost_mode = usage）', idx2.includes('idx_items_cost_mode'));

// ---- 7) 列序不同也能正确读回 ----
db.prepare("UPDATE items SET cost_mode='usage', use_count=12 WHERE id='t1'").run();
const r = db.prepare('SELECT id,name,price,cost_mode,use_count FROM items WHERE id=?').get('t1');
ok('显式列名读回正确', r.cost_mode === 'usage' && r.use_count === 12, JSON.stringify(r));

console.log(log.join('\n'));

// ---- 8) 方案页要用的真实数字 ----
console.log('\n=== 方案页示例数据（价格 / 次数 vs 价格 / 天数） ===');
const cases = [
  ['双人帐篷', 1280, 12, 420],
  ['西装', 2400, 4, 800],
  ['相机镜头', 5600, 96, 365],
  ['登山杖', 260, 0, 90],
];
for (const c of cases) {
  const name = c[0], price = c[1], uses = c[2], days = c[3];
  const perUse = uses === 0 ? null : price / uses;
  console.log(
    name.padEnd(5) + ' ¥' + String(price).padEnd(6) +
    String(uses).padStart(3) + ' 次 -> 每次 ' +
    (perUse === null ? '(除零，须隐藏)' : '¥' + perUse.toFixed(2)).padEnd(9) +
    ' | ' + String(days).padStart(4) + ' 天 -> 每天 ¥' + (price / days).toFixed(2),
  );
}
console.log('\n除零语义：1280 / 0 = ' + 1280 / 0 + ' -> 必须像现在 price>0 那样守住，整行隐藏，绝不能显示 ¥Infinity');
console.log('对比反差：帐篷按天 ¥3.05（看着超值）、按次 ¥106.67（一年只露营 12 次）—— 这正是要加按次的理由，也是最难看的一张脸');

db.close();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {}
