/**
 * 格物 · 分类仓储
 *
 * 内置分类不可删除（builtin = 1），保证猜词结果总有实体可挂。
 * 删除自定义分类时，引用它的物品置为「未分类」而非级联删除。
 */

import { uuid } from '../id';
import type { Category } from '../types';
import { getDatabase } from './index';

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  default_expire_months: number | null;
  sort_order: number;
  builtin: number;
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    defaultExpireMonths: row.default_expire_months,
    sortOrder: row.sort_order,
    builtin: row.builtin === 1,
  };
}

export interface CategoryWithCount extends Category {
  itemCount: number;
}

/** 全部分类，带在库物品数；按 sort_order 升序 */
export async function listCategories(): Promise<CategoryWithCount[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<CategoryRow & { item_count: number }>(
    `SELECT c.*,
       (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.deleted_at IS NULL) AS item_count
     FROM categories c
     ORDER BY c.sort_order ASC, c.name ASC`,
  );
  return rows.map((r) => ({ ...toCategory(r), itemCount: r.item_count ?? 0 }));
}

export async function getCategoryByName(name: string): Promise<Category | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<CategoryRow>('SELECT * FROM categories WHERE name = ?', name);
  return row ? toCategory(row) : null;
}

export async function getCategory(id: string): Promise<Category | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<CategoryRow>('SELECT * FROM categories WHERE id = ?', id);
  return row ? toCategory(row) : null;
}

/** 取下一次序权重，追加到末尾 */
async function nextSortOrder(): Promise<number> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ m: number | null }>(
    'SELECT MAX(sort_order) AS m FROM categories',
  );
  return (row?.m ?? -1) + 1;
}

export async function createCategory(name: string, defaultExpireMonths: number | null = null): Promise<string> {
  const db = await getDatabase();
  const id = uuid();
  await db.runAsync(
    'INSERT INTO categories (id, name, parent_id, default_expire_months, sort_order, builtin) VALUES (?, ?, NULL, ?, ?, 0)',
    id,
    name.trim(),
    defaultExpireMonths,
    await nextSortOrder(),
  );
  return id;
}

export async function renameCategory(id: string, name: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE categories SET name = ? WHERE id = ?', name.trim(), id);
}

/**
 * 删除分类。内置分类直接拒绝。
 * 引用该分类的物品回到「未分类」（category_id = NULL），不删物品。
 */
export async function deleteCategory(id: string): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDatabase();
  const cat = await getCategory(id);
  if (!cat) return { ok: false, reason: '分类不存在' };
  if (cat.builtin) return { ok: false, reason: '内置分类不可删除' };

  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE items SET category_id = NULL WHERE category_id = ?', id);
    await db.runAsync('DELETE FROM categories WHERE id = ?', id);
  });
  return { ok: true };
}

/* ------------------------------------------------------------ 备份还原 */

/** 导入用：原样写回分类，保留 UUID 与内置标记 */
export async function insertRawCategory(category: Category): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT OR REPLACE INTO categories (id, name, parent_id, default_expire_months, sort_order, builtin)
     VALUES (?, ?, ?, ?, ?, ?)`,
    category.id,
    category.name,
    category.parentId,
    category.defaultExpireMonths,
    category.sortOrder,
    category.builtin ? 1 : 0,
  );
}

/** 导入用：一次性取出全部分类（含内置） */
export async function listAllCategories(): Promise<Category[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<CategoryRow>('SELECT * FROM categories ORDER BY sort_order ASC');
  return rows.map(toCategory);
}
