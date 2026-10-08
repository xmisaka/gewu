/**
 * 格物 · 物品仓储
 *
 * 唯一允许拼装 ItemView 的地方：列表、详情、搜索、统计、提醒全部走这里，
 * 保证派生指标与到期状态在所有页面的口径完全一致。
 */

import { dailyCost, expiryState, holdingDays, today } from '../date';
import { isStockEnabled, LOW_STOCK_THRESHOLD, nextQuantity, normalizeQuantity, stockState } from '../stock';
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
  quantity: number | null;
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

/**
 * 列表查询的统一 SELECT 前缀；`_WHERE_` 由调用方替换。
 *
 * 两条硬约束写在这里：
 *  1. **列名全部显式**，不用 `i.*` —— 迁移新增的列会排在表末尾，
 *     老库与新库的列序不同，显式列出才不会因为列序差异读错值。
 *  2. 照片信息走**一次 GROUP BY 聚合**，而不是每行两个相关子查询。
 *     旧的写法每行要执行 2 次子查询，1000 件物品就是 2000 次；
 *     现在整个查询只扫一遍 photos 表。
 *
 * cover_thumb 取的是 sort_order 最小的那张的 thumb_path。
 * 这里依赖 SQLite 的一条明确保证：查询中**只有一个 min()/max() 聚合**时，
 * 所有裸列都会取自那个极值所在的行（COUNT 不属于 min/max，不干扰）。
 * 注意 sort_order 相同时取哪一行未定义 —— 与旧写法 `ORDER BY sort_order LIMIT 1`
 * 的模糊程度一致，没有变差。
 */
