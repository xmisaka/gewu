/**
 * 格物 · 物品仓储
 *
 * 唯一允许拼装 ItemView 的地方：列表、详情、搜索、统计、提醒全部走这里，
 * 保证派生指标与到期状态在所有页面的口径完全一致。
 */

import { dailyCost, expiryState, holdingDays, today } from '../date';
import { uuid } from '../id';
import type { Database } from './index';
import { getDatabase } from './index';
import type {
  DateString,
  ExpiringGroup,
  Item,
  ItemDraft,
  ItemSort,
  ItemStats,
  ItemView,
} from '../types';

/* ------------------------------------------------------------ 行 ↔ 模型 */

interface ItemRow {
  id: string;
  name: string;
  category_id: string | null;
  location_id: string | null;
  purchase_date: string | null;
  price: number | null;
  expire_date: string | null;
  brand: string | null;
  model: string | null;
  tags: string | null;
  note: string | null;
  sort_order: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  category_name: string | null;
  location_name: string | null;
  cabinet_name: string | null;
  photo_count: number;
  cover_thumb: string | null;
}

/** 列表查询的统一 SELECT 前缀；`_WHERE_` 由调用方替换 */
const SELECT_VIEW = `
SELECT
  i.*,
  c.name AS category_name,
  l.name AS location_name,
  pl.name AS cabinet_name,
  (SELECT COUNT(*) FROM photos p WHERE p.item_id = i.id) AS photo_count,
  (SELECT p.thumb_path FROM photos p WHERE p.item_id = i.id ORDER BY p.sort_order ASC LIMIT 1) AS cover_thumb
FROM items i
LEFT JOIN categories c  ON c.id = i.category_id
LEFT JOIN locations  l  ON l.id = i.location_id
LEFT JOIN locations  pl ON pl.id = l.parent_id
`;

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    locationId: row.location_id,
    purchaseDate: row.purchase_date,
    price: row.price,
    expireDate: row.expire_date,
    brand: row.brand,
    model: row.model,
    tags: parseTags(row.tags),
    note: row.note,
    sortOrder: row.sort_order ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/**
 * 派生指标在此实时计算，绝不落库。
 * 降级规则：任一前提缺失 → 字段为 null，UI 侧整行/整卡隐藏。
 */
function toItemView(row: ItemRow, on: DateString): ItemView {
  const base = toItem(row);
  const { state, days } = expiryState(base.expireDate, on);
  return {
    ...base,
    categoryName: row.category_name,
    locationName: row.location_name,
    cabinetName: row.cabinet_name,
    photoCount: row.photo_count ?? 0,
    coverThumb: row.cover_thumb ?? null,
    expiry: state,
    daysToExpiry: days,
    holdingDays: holdingDays(base.purchaseDate, on),
    dailyCost: dailyCost(base.price, base.purchaseDate, on),
  };
}

/* ------------------------------------------------------------ 查询 */

export interface ListOptions {
  /** 模糊搜索词，匹配名称 / 品牌 / 型号 / 备注 / 标签 */
  query?: string;
  categoryId?: string | null;
  /** 传柜子 ID 时包含其下所有格位 */
  locationId?: string | null;
  /** 只看逾期与即将到期 */
  onlyExpiring?: boolean;
  /** 排序方式；缺省为「最近变动」，与改版前行为一致 */
  sort?: ItemSort;
  limit?: number;
  offset?: number;
}

/** 默认排序：最近变动 */
export const DEFAULT_ITEM_SORT: ItemSort = 'recent';

/**
 * 各排序方式对应的 ORDER BY。
 *
 * 每条都补了 `i.id` 作为最后一个键 —— 时间戳到毫秒，批量录入很容易撞在同一毫秒里，
 * 没有兜底键时 SQLite 不保证顺序稳定，同一批次的前后次序会飘。
 */
