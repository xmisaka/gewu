/**
 * 格物 · 图片管道
 *
 * 硬约束（PRD 第 9 章）：图片必须复制进 App 沙盒，不能只存相册引用，
 * 否则用户清理相册后物品照片全变白框。
 *
 * 存储布局（均位于 Paths.document 下）：
 *   photos/<uuid>.jpg   长边 1600 的压缩原图
 *   thumbs/<uuid>.jpg   宽 320 的缩略图
 *
 * DB 只存相对路径，便于备份包整体打包与跨设备还原。
 *
 * 实现注记：File.move / File.copy 返回 Promise，必须用 moveSync / copySync
 * 或显式 await —— 漏掉会留下半成品文件。
 */

import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { uuid } from '../id';

/* ------------------------------------------------------------ 常量 */

/** 原图长边上限 */
const MAX_EDGE = 1600;
/** 缩略图宽度 */
const THUMB_WIDTH = 320;
/** 原图 JPEG 质量 */
const QUALITY = 0.82;
/** 缩略图 JPEG 质量 */
const THUMB_QUALITY = 0.75;

export const PHOTO_DIR = 'photos';
export const THUMB_DIR = 'thumbs';

/* ------------------------------------------------------------ 目录 */

function dirFor(name: string): Directory {
  const dir = new Directory(Paths.document, name);
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  return dir;
}

export function ensureDirs(): void {
  dirFor(PHOTO_DIR);
  dirFor(THUMB_DIR);
}

/** 相对路径 → 可直接给 <Image> 的 uri */
export function absoluteUri(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null;
  return new File(Paths.document, relativePath).uri;
}

/** 文件是否存在，用于检出「DB 有记录但文件丢了」 */
export function fileExists(relativePath: string): boolean {
  try {
    return new File(Paths.document, relativePath).exists;
  } catch {
    return false;
  }
}

function sizeOf(relativePath: string): number {
  try {
    const f = new File(Paths.document, relativePath);
    return f.exists ? (f.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------ 类型 */

export interface IngestedPhoto {
  /** 相对路径，形如 `photos/xxxx.jpg` */
  filePath: string;
  thumbPath: string;
  width: number;
  height: number;
  bytes: number;
}

/** 待处理的源图（来自相册或相机） */
export interface SourceImage {
  uri: string;
  width: number;
  height: number;
}

/** 一次导入的结果：成功落盘的照片 + 失败的原始 uri，便于如实汇报 */
export interface IngestResult {
  photos: IngestedPhoto[];
  failed: string[];
}

/* ------------------------------------------------------------ 写入 */

/**
 * 按长边计算缩放动作。
 * 只在长边超过上限时缩，绝不放大——放大既损画质又白占空间。
 */
function resizeAction(w: number, h: number): { width?: number; height?: number } | null {
  if (!w || !h) return null;
  const longEdge = Math.max(w, h);
  if (longEdge <= MAX_EDGE) return null;
  return w >= h ? { width: MAX_EDGE } : { height: MAX_EDGE };
}

/**
 * 单张处理：压缩原图 → 落沙盒 → 据此生成缩略图。
 * 任一步失败即抛错，由调用方计入 failed，不产生半成品记录。
 */
async function ingestOne(source: SourceImage): Promise<IngestedPhoto> {
  ensureDirs();
  const key = uuid();

  // 1) 原图压缩
  let fullCtx = ImageManipulator.manipulate(source.uri);
  const action = resizeAction(source.width, source.height);
  if (action) {
    fullCtx = fullCtx.resize(action);
  }
  const fullRef = await fullCtx.renderAsync();
  const full = await fullRef.saveAsync({ compress: QUALITY, format: SaveFormat.JPEG });

  const filePath = `${PHOTO_DIR}/${key}.jpg`;
  const fullFile = new File(Paths.document, filePath);
  if (fullFile.exists) fullFile.delete();
  new File(full.uri).moveSync(fullFile);

  // 2) 缩略图：从已落盘的压缩原图生成，避免二次解码用户原始大图
  const thumbCtx = ImageManipulator.manipulate(fullFile.uri).resize({ width: THUMB_WIDTH });
  const thumbRef = await thumbCtx.renderAsync();
  const thumb = await thumbRef.saveAsync({ compress: THUMB_QUALITY, format: SaveFormat.JPEG });

  const thumbPath = `${THUMB_DIR}/${key}.jpg`;
  const thumbFile = new File(Paths.document, thumbPath);
  if (thumbFile.exists) thumbFile.delete();
  new File(thumb.uri).moveSync(thumbFile);

  return {
    filePath,
    thumbPath,
    width: full.width ?? source.width,
    height: full.height ?? source.height,
    bytes: sizeOf(filePath) + sizeOf(thumbPath),
  };
}

/** 批量导入。逐张处理，单张失败不影响其余。 */
export async function ingestMany(sources: SourceImage[]): Promise<IngestResult> {
  const photos: IngestedPhoto[] = [];
  const failed: string[] = [];

  for (const src of sources) {
    try {
      photos.push(await ingestOne(src));
    } catch {
      failed.push(src.uri);
    }
  }

  return { photos, failed };
}

/* ------------------------------------------------------------ 选择与拍摄 */

function toSource(asset: ImagePicker.ImagePickerAsset): SourceImage {
  return {
    uri: asset.uri,
    width: asset.width ?? 0,
    height: asset.height ?? 0,
  };
}

/** 从相册选择，支持多选。已处理权限被拒的情形。 */
export async function pickFromLibrary(
  limit = 9,
): Promise<{ sources: SourceImage[]; denied: boolean }> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { sources: [], denied: true };

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    quality: 1,
    exif: false,
  });

  if (result.canceled) return { sources: [], denied: false };
  return { sources: result.assets.map(toSource), denied: false };
}

