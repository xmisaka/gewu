/**
 * 格物 · 数据库结构
 *
 * 四张表：items / categories / locations / photos。
 * 所有主键为 TEXT UUID；所有关联字段为 TEXT UUID；
 * 时间戳统一 INTEGER（毫秒），便于排序与导出。
 */

export const DB_NAME = 'gewu.db';

/** schema 版本号；递增时需在 migrate 中补对应步骤 */
export const SCHEMA_VERSION = 2;

export const PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA synchronous = NORMAL;',
];

export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS categories (
  id                    TEXT    PRIMARY KEY NOT NULL,
  name                  TEXT    NOT NULL,
  parent_id             TEXT,
  default_expire_months INTEGER,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  builtin               INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS locations (
  id         TEXT    PRIMARY KEY NOT NULL,
  name       TEXT    NOT NULL,
  parent_id  TEXT,
  note       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  builtin    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id            TEXT    PRIMARY KEY NOT NULL,
  name          TEXT    NOT NULL,
  category_id   TEXT,
  location_id   TEXT,
  purchase_date TEXT,
  price         REAL,
  expire_date   TEXT,
  brand         TEXT,
  model         TEXT,
  tags          TEXT    NOT NULL DEFAULT '[]',
  note          TEXT,
  -- v2 新增：手动排序值。可空 —— 空表示未指定，手动排序时排在最后。
  -- 老库靠 migrate 里的 ALTER TABLE 补列，列位置会排在 created_at 之后，
  -- 因此所有读写都必须显式列名，不能用 SELECT * 依赖顺序。
  sort_order    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT    PRIMARY KEY NOT NULL,
  item_id    TEXT    NOT NULL,
  file_path  TEXT    NOT NULL,
  thumb_path TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
);
`;

/**
 * 索引单独一段，**必须在迁移之后执行**。
 * 原因：老库升级时 `CREATE TABLE IF NOT EXISTS` 什么都不做，
 * 若索引写在上面的脚本里、引用了本版本才新增的列，整个建表脚本会当场报
 * "no such column" 而打不开数据库。
 */
export const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_items_category    ON items (category_id);
CREATE INDEX IF NOT EXISTS idx_items_location    ON items (location_id);
CREATE INDEX IF NOT EXISTS idx_items_deleted     ON items (deleted_at);
CREATE INDEX IF NOT EXISTS idx_items_expire      ON items (expire_date);
CREATE INDEX IF NOT EXISTS idx_items_updated     ON items (updated_at);
CREATE INDEX IF NOT EXISTS idx_items_sort        ON items (sort_order);
CREATE INDEX IF NOT EXISTS idx_locations_parent  ON locations (parent_id);
CREATE INDEX IF NOT EXISTS idx_photos_item       ON photos (item_id, sort_order);
`;

/** 元信息表：记录 schema 版本，供后续迁移判断 */
export const CREATE_META = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;