const SELECT_VIEW = `
SELECT
  i.id, i.name, i.category_id, i.location_id, i.purchase_date, i.price,
  i.expire_date, i.brand, i.model, i.quantity, i.tags, i.note, i.sort_order,
  i.created_at, i.updated_at, i.deleted_at,
  c.name  AS category_name,
  l.name  AS location_name,
  pl.name AS cabinet_name,
  COALESCE(ph.photo_count, 0) AS photo_count,
  ph.cover_thumb              AS cover_thumb
FROM items i
LEFT JOIN categories c  ON c.id = i.category_id
LEFT JOIN locations  l  ON l.id = i.location_id
LEFT JOIN locations  pl ON pl.id = l.parent_id
LEFT JOIN (
  SELECT item_id,
         COUNT(*)        AS photo_count,
         MIN(sort_order) AS min_sort_order,
         thumb_path      AS cover_thumb
  FROM photos
  GROUP BY item_id
) ph ON ph.item_id = i.id
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
    quantity: row.quantity ?? null,
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
    stock: stockState(base.quantity),
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
    // 除了物品自身字段，还要能按**分类名**和**位置名**搜到：
    // 用户记的常常是归属而不是物品名 —— 搜「药品」该搜出归在药品类里的东西，
    // 搜「书房」该搜出书房那个柜子（及其格位）里的东西。
    where.push(`(
      i.name LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR i.note LIKE ? OR i.tags LIKE ?
      OR EXISTS (SELECT 1 FROM categories c WHERE c.id = i.category_id AND c.name LIKE ?)
      OR EXISTS (
        SELECT 1 FROM locations l
        LEFT JOIN locations p ON p.id = l.parent_id
        WHERE l.id = i.location_id AND (l.name LIKE ? OR p.name LIKE ?)
      )
    )`);
    args.push(q, q, q, q, q, q, q, q);
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
       brand, model, quantity, tags, note, sort_order, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id,
    draft.name.trim(),
    draft.categoryId,
    draft.locationId,
    draft.purchaseDate,
    draft.price,
    draft.expireDate,
    draft.brand,
    draft.model,
    draft.quantity,
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
  if (patch.quantity !== undefined) push('quantity', patch.quantity);
  if (patch.tags !== undefined) push('tags', JSON.stringify(patch.tags));
  if (patch.note !== undefined) push('note', patch.note);
  if (patch.sortOrder !== undefined) push('sort_order', patch.sortOrder);

  if (sets.length === 0) return;

  push('updated_at', Date.now());
  args.push(id);

  await db.runAsync(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, ...args);
}

/* ------------------------------------------------------------ 库存 */

/**
 * 加减若干件。返回**变动之前**的数量，供撤销条回滚；没动成则返回 `null`。
 *
 * ★ 返回 0 是合法结果（原本就是 0 件），所以调用方必须判 `!== null` 而不是真值判断 ——
 *   写成 `if (before)` 会让「用完了的物品点补一件」这条路径悄悄走丢。
 *
 * ★ 先读后写，绝不在 SQL 里写 `quantity = quantity + ?`：
 *   SQLite 的单参数 `max()` 是**聚合函数**、双参数才是标量函数，
 *   写成 `max(quantity - 1, 0)` 少了一个括号不会报错，语义却完全变了。
 *   夹取放在纯函数 `nextQuantity()` 里（有单测兜着），这里只管读写。
 *
 * ★ 刻意**不动 `updated_at`**：与 setManualOrder 同一个判断 ——
 *   「用掉一瓶酱油」不是内容编辑，动它会让首页「最近变动」排序被打乱。
 */
export async function adjustQuantity(id: string, delta: number): Promise<number | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ quantity: number | null }>(
    'SELECT quantity FROM items WHERE id = ?',
    id,
  );
  if (!row || !isStockEnabled(row.quantity)) return null;

  const before = row.quantity as number;
  const after = nextQuantity(before, delta) as number;
  // 0 再减还是 0：写一次库换回同样的值没有意义，直接回旧值让调用方照样能弹撤销条
  if (after === before) return before;

  await db.runAsync('UPDATE items SET quantity = ? WHERE id = ?', after, id);
  return before;
}

/**
 * 直接设定剩余件数（面板里「改成别的数」、详情页库存卡的编辑入口都走它）。
 *
 * 传 `null` 是**退订**：退回「单件物品」，列表行的胶囊随之消失。
 * 同样不动 `updated_at`，理由见 adjustQuantity。
 */
export async function setQuantity(id: string, value: number | null): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE items SET quantity = ? WHERE id = ?',
    value === null ? null : normalizeQuantity(value),
    id,
  );
}

/**
 * 「该补货了」：启用了库存、且余量已到阈值线（含 0）。
 *
 * 阈值不在 SQL 里另写一遍 `<= 1`，而是引用 `LOW_STOCK_THRESHOLD` ——
 * 将来把「只剩最后一件」放宽成两件时只改一处，界面与查询不会各说各话。
 *
 * 排序：用完了的排最前（最急），然后余量少的靠前，同档按最近变动。
 * ★ 刻意不走 SORT_SQL：那五种是给用户在首页自选的展示偏好，
 *   这里要的是一个固定的紧急度顺序，混进去会让排序切换器的语义变模糊。
 */
export async function listLowStock(): Promise<ItemView[]> {
  const db = await getDatabase();
  const on = today();
  const rows = await db.getAllAsync<ItemRow>(
    `${SELECT_VIEW}
     WHERE i.deleted_at IS NULL
       AND i.quantity IS NOT NULL
       AND i.quantity <= ?
     ORDER BY i.quantity ASC, i.updated_at DESC`,
    LOW_STOCK_THRESHOLD,
  );
  return rows.map((r) => toItemView(r, on));
}

/* ------------------------------------------------------------ 批量整理 */

/**
 * 批量改单个外键列。列名只来自下面这张白名单表，
 * 不接受外部字符串，因此可以安全拼进 SQL。
 */
const BULK_COLUMN = {
  category: 'category_id',
  location: 'location_id',
} as const;

async function updateManyItems(
  itemIds: string[],
  column: (typeof BULK_COLUMN)[keyof typeof BULK_COLUMN],
  value: string | null,
): Promise<void> {
  if (itemIds.length === 0) return;
  const db = await getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    for (const id of itemIds) {
      await db.runAsync(`UPDATE items SET ${column} = ?, updated_at = ? WHERE id = ?`, value, now, id);
    }
  });
}

/** 批量补分类（补偿机制：低摩擦录入后的批量整理） */
export function assignCategory(itemIds: string[], categoryId: string | null): Promise<void> {
  return updateManyItems(itemIds, BULK_COLUMN.category, categoryId);
}

/**
 * 批量改位置（补偿机制的第二块）。
 * 搬家、换柜子、整理时这件事必须能一次改完 ——
 * 否则用户会放弃维护位置，而位置是「找得到」的前提。
 */
export function assignLocation(itemIds: string[], locationId: string | null): Promise<void> {
  return updateManyItems(itemIds, BULK_COLUMN.location, locationId);
}

/** 批量移入回收站。走软删除，照片与字段都还在，可随时恢复。 */
export async function softDeleteMany(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const db = await getDatabase();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    for (const id of itemIds) {
      await db.runAsync('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, id);
    }
  });
}

/* ------------------------------------------------------------ 手动排序 */

/** 手动排序步长：留出空隙，将来想往两条之间插一条不必整段重排 */
const MANUAL_ORDER_STEP = 10;

/**
 * 按传入顺序重写手动排序值（序号 × 10）。
 *
 * 只在首页的「调整顺序」模式里调用，那时列表已被强制清空搜索与分类筛选 ——
 * 这一点是必须的：若只重排可见的那一段，它的序号会与隐藏项交错，顺序就乱了。
 *
 * 刻意**不动 updated_at**：调顺序是展示偏好，不是内容变更。
 * 改了会让那些物品在「最近变动」排序里集体跳到最前，那是很突兀的副作用。
 */
export async function setManualOrder(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.runAsync(
        'UPDATE items SET sort_order = ? WHERE id = ?',
        i * MANUAL_ORDER_STEP,
        orderedIds[i],
      );
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
  /* 「需要关注」= 快到期 ∪ 该补货。和上面那条分开查，不是重复劳动 ——
     expiringCount 是**到期口径**（首页统计卡「即将到期」用它，标签就得是这一个），
     attentionCount 是**待办口径**（提醒页顶部那句、标签栏角标用它）。
     ★ 一条 SQL 里用 OR 写，天然去重：一件既过期又只剩 1 的东西只算一件 ——
       分两次查再相加就会多出来，而用户会拿这个数去对提醒页里的行数。 */
  const attentionRow = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM items
     WHERE deleted_at IS NULL
       AND (
         (expire_date IS NOT NULL AND expire_date <> ''
          AND julianday(expire_date) - julianday(?) <= 30)
         OR (quantity IS NOT NULL AND quantity <= ?)
       )`,
    on,
    LOW_STOCK_THRESHOLD,
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
    attentionCount: attentionRow?.c ?? 0,
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