/** 调用相机拍摄单张 */
export async function captureWithCamera(): Promise<{ sources: SourceImage[]; denied: boolean }> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return { sources: [], denied: true };

  const result = await ImagePicker.launchCameraAsync({ quality: 1, exif: false });

  if (result.canceled) return { sources: [], denied: false };
  return { sources: result.assets.map(toSource), denied: false };
}

/* ------------------------------------------------------------ 清理 */

/** 删除一组相对路径对应的文件。忽略不存在的文件与单点失败。 */
export function deleteFiles(relativePaths: string[]): void {
  for (const rel of relativePaths) {
    if (!rel) continue;
    try {
      const f = new File(Paths.document, rel);
      if (f.exists) f.delete();
    } catch {
      // 单个文件删除失败不应中断整体清理
    }
  }
}

/** 磁盘占用统计 */
export function storageUsage(): { photoBytes: number; thumbBytes: number; total: number } {
  const sum = (rel: string): number => {
    try {
      const dir = new Directory(Paths.document, rel);
      if (!dir.exists) return 0;
      return dir.list().reduce((acc, entry) => {
        if (entry instanceof File && entry.exists) return acc + (entry.size ?? 0);
        return acc;
      }, 0);
    } catch {
      return 0;
    }
  };

  const photoBytes = sum(PHOTO_DIR);
  const thumbBytes = sum(THUMB_DIR);
  return { photoBytes, thumbBytes, total: photoBytes + thumbBytes };
}

/**
 * 备份包导出用：把照片复制到 cache 下的暂存目录。
 * 返回 相对路径 → 暂存绝对 uri 的映射（缺失的文件直接跳过，备份不因此失败）。
 */
export function stageForBackup(
  relativePaths: string[],
  stagingDirName: string,
): Map<string, string> {
  const staging = new Directory(Paths.cache, stagingDirName);
  if (staging.exists) staging.delete();
  staging.create({ intermediates: true });

  const map = new Map<string, string>();
  for (const rel of relativePaths) {
    try {
      const src = new File(Paths.document, rel);
      if (!src.exists) continue;
      // 相对路径里的 `/` 不能进文件名，替换为分隔符
      const dest = new File(staging, rel.replace(/\//g, '__'));
      src.copySync(dest);
      map.set(rel, dest.uri);
    } catch {
      // 跳过
    }
  }
  return map;
}
