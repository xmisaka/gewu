/**
 * 格物 · 位置仓储
 *
 * 两级结构：柜子（parent_id 为空）→ 格位。
 * 删除柜子会一并删除其格位，并把物品的 location_id 置空（物品本身保留）。
 */

import { uuid } from '../id';
import type { CabinetView, StorageLocation } from '../types';
import { getDatabase } from './index';

interface LocationRow {
  id: string;
  name: string;
  parent_id: string | null;
  note: string | null;
  sort_order: number;
  builtin: number;
}

function toLocation(row: LocationRow): StorageLocation {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    note: row.note,
    sortOrder: row.sort_order,
    builtin: row.builtin === 1,
  };
}

const LOCATION_COLUMNS = 'id, name, parent_id, note, sort_order, builtin';

/** 扁平列表，用于选择器；柜子在前、其格位紧随 */
export async function listLocations(): Promise<StorageLocation[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<LocationRow>(
    `SELECT ${LOCATION_COLUMNS} FROM locations
     ORDER BY (parent_id IS NOT NULL) ASC, sort_order ASC, name ASC`,
  );
  return rows.map(toLocation);
}

export async function listCabinets(): Promise<StorageLocation[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<LocationRow>(
    `SELECT ${LOCATION_COLUMNS} FROM locations WHERE parent_id IS NULL ORDER BY sort_order ASC, name ASC`,
  );
  return rows.map(toLocation);
}

export async function listSlots(cabinetId: string): Promise<StorageLocation[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<LocationRow>(
    `SELECT ${LOCATION_COLUMNS} FROM locations WHERE parent_id = ? ORDER BY sort_order ASC, name ASC`,
    cabinetId,
  );
  return rows.map(toLocation);
}

export async function getLocation(id: string): Promise<StorageLocation | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<LocationRow>(
    `SELECT ${LOCATION_COLUMNS} FROM locations WHERE id = ?`,
    id,
  );
  return row ? toLocation(row) : null;
}

/* ------------------------------------------------------------ 柜子视图 */

