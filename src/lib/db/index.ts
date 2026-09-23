/**
 * 格物 · 数据库连接与初始化
 *
 * 单例；首次打开时建表、写 meta、seed 内置分类。
 * 所有 SQL 只在本文件与各 repository 内出现，页面层不得直接访问 db。
 */

import * as SQLite from 'expo-sqlite';

import { uuid } from '../id';
import { BUILTIN_CATEGORIES } from '../suggest';
import { CREATE_INDEXES, CREATE_META, CREATE_TABLES, DB_NAME, PRAGMAS, SCHEMA_VERSION } from './schema';

export type Database = SQLite.SQLiteDatabase;

let dbPromise: Promise<Database> | null = null;

/** 获取数据库单例；并发调用只会打开一次 */
export function getDatabase(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = open();
  }
  return dbPromise;
}

async function open(): Promise<Database> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);

  for (const pragma of PRAGMAS) {
    await db.execAsync(pragma);
  }

  await db.execAsync(CREATE_META);
  await db.execAsync(CREATE_TABLES);

  const version = await readMeta(db, 'schema_version');
  if (version === null) {
    // 新库：建表脚本已是最新结构，无需迁移，直接打上当前版本号
    await writeMeta(db, 'schema_version', String(SCHEMA_VERSION));
  } else {
    const from = Number(version);
    if (Number.isFinite(from) && from < SCHEMA_VERSION) {
      await migrate(db, from);
    }
  }

  // 索引必须在迁移之后建 —— 新索引可能引用本版本才补上的列
  await db.execAsync(CREATE_INDEXES);

  await seedCategories(db);

  return db;
}

/* ------------------------------------------------------------ 迁移 */

interface Migration {
  /** 目标版本；执行成功后把 meta.schema_version 写成它 */
  to: number;
  run: (db: Database) => Promise<void>;
}

/**
 * 逐版本迁移，从 meta 里记的版本往上一档一档跑。
 *
 * 约定：**每一步都必须幂等**。中断后下次重开要能接着跑而不报错，
 * 所以判列先于加列，不用 try/catch 兜。
 */
const MIGRATIONS: Migration[] = [
  {
    // v2：物品表新增手动排序值
    to: 2,
    run: async (db) => {
      if (!(await hasColumn(db, 'items', 'sort_order'))) {
        await db.execAsync('ALTER TABLE items ADD COLUMN sort_order INTEGER;');
      }
    },
  },
];

async function hasColumn(db: Database, table: string, column: string): Promise<boolean> {
  const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

async function migrate(db: Database, from: number): Promise<void> {
  for (const step of MIGRATIONS) {
    if (step.to <= from) continue;
    await step.run(db);
    await writeMeta(db, 'schema_version', String(step.to));
  }
}

/* ------------------------------------------------------------ meta */

export async function readMeta(db: Database, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
  return row?.value ?? null;
}

export async function writeMeta(db: Database, key: string, value: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

/* ------------------------------------------------------------ seed */

/**
 * 写入内置分类。幂等：按 name 判重，已存在则只补回被改动的 sort_order。
 * 内置分类不能被删除（builtin = 1），保证猜词结果永远有实体可挂。
 */
async function seedCategories(db: Database): Promise<void> {
  const existing = await db.getAllAsync<{ name: string }>('SELECT name FROM categories');
  const known = new Set(existing.map((r) => r.name));

  const missing = BUILTIN_CATEGORIES.filter((c) => !known.has(c.name));
  if (missing.length === 0) return;

  await db.withTransactionAsync(async () => {
    let order = 0;
    for (const cat of BUILTIN_CATEGORIES) {
      if (known.has(cat.name)) {
        order += 1;
        continue;
      }
      await db.runAsync(
        'INSERT INTO categories (id, name, parent_id, default_expire_months, sort_order, builtin) VALUES (?, ?, NULL, ?, ?, 1)',
        uuid(),
        cat.name,
        cat.expireMonths,
        order,
      );
      order += 1;
    }
  });
}

/* ------------------------------------------------------------ 生命周期 */

/**
 * 清空业务数据，但不动 schema 与 meta。
 * 导入「全量覆盖」用它 —— 之后再按备份内容原样写回，
 * 所以这里刻意不 seed 分类（避免和备份里的分类重名）。
 */
export async function wipeBusinessData(db: Database): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync('DELETE FROM photos');
    await db.execAsync('DELETE FROM items');
    await db.execAsync('DELETE FROM locations');
    await db.execAsync('DELETE FROM categories');
  });
}
