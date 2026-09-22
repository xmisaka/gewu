/**
 * 格物 · 图片仓储
 *
 * 只存沙盒内的相对路径；文件的写入与删除由 photos/pipeline.ts 负责。
 */

import { uuid } from '../id';
import type { Photo } from '../types';
import { getDatabase } from './index';

interface PhotoRow {
  id: string;
  item_id: string;
  file_path: string;
  thumb_path: string;
  sort_order: number;
}

function toPhoto(row: PhotoRow): Photo {
  return {
    id: row.id,
    itemId: row.item_id,
    filePath: row.file_path,
    thumbPath: row.thumb_path,
    sortOrder: row.sort_order,
  };
}

export async function listPhotos(itemId: string): Promise<Photo[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<PhotoRow>(
    'SELECT * FROM photos WHERE item_id = ? ORDER BY sort_order ASC',
    itemId,
  );
  return rows.map(toPhoto);
}

export async function addPhoto(itemId: string, filePath: string, thumbPath: string): Promise<string> {
  const db = await getDatabase();
  const id = uuid();
  const row = await db.getFirstAsync<{ m: number | null }>(
    'SELECT MAX(sort_order) AS m FROM photos WHERE item_id = ?',
    itemId,
  );
  await db.runAsync(
    'INSERT INTO photos (id, item_id, file_path, thumb_path, sort_order) VALUES (?, ?, ?, ?, ?)',
    id,
    itemId,
    filePath,
    thumbPath,
    (row?.m ?? -1) + 1,
  );
  return id;
}

/** 删除一条图片记录，返回待清理的两个文件路径 */
export async function removePhoto(photoId: string): Promise<string[]> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<PhotoRow>('SELECT * FROM photos WHERE id = ?', photoId);
  await db.runAsync('DELETE FROM photos WHERE id = ?', photoId);
  return row ? [row.file_path, row.thumb_path].filter(Boolean) : [];
}

/** 按传入顺序重排 */
export async function reorderPhotos(photoIds: string[]): Promise<void> {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < photoIds.length; i++) {
      await db.runAsync('UPDATE photos SET sort_order = ? WHERE id = ?', i, photoIds[i]);
    }
  });
}

/**
 * 把某张照片提到最前，让它成为列表里显示的封面。
 *
 * 为什么需要它：addPhoto 一律追加到末尾（sort_order = MAX+1），
 * 而列表封面取的是 sort_order 最小的那张。于是「给已有物品换一张封面」
 * 这条路径下，新图会排到最后，界面上看不出任何变化 —— 用户以为换了，其实没换。
 */
export async function promotePhoto(itemId: string, filePath: string): Promise<void> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ id: string; file_path: string }>(
    'SELECT id, file_path FROM photos WHERE item_id = ? ORDER BY sort_order ASC, rowid ASC',
    itemId,
  );
  const target = rows.find((r) => r.file_path === filePath);
  if (!target) return;
  const rest = rows.filter((r) => r.id !== target.id).map((r) => r.id);
  await reorderPhotos([target.id, ...rest]);
}

/* ------------------------------------------------------------ 相册视图 */

export interface AlbumPhoto {
  id: string;
  itemId: string;
  itemName: string;
  filePath: string;
  thumbPath: string;
  /** 拍摄/录入时间，用于分组 */
  takenAt: number;
  categoryName: string | null;
  locationName: string | null;
}

/** 全部在库物品的照片，按时间倒序；相册页按此分组 */
export async function listAlbumPhotos(): Promise<AlbumPhoto[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string;
    item_id: string;
    file_path: string;
    thumb_path: string;
    created_at: number;
    name: string;
    category_name: string | null;
    location_name: string | null;
  }>(
    `SELECT p.id, p.item_id, p.file_path, p.thumb_path,
            i.created_at, i.name,
            c.name AS category_name, l.name AS location_name
     FROM photos p
     JOIN items i      ON i.id = p.item_id
     LEFT JOIN categories c ON c.id = i.category_id
     LEFT JOIN locations  l ON l.id = i.location_id
     WHERE i.deleted_at IS NULL
     ORDER BY i.updated_at DESC, p.sort_order ASC`,
  );

  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    itemName: r.name,
    filePath: r.file_path,
    thumbPath: r.thumb_path,
    takenAt: r.created_at,
    categoryName: r.category_name,
    locationName: r.location_name,
  }));
}

/** 全部照片记录，备份包用 */
export async function listAllPhotos(): Promise<Photo[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<PhotoRow>('SELECT * FROM photos ORDER BY item_id, sort_order');
  return rows.map(toPhoto);
}

/** 导入用：原样写回 */
export async function insertRawPhoto(photo: Photo): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'INSERT OR REPLACE INTO photos (id, item_id, file_path, thumb_path, sort_order) VALUES (?, ?, ?, ?, ?)',
    photo.id,
    photo.itemId,
    photo.filePath,
    photo.thumbPath,
    photo.sortOrder,
  );
}

/** 孤儿照片（所属物品已不存在），用于自检 */
export async function listOrphanPhotos(): Promise<Photo[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<PhotoRow>(
    'SELECT * FROM photos WHERE item_id NOT IN (SELECT id FROM items)',
  );
  return rows.map(toPhoto);
}

export async function countPhotos(): Promise<number> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM photos');
  return row?.c ?? 0;
}
