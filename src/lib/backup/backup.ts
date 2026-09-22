/**
 * 格物 · 数据通道
 *
 * 两条通道各司其职（PRD 6.5）：
 *   备份包（.zip）—— 管恢复。结构化数据 JSON + 照片原文件，能完整还原。
 *   导出表（.csv）—— 管给人看。丢进 Excel/WPS 就能打开、筛选、打印。
 *
 * 纯本地单机存储是单点故障，所以备份必须做到「低成本、随手就能做」：
 * 一键生成 + 直接调系统分享面板（发到微信文件传输助手 / 存网盘都行）。
 *
 * 打包用 STORE 模式（level 0）而非 deflate：照片已是 JPEG，再压缩收益近零，
 * 却要多花几倍 CPU 与时间。
 */

import { DocumentPickerAsset } from 'expo-document-picker';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { formatDateCN } from '../date';
import { listAllCategories, insertRawCategory, type CategoryWithCount } from '../db/categories';
import { SCHEMA_VERSION } from '../db/schema';
import { getDatabase, readMeta, wipeBusinessData, writeMeta } from '../db';
import {
  existingIds,
  insertRaw,
  listAllForExport,
} from '../db/items';
import {
  existingLocationIds,
  insertRawLocation,
  listAllLocations,
} from '../db/locations';
import { insertRawPhoto, listAllPhotos } from '../db/photos';
import { ensureDirs, storageUsage } from '../photos/pipeline';
import type { Category, Item, Photo, StorageLocation } from '../types';

/** 备份包格式版本；与 app 版本无关，改了包结构才递增 */
export const BACKUP_FORMAT_VERSION = 1;
const CSV_BOM = '\uFEFF';

/* ------------------------------------------------------------ 类型 */

export interface BackupManifest {
  app: 'gewu';
  appName: string;
  formatVersion: number;
  schemaVersion: number;
  createdAt: number;
  counts: {
    items: number;
    categories: number;
    locations: number;
    photos: number;
  };
}

export interface BackupPayload {
  manifest: BackupManifest;
  categories: Category[];
  locations: StorageLocation[];
  items: Item[];
  photos: Photo[];
}

export interface BackupResult {
  fileName: string;
  uri: string;
  bytes: number;
  manifest: BackupManifest;
}

export type ImportStrategy = 'replace' | 'merge';

export interface ImportResult {
  canceled: boolean;
  error?: string;
  manifest?: BackupManifest;
  written?: {
    items: number;
    categories: number;
    locations: number;
    photos: number;
    photoFiles: number;
    skipped: number;
  };
}

/* ------------------------------------------------------------ 时间戳 */

function stamp(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------ 打包 */

async function collectPayload(): Promise<BackupPayload> {
  const [categories, locations, items, photos] = await Promise.all([
    listAllCategories(),
    listAllLocations(),
    listAllForExport(),
    listAllPhotos(),
  ]);

  const manifest: BackupManifest = {
    app: 'gewu',
    appName: '格物',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: Date.now(),
    counts: {
      items: items.length,
      categories: categories.length,
      locations: locations.length,
      photos: photos.length,
    },
  };

  return { manifest, categories, locations, items, photos };
}

/** 生成备份包文件，落在 cache 目录，返回值指向它 */
export async function createBackupFile(): Promise<BackupResult> {
  ensureDirs();
  const payload = await collectPayload();

  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(payload.manifest, null, 2)),
    'data/categories.json': strToU8(JSON.stringify(payload.categories, null, 2)),
    'data/locations.json': strToU8(JSON.stringify(payload.locations, null, 2)),
    'data/items.json': strToU8(JSON.stringify(payload.items, null, 2)),
    'data/photos.json': strToU8(JSON.stringify(payload.photos, null, 2)),
    // 人类可读的一份，方便不想解析 JSON 时直接用编辑器打开看
    'README.txt': strToU8(
      [
        '格物 · 数据备份包',
        '',
        `导出时间：${formatDateCN(new Date(payload.manifest.createdAt).toISOString().slice(0, 10))}`,
        `物品 ${payload.manifest.counts.items} 件 / 照片 ${payload.manifest.counts.photos} 张`,
        '',
        '目录说明：',
        '  manifest.json          备份元信息',
        '  data/items.json        物品数据',
        '  data/categories.json   分类',
        '  data/locations.json    柜子与格位',
        '  data/photos.json       照片索引',
        '  photos/ thumbs/        照片原图与缩略图',
        '',
        '恢复方式：在 App 的「我的 → 导入备份」中选择本文件。',
      ].join('\n'),
    ),
  };

  // 照片按相对路径原样存入，路径即还原目标，不需要额外映射表
  const allPaths = new Set<string>();
  for (const photo of payload.photos) {
    if (photo.filePath) allPaths.add(photo.filePath);
    if (photo.thumbPath) allPaths.add(photo.thumbPath);
  }
  for (const rel of allPaths) {
    try {
      const file = new File(Paths.document, rel);
      if (file.exists) entries[rel] = file.bytesSync();
    } catch {
      // 单个文件读失败不阻断整包导出
    }
  }

  // level 0 = STORE：只打包不压缩，JPEG 再压收益近零
  const zipped = zipSync(entries, { level: 0 });

  const fileName = `格物-备份-${stamp()}.zip`;
  const out = new File(Paths.cache, fileName);
  out.create({ overwrite: true, intermediates: true });
  out.write(zipped);

  return {
    fileName,
    uri: out.uri,
    bytes: zipped.byteLength,
    manifest: payload.manifest,
  };
}