const SORT_SQL: Record<ItemSort, string> = {
  recent: 'i.updated_at DESC, i.created_at DESC, i.id ASC',
  added: 'i.created_at DESC, i.updated_at DESC, i.id ASC',
  /** 仅作稳定兜底：真正的中文顺序在 JS 里用 Collator 重排，见 compareByName */
  name: 'i.name ASC, i.id ASC',
  /** 最快到期的排前面（已过期的自然最靠前）；没填过期时间的沉底 */
  expire: "(i.expire_date IS NULL OR i.expire_date = '') ASC, i.expire_date ASC, i.name ASC, i.id ASC",
  /** 手动排序：填了值的按数值升序，没填的沉底后退化成最近录入 */
  manual: '(i.sort_order IS NULL) ASC, i.sort_order ASC, i.created_at DESC, i.id ASC',
};

/**
 * 中文名称排序用拼音，SQLite 的 BINARY 比较是按 UTF-8 码位走的，
 * 对汉字等于随机顺序，必须拿到 JS 里重排。
 * Hermes 在 Android 上带 Intl（走平台 ICU）；万一某环境没实现，退回 localeCompare 也不至于崩。
 */
const nameCollator = (() => {
  try {
    return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  } catch {
    return null;
  }
})();

function compareByName(a: ItemView, b: ItemView): number {
  const diff = nameCollator ? nameCollator.compare(a.name, b.name) : a.name.localeCompare(b.name);
  return diff !== 0 ? diff : b.createdAt - a.createdAt;
}

export async function listItems(options: ListOptions = {}): Promise<ItemView[]> {
  const db = await getDatabase();
  const on = today();
  const sort = options.sort ?? DEFAULT_ITEM_SORT;
  const where: string[] = ['i.deleted_at IS NULL'];
  const args: (string | number)[] = [];

  if (options.query && options.query.trim()) {
    const q = `%${options.query.trim()}%`;
    where.push('(i.name LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR i.note LIKE ? OR i.tags LIKE ?)');
    args.push(q, q, q, q, q);
  }

  if (options.categoryId) {
    where.push('i.category_id = ?');
    args.push(options.categoryId);
  }

  if (options.locationId) {
    // 柜子粒度：命中柜子自身或其任一格位
    where.push('(i.location_id = ? OR i.location_id IN (SELECT id FROM locations WHERE parent_id = ?))');
    args.push(options.locationId, options.locationId);
  }

  if (options.onlyExpiring) {
    where.push("i.expire_date IS NOT NULL AND i.expire_date <> ''");
    where.push('julianday(i.expire_date) - julianday(?) <= 30');
    args.push(on);
  }

  // 按名称排序要整体取回后重排，分页只能挪到排序之后，不能交给 SQL
  const pagingInSql = sort !== 'name';

  let sql = `${SELECT_VIEW} WHERE ${where.join(' AND ')} ORDER BY ${SORT_SQL[sort]}`;
  if (pagingInSql && options.limit != null) {
    sql += ' LIMIT ?';
    args.push(options.limit);
    if (options.offset != null) {
      sql += ' OFFSET ?';
      args.push(options.offset);
    }
  }

  const rows = await db.getAllAsync<ItemRow>(sql, ...args);
  let views = rows.map((r) => toItemView(r, on));

  if (!pagingInSql) {
    views.sort(compareByName);
    if (options.limit != null) {
      const start = options.offset ?? 0;
      views = views.slice(start, start + options.limit);
    }
  }

  return views;
}

export async function getItemView(id: string): Promise<ItemView | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<ItemRow>(`${SELECT_VIEW} WHERE i.id = ?`, id);
  return row ? toItemView(row, today()) : null;
}

export async function getRawItem(id: string): Promise<Item | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<ItemRow>(`${SELECT_VIEW} WHERE i.id = ?`, id);
  return row ? toItem(row) : null;
}

/* ------------------------------------------------------------ 写入 */

