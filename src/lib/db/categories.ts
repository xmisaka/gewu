/**
 * 格物 · 分类仓储
 *
 * 内置分类不可删除（builtin = 1），保证猜词结果总有实体可挂。
 * 删除自定义分类时，引用它的物品置为「未分类」而非级联删除。
 *
 * 名字是这一层的**业务主键**（不是 id）：猜词按名字找分类、列表按名字给人看，
 * 出现两个「药品」会让这两件事都失去确定性。所以新建与改名都强制判重，
 * 冲突时抛错而不是静默写入 —— 页面把这句话直接弹给用户就够了。
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

const CATEGORY_COLUMNS = 'id, name, parent_id, default_expire_months, sort_order, builtin';
/** 带表别名的同一组列，供需要 JOIN 的查询使用 */
const CATEGORY_COLUMNS_C = `${CATEGORY_COLUMNS.split(', ')
  .map((c) => `c.${c}`)
  .join(', ')}`;

/** 全部分类，带在库物品数；按 sort_order 升序 */
export async function listCategories(): Promise<CategoryWithCount[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<CategoryRow & { item_count: number }>(
    `SELECT ${CATEGORY_COLUMNS_C},
       (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.deleted_at IS NULL) AS item_count
     FROM categories c
     ORDER BY c.sort_order ASC, c.name ASC`,
  );
  return rows.map((r) => ({ ...toCategory(r), itemCount: r.item_count ?? 0 }));
}

/**
 * 按名字取分类，**忽略大小写**。
 *
 * NOCASE 只折叠 ASCII，中文不受影响 —— 但「USB」和「usb」这类才是真会撞的，
 * 所以判重走这条通道，而不是让用户自己发现有两个只差大小写的分类。
 */
export async function getCategoryByName(name: string): Promise<Category | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE name = ? COLLATE NOCASE`,
    name.trim(),
  );
  return row ? toCategory(row) : null;
}

export async function getCategory(id: string): Promise<Category | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = ?`,
    id,
  );
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

/** 分类名长度上限。首页筛选用的是 chip，再长会把那一行挤成两行 */
export const CATEGORY_NAME_MAX = 12;

/**
 * 校验并规整名字，返回可直接入库的值。
 * 只做「能不能存」的判断，不做任何写入 —— 建与改共用同一套规则。
 */
function normalizeName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error('分类名不能为空');
  if (name.length > CATEGORY_NAME_MAX) {
    throw new Error(`分类名最多 ${CATEGORY_NAME_MAX} 个字`);
  }
  return name;
}

/** 名字被占用则抛错。`exceptId` 用于改名时把自己排除在外 */
async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const clash = await getCategoryByName(name);
  if (clash && clash.id !== exceptId) throw new Error(`已经有「${clash.name}」了，换个名字`);
}

export async function createCategory(name: string, defaultExpireMonths: number | null = null): Promise<string> {
  const clean = normalizeName(name);
  await assertNameFree(clean);

  const db = await getDatabase();
  const id = uuid();
  await db.runAsync(
    'INSERT INTO categories (id, name, parent_id, default_expire_months, sort_order, builtin) VALUES (?, ?, NULL, ?, ?, 0)',
    id,
    clean,
    defaultExpireMonths,
    await nextSortOrder(),
  );
  return id;
}

/**
 * 改名 + 改默认保质期。内置分类也允许改。
 *
 * 允许改内置名的代价要说清楚：猜词词典（`suggest.ts` 的 BUILTIN_CATEGORIES）
 * 是按**原名**建的关键词索引，改名后这类不再自动猜中，用户得手动选一次。
 * 页面会把这句提示写在编辑区里。反过来若禁止改名，用户就只能忍受
 * 「数码」「五金」这种未必贴自己生活的词 —— 权衡下来，把选择权交回去更合理。
 */
export async function updateCategory(
  id: string,
  name: string,
  defaultExpireMonths: number | null,
): Promise<void> {
  const clean = normalizeName(name);
  await assertNameFree(clean, id);

  const db = await getDatabase();
  await db.runAsync(
    'UPDATE categories SET name = ?, default_expire_months = ? WHERE id = ?',
    clean,
    defaultExpireMonths,
    id,
  );
}

/**
 * 按传入顺序整体重写 sort_order。
 *
 * 用「整表重写」而不是「相邻两行交换」：交换要处理两行 sort_order 相等、
 * 或一方为 null 的边界，而页面手上本来就有完整列表，重写一遍既无歧义又只有一次事务。
 */
export async function applyCategoryOrder(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    let order = 0;
    for (const id of orderedIds) {
      await db.runAsync('UPDATE categories SET sort_order = ? WHERE id = ?', order, id);
      order += 1;
    }
  });
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

/**
 * 导入用：原样写回分类，保留 UUID 与内置标记。
 * 用显式 upsert 而非 `INSERT OR REPLACE`（理由见 items.ts 的 insertRaw）。
 */
export async function insertRawCategory(category: Category): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO categories (id, name, parent_id, default_expire_months, sort_order, builtin)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name                  = excluded.name,
       parent_id             = excluded.parent_id,
       default_expire_months = excluded.default_expire_months,
       sort_order            = excluded.sort_order,
       builtin               = excluded.builtin`,
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
  const rows = await db.getAllAsync<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM categories ORDER BY sort_order ASC`,
  );
  return rows.map(toCategory);
}