/** 生成备份并立即调起系统分享面板 */
export async function shareBackup(): Promise<BackupResult> {
  const result = await createBackupFile();
  await markBackupDone();
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(result.uri, {
      mimeType: 'application/zip',
      dialogTitle: '保存或发送备份包',
      UTI: 'public.zip-archive',
    });
  }
  return result;
}

/* ------------------------------------------------------------ 上次备份时间 */

/**
 * 记在 meta 表，**不随备份包走**。
 *
 * 语义是「这台设备上做过没做」，不是「我的数据」——
 * 恢复到新手机后这个值从零开始，正好提醒用户"换机后先备份一次"。
 */
const META_LAST_BACKUP = 'backup.lastAt';

async function markBackupDone(): Promise<void> {
  try {
    const db = await getDatabase();
    await writeMeta(db, META_LAST_BACKUP, String(Date.now()));
  } catch {
    // 时间没记上不影响这次备份本身
  }
}

/** 距上次生成备份包过了多少天；从没备份过返回 null */
export async function daysSinceLastBackup(): Promise<number | null> {
  try {
    const db = await getDatabase();
    const raw = await readMeta(db, META_LAST_BACKUP);
    if (!raw) return null;
    const at = Number(raw);
    if (!Number.isFinite(at) || at <= 0) return null;
    return Math.max(0, Math.floor((Date.now() - at) / 86_400_000));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 导出 CSV */

function csvCell(value: string | number | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 导出为 CSV。用逗号分隔 + BOM 头，Excel 与 WPS 双击都能正确识别中文。
 * 不做 Excel 多 sheet —— V1 只有一张表，多 sheet 需要写 xlsx 二进制，成本不划算。
 */
export async function exportItemsCsv(): Promise<{ uri: string; fileName: string; rows: number }> {
  const items = await listAllForExport();
  const categories = await listAllCategories();
  const locations = await listAllLocations();

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const locationById = new Map(locations.map((l) => [l.id, l]));

  const header = [
    '名称',
    '分类',
    '位置',
    '格位',
    '购买日期',
    '价格',
    '过期时间',
    '品牌',
    '型号',
    '标签',
    '备注',
    '录入时间',
  ];

  const rows = items.map((item) => {
    const loc = item.locationId ? locationById.get(item.locationId) : undefined;
    const cabinet = loc?.parentId ? locationById.get(loc.parentId) : undefined;
    return [
      item.name,
      item.categoryId ? (categoryName.get(item.categoryId) ?? '') : '',
      cabinet?.name ?? loc?.name ?? '',
      cabinet ? (loc?.name ?? '') : '',
      item.purchaseDate ?? '',
      item.price ?? '',
      item.expireDate ?? '',
      item.brand ?? '',
      item.model ?? '',
      item.tags.join(' / '),
      (item.note ?? '').replace(/\r?\n/g, ' '),
      new Date(item.createdAt).toISOString().slice(0, 19).replace('T', ' '),
    ].map(csvCell);
  });

  const csv = CSV_BOM + [header.map(csvCell), ...rows].map((r) => r.join(',')).join('\r\n');

  const fileName = `格物-物品清单-${stamp()}.csv`;
  const out = new File(Paths.cache, fileName);
  out.create({ overwrite: true, intermediates: true });
  out.write(strToU8(csv));

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(out.uri, {
      mimeType: 'text/csv',
      dialogTitle: '保存或发送物品清单',
      UTI: 'public.comma-separated-values-text',
    });
  }

  return { uri: out.uri, fileName, rows: items.length };
}

/* ------------------------------------------------------------ 导入 */

function parseJson<T>(bytes: Uint8Array | undefined, fallback: T): T {
  if (!bytes) return fallback;
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch {
    return fallback;
  }
}

async function pickBackupFile(): Promise<DocumentPickerAsset | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/zip', 'application/x-zip-compressed', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  return result.assets[0] ?? null;
}

/**
 * 从用户选择的文件导入。
 *
 * replace —— 先清空业务数据再写回，语义简单、绝不重复
 * merge   —— 按 UUID 判重，只补不存在的记录（这也是主键必须 UUID 的原因：
 *            两台设备的备份一合并，自增 ID 立刻撞车）
 */
export async function importBackup(strategy: ImportStrategy): Promise<ImportResult> {
  let asset: DocumentPickerAsset | null;
  try {
    asset = await pickBackupFile();
  } catch (err) {
    return { canceled: false, error: err instanceof Error ? err.message : '无法打开文件选择器' };
  }
  if (!asset) return { canceled: true };

  let unzipped: Record<string, Uint8Array>;
  try {
    const file = new File(asset.uri);
    unzipped = unzipSync(file.bytesSync());
  } catch {
    return { canceled: false, error: '这个文件不是有效的 ZIP 备份包' };
  }

  const manifest = parseJson<BackupManifest | null>(unzipped['manifest.json'], null);
  if (!manifest || manifest.app !== 'gewu') {
    return { canceled: false, error: '这不是格物的备份包（缺少 manifest.json）' };
  }
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    return {
      canceled: false,
      error: `备份包版本（v${manifest.formatVersion}）比当前 App 新，请先升级 App`,
    };
  }

  const categories = parseJson<Category[]>(unzipped['data/categories.json'], []);
  const locations = parseJson<StorageLocation[]>(unzipped['data/locations.json'], []);
  const items = parseJson<Item[]>(unzipped['data/items.json'], []);
  const photos = parseJson<Photo[]>(unzipped['data/photos.json'], []);

  const db = await getDatabase();

  if (strategy === 'replace') {
    await wipeBusinessData(db);
  }

  // 判重：merge 只补缺失；replace 时库已清空，两者等价于全插
  const existingItemIds = strategy === 'merge' ? await existingIds(items.map((i) => i.id)) : new Set<string>();
  const existingLocIds =
    strategy === 'merge' ? await existingLocationIds(locations.map((l) => l.id)) : new Set<string>();
  const existingCatIds =
    strategy === 'merge'
      ? new Set(
          (await db.getAllAsync<{ id: string }>('SELECT id FROM categories')).map((r) => r.id),
        )
      : new Set<string>();

  let skipped = 0;

  // 分类与位置必须先落，物品才有外键可指
  for (const category of categories) {
    if (existingCatIds.has(category.id)) {
      skipped += 1;
      continue;
    }
    await insertRawCategory(category);
  }

  for (const location of locations) {
    if (existingLocIds.has(location.id)) {
      skipped += 1;
      continue;
    }
    await insertRawLocation(location);
  }

  let itemCount = 0;
  for (const item of items) {
    if (existingItemIds.has(item.id)) {
      skipped += 1;
      continue;
    }
    await insertRaw(item);
    itemCount += 1;
  }

  // 照片：先落盘再写索引。文件失败则跳过该条索引，避免产生死链
  ensureDirs();
  let photoCount = 0;
  let photoFiles = 0;
  for (const photo of photos) {
    if (strategy === 'merge' && existingItemIds.has(photo.itemId)) {
      skipped += 1;
      continue;
    }
    let ok = true;
    for (const rel of [photo.filePath, photo.thumbPath]) {
      const bytes = unzipped[rel];
      if (!bytes) continue;
      try {
        const target = new File(Paths.document, rel);
        target.create({ overwrite: true, intermediates: true });
        target.write(bytes);
        photoFiles += 1;
      } catch {
        ok = false;
      }
    }
    if (ok) {
      await insertRawPhoto(photo);
      photoCount += 1;
    }
  }

  return {
    canceled: false,
    manifest,
    written: {
      items: itemCount,
      categories: strategy === 'replace' ? categories.length : categories.length - skipped,
      locations: locations.length,
      photos: photoCount,
      photoFiles,
      skipped,
    },
  };
}

/* ------------------------------------------------------------ 自检 */

/** 存储占用，用于「我的」页展示 */
export function getStorageUsage() {
  return storageUsage();
}