export async function createItem(draft: ItemDraft): Promise<string> {
  const db = await getDatabase();
  const id = draft.id ?? (await import('../id')).uuid();
  const now = Date.now();

  await db.runAsync(
    `INSERT INTO items
      (id, name, category_id, location_id, purchase_date, price, expire_date,
       brand, model, tags, note, sort_order, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id,
    draft.name.trim(),
    draft.categoryId,
    draft.locationId,
    draft.purchaseDate,
    draft.price,
    draft.expireDate,
    draft.brand,
    draft.model,
    JSON.stringify(draft.tags ?? []),
    draft.note,
    draft.sortOrder,
    now,
    now,
  );

  return id;
}

/** 部分更新；自动刷新 updated_at */
export async function updateItem(id: string, patch: Partial<ItemDraft>): Promise<void> {
  const db = await getDatabase();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    args.push(value);
  };

  if (patch.name !== undefined) push('name', patch.name.trim());
  if (patch.categoryId !== undefined) push('category_id', patch.categoryId);
  if (patch.locationId !== undefined) push('location_id', patch.locationId);
  if (patch.purchaseDate !== undefined) push('purchase_date', patch.purchaseDate);
  if (patch.price !== undefined) push('price', patch.price);
  if (patch.expireDate !== undefined) push('expire_date', patch.expireDate);
  if (patch.brand !== undefined) push('brand', patch.brand);
  if (patch.model !== undefined) push('model', patch.model);
  if (patch.tags !== undefined) push('tags', JSON.stringify(patch.tags));
  if (patch.note !== undefined) push('note', patch.note);
  if (patch.sortOrder !== undefined) push('sort_order', patch.sortOrder);

  if (sets.length === 0) return;

  push('updated_at', Date.now());
  args.push(id);

  await db.runAsync(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, ...args);
}

/** 批量补分类（补偿机制：低摩擦录入后的批量整理） */
export async function assignCategory(itemIds: string[], categoryId: string | null): Promise<void> {
  if (itemIds.length === 0) return;
  const db = await getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    for (const id of itemIds) {
      await db.runAsync('UPDATE items SET category_id = ?, updated_at = ? WHERE id = ?', categoryId, now, id);
    }
  });
}

/* ------------------------------------------------------------ 软删除 / 回收站 */

export async function softDeleteItem(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?', Date.now(), Date.now(), id);
}

export async function restoreItem(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE items SET deleted_at = NULL, updated_at = ? WHERE id = ?', Date.now(), id);
}

/**
 * 彻底删除。返回被删除的照片文件相对路径，
 * 由上层负责清理磁盘文件（DB 与文件系统不能同事务）。
 */
export async function purgeItem(id: string): Promise<string[]> {
  const db = await getDatabase();
  const files = await db.getAllAsync<{ file_path: string; thumb_path: string }>(
    'SELECT file_path, thumb_path FROM photos WHERE item_id = ?',
    id,
  );

  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM photos WHERE item_id = ?', id);
    await db.runAsync('DELETE FROM items WHERE id = ?', id);
  });

  return files.flatMap((f) => [f.file_path, f.thumb_path]).filter(Boolean);
}

export async function listTrash(): Promise<ItemView[]> {
  const db = await getDatabase();
  const on = today();
  const rows = await db.getAllAsync<ItemRow>(
    `${SELECT_VIEW} WHERE i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC`,
  );
  return rows.map((r) => toItemView(r, on));
}

/** 清空回收站，返回待清理的文件路径 */
export async function emptyTrash(): Promise<string[]> {
  const db = await getDatabase();
  const files = await db.getAllAsync<{ file_path: string; thumb_path: string }>(
    'SELECT file_path, thumb_path FROM photos WHERE item_id IN (SELECT id FROM items WHERE deleted_at IS NOT NULL)',
  );

  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM photos WHERE item_id IN (SELECT id FROM items WHERE deleted_at IS NOT NULL)');
    await db.runAsync('DELETE FROM items WHERE deleted_at IS NOT NULL');
  });

  return files.flatMap((f) => [f.file_path, f.thumb_path]).filter(Boolean);
}

/* ------------------------------------------------------------ 统计 */

export async function getStats(): Promise<ItemStats> {
  const db = await getDatabase();
  const on = today();

  const totalRow = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL',
  );
  const valueRow = await db.getFirstAsync<{ s: number | null }>(
    'SELECT SUM(price) AS s FROM items WHERE deleted_at IS NULL AND price IS NOT NULL',
  );
  const expiringRow = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM items
     WHERE deleted_at IS NULL
       AND expire_date IS NOT NULL AND expire_date <> ''
       AND julianday(expire_date) - julianday(?) <= 30`,
    on,
  );
  // 两个互斥分组。fineCount 用总数减出来，不再查第三遍 ——
  // 少一次查询，也天然保证「三格合计等于总数」
  const groupRow = await db.getFirstAsync<{ overdue: number | null; soon: number | null }>(
    `SELECT
       SUM(CASE WHEN julianday(expire_date) - julianday(?) < 0 THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN julianday(expire_date) - julianday(?) >= 0
                 AND julianday(expire_date) - julianday(?) <= 30 THEN 1 ELSE 0 END) AS soon
     FROM items
     WHERE deleted_at IS NULL
       AND expire_date IS NOT NULL AND expire_date <> ''`,
    on,
    on,
    on,
  );

  const total = totalRow?.c ?? 0;
  const overdueCount = groupRow?.overdue ?? 0;
  const soonCount = groupRow?.soon ?? 0;

  return {
    total,
    totalValue: valueRow?.s ?? 0,
    expiringCount: expiringRow?.c ?? 0,
    soonCount,
    overdueCount,
    fineCount: Math.max(0, total - soonCount - overdueCount),
  };
}