/** 全部柜子的聚合视图：格位占用、物品计数、首图缩略图 */
export async function listCabinetViews(): Promise<CabinetView[]> {
  const db = await getDatabase();
  const cabinets = await listCabinets();
  const result: CabinetView[] = [];

  for (const cabinet of cabinets) {
    const slots = await db.getAllAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM locations WHERE parent_id = ? ORDER BY sort_order ASC, name ASC`,
      cabinet.id,
    );

    const slotViews: CabinetView['slots'] = [];
    for (const slot of slots) {
      const row = await db.getFirstAsync<{ c: number }>(
        'SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL AND location_id = ?',
        slot.id,
      );
      const thumbs = await db.getAllAsync<{ thumb_path: string }>(
        `SELECT p.thumb_path FROM photos p
         JOIN items i ON i.id = p.item_id
         WHERE i.deleted_at IS NULL AND i.location_id = ?
         ORDER BY i.updated_at DESC, p.sort_order ASC
         LIMIT 3`,
        slot.id,
      );
      slotViews.push({
        slot: toLocation(slot),
        itemCount: row?.c ?? 0,
        thumbs: thumbs.map((t) => t.thumb_path),
      });
    }

    const looseRow = await db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL AND location_id = ?',
      cabinet.id,
    );

    result.push({
      ...cabinet,
      looseCount: looseRow?.c ?? 0,
      slots: slotViews,
      totalCount: (looseRow?.c ?? 0) + slotViews.reduce((sum, s) => sum + s.itemCount, 0),
      occupiedSlots: slotViews.filter((s) => s.itemCount > 0).length,
    });
  }

  return result;
}

export async function getCabinetView(cabinetId: string): Promise<CabinetView | null> {
  const all = await listCabinetViews();
  return all.find((c) => c.id === cabinetId) ?? null;
}

/* ------------------------------------------------------------ 写入 */

async function nextSortOrder(parentId: string | null): Promise<number> {
  const db = await getDatabase();
  const row = parentId
    ? await db.getFirstAsync<{ m: number | null }>(
        'SELECT MAX(sort_order) AS m FROM locations WHERE parent_id = ?',
        parentId,
      )
    : await db.getFirstAsync<{ m: number | null }>(
        'SELECT MAX(sort_order) AS m FROM locations WHERE parent_id IS NULL',
      );
  return (row?.m ?? -1) + 1;
}

export async function createCabinet(name: string, note: string | null = null): Promise<string> {
  const db = await getDatabase();
  const id = uuid();
  await db.runAsync(
    'INSERT INTO locations (id, name, parent_id, note, sort_order, builtin) VALUES (?, ?, NULL, ?, ?, 0)',
    id,
    name.trim(),
    note,
    await nextSortOrder(null),
  );
  return id;
}

export async function createSlot(cabinetId: string, name: string): Promise<string> {
  const db = await getDatabase();
  const id = uuid();
  await db.runAsync(
    'INSERT INTO locations (id, name, parent_id, note, sort_order, builtin) VALUES (?, ?, ?, NULL, ?, 0)',
    id,
    name.trim(),
    cabinetId,
    await nextSortOrder(cabinetId),
  );
  return id;
}

export async function renameLocation(id: string, name: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE locations SET name = ? WHERE id = ?', name.trim(), id);
}

export async function updateLocationNote(id: string, note: string | null): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE locations SET note = ? WHERE id = ?', note, id);
}

/** 删除位置：物品的 location_id 置空，物品保留 */
export async function deleteLocation(id: string): Promise<void> {
  const db = await getDatabase();
  const children = await db.getAllAsync<{ id: string }>(
    'SELECT id FROM locations WHERE parent_id = ?',
    id,
  );
  const ids = [id, ...children.map((c) => c.id)];
  const placeholders = ids.map(() => '?').join(',');

  await db.withTransactionAsync(async () => {
    await db.runAsync(`UPDATE items SET location_id = NULL WHERE location_id IN (${placeholders})`, ...ids);
    await db.runAsync(`DELETE FROM locations WHERE id IN (${placeholders})`, ...ids);
  });
}

/** 某位置下的物品数，用于删除前提示 */
export async function countItemsAt(locationId: string): Promise<number> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM items
     WHERE deleted_at IS NULL
       AND (location_id = ? OR location_id IN (SELECT id FROM locations WHERE parent_id = ?))`,
    locationId,
    locationId,
  );
  return row?.c ?? 0;
}

/** 最近一次使用的位置，用于录入页默认值 */
export async function lastUsedLocationId(): Promise<string | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ location_id: string | null }>(
    'SELECT location_id FROM items WHERE deleted_at IS NULL AND location_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
  );
  return row?.location_id ?? null;
}

/* ------------------------------------------------------------ 备份还原 */

/**
 * 导入用：原样写回位置。
 * 用显式 upsert 而非 `INSERT OR REPLACE`（理由见 items.ts 的 insertRaw）。
 */
export async function insertRawLocation(location: StorageLocation): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO locations (id, name, parent_id, note, sort_order, builtin)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name       = excluded.name,
       parent_id  = excluded.parent_id,
       note       = excluded.note,
       sort_order = excluded.sort_order,
       builtin    = excluded.builtin`,
    location.id,
    location.name,
    location.parentId,
    location.note,
    location.sortOrder,
    location.builtin ? 1 : 0,
  );
}

/** 导入用：按 UUID 查已存在的位置 */
export async function existingLocationIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = await getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM locations WHERE id IN (${placeholders})`,
    ...ids,
  );
  return new Set(rows.map((r) => r.id));
}

/** 导入用：全部位置 */
export async function listAllLocations(): Promise<StorageLocation[]> {
  return listLocations();
}