/** 导入用：一次性取出全部字段（含软删除） */
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

/**
 * 导入用：原样写回记录（保留 UUID 与全部时间戳）。
 *
 * **不要用 `INSERT OR REPLACE`**：REPLACE 的语义是先 DELETE 再 INSERT，
 * 而 `photos.item_id` 上挂着 `ON DELETE CASCADE`（且 `PRAGMA foreign_keys = ON`），
 * 于是对一个已存在的 id 触发 REPLACE 时，它名下的照片记录会被**级联删掉**。
 * 现有导入逻辑用 `existingIds` 前置跳过，常规路径碰不到；
 * 但只要备份包内出现重复 id，就会静默丢照片。用显式 upsert 把语义钉死。
 */
export async function insertRaw(item: Item): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO items
      (id, name, category_id, location_id, purchase_date, price, expire_date,
       brand, model, quantity, tags, note, sort_order, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name          = excluded.name,
       category_id   = excluded.category_id,
       location_id   = excluded.location_id,
       purchase_date = excluded.purchase_date,
       price         = excluded.price,
       expire_date   = excluded.expire_date,
       brand         = excluded.brand,
       model         = excluded.model,
       quantity      = excluded.quantity,
       tags          = excluded.tags,
       note          = excluded.note,
       sort_order    = excluded.sort_order,
       created_at    = excluded.created_at,
       updated_at    = excluded.updated_at,
       deleted_at    = excluded.deleted_at`,
    item.id,
    item.name,
    item.categoryId,
    item.locationId,
    item.purchaseDate,
    item.price,
    item.expireDate,
    item.brand,
    item.model,
    // 老备份包里没有这个字段，缺省补 null（与 sortOrder 当年加列时的处理一致）
    item.quantity ?? null,
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