/* ------------------------------------------------------------ 到期清单 */

/** 按严重程度分三组：已过期 / 30 天内 / 更远 */
export async function listExpiring(): Promise<ExpiringGroup[]> {
  const db = await getDatabase();
  const on = today();
  const rows = await db.getAllAsync<ItemRow>(
    `${SELECT_VIEW}
     WHERE i.deleted_at IS NULL AND i.expire_date IS NOT NULL AND i.expire_date <> ''
     ORDER BY i.expire_date ASC`,
  );

  const views = rows.map((r) => toItemView(r, on));

  return [
    { key: 'overdue', title: '已过期', items: views.filter((v) => v.expiry === 'overdue') },
    { key: 'soon', title: '30 天内到期', items: views.filter((v) => v.expiry === 'soon') },
    { key: 'later', title: '更远', items: views.filter((v) => v.expiry === 'fine') },
  ];
}

/** 最近录入的 N 件，用于「我的」页与空状态引导 */
export async function listRecent(limit = 5): Promise<ItemView[]> {
  return listItems({ limit });
}

/** 物品总数（含回收站），备份包用 */
export async function countAll(): Promise<number> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM items');
  return row?.c ?? 0;
}

/** 导出用：一次性取出全部字段（含软删除） */
export async function listAllForExport(): Promise<Item[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<ItemRow>(`${SELECT_VIEW} ORDER BY i.created_at ASC`);
  return rows.map(toItem);
}

/** 导入用：按 UUID 判断是否已存在 */
export async function existingIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = await getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM items WHERE id IN (${placeholders})`,
    ...ids,
  );
  return new Set(rows.map((r) => r.id));
}

/** 导入用：原样写回记录（保留 UUID 与全部时间戳） */
export async function insertRaw(item: Item): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT OR REPLACE INTO items
      (id, name, category_id, location_id, purchase_date, price, expire_date,
       brand, model, tags, note, sort_order, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    item.id,
    item.name,
    item.categoryId,
    item.locationId,
    item.purchaseDate,
    item.price,
    item.expireDate,
    item.brand,
    item.model,
    JSON.stringify(item.tags ?? []),
    item.note,
    // 老备份包里没有这个字段，缺省补 null
    item.sortOrder ?? null,
    item.createdAt,
    item.updatedAt,
    item.deletedAt,
  );
}

export type { Database };
