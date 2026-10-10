/**
 * 格物 · 批量识图的调度与结果归类（纯函数）
 *
 * 批量识图 = 「选一堆图 → 逐张识别 → 清单核对 → 批量入库」。
 * 这一层只管**条目的状态流转与归类**，不碰网络、不碰数据库、不碰 React ——
 * 于是「哪条算识别成功、哪条能保存、进度怎么数」这些**判错了也不报错**的规则
 * 能进 node:test（与 `lib/backup/policy.ts` 同一个理由）。
 *
 * ── 为什么条目要自带一份「用户草稿」
 * 识别结果（`fields`）与用户在清单里改过的值是两个东西：用户把「德芙巧克力」
 * 改成「巧克力（过年买的）」，条目的 `name` 该是后者；而 `fields` 仍留着模型的
 * 原始输出 —— 界面据此判断「这一行是不是 AI 填的」（决定挂不挂 AI 标）。
 * 两者混成一个字段，用户一改就再也说不清哪些是模型猜的。
 *
 * ── 与单件识物的关系
 * 单件走 `ItemForm.applyRecognition`（回填表单、用户逐字段确认后保存）。
 * 批量**刻意不复用那条路**：`ItemForm` 是整页级组件（自带滚动、双提交按钮、
 * 自己的 `useTagLibrary` 与重名检测），挂进清单行会重挂并冲掉用户刚改的值，
 * 而且它的提交语义是「录一件存一件」，与「全部审完一次入库」正好相反。
 * 见 roadmap 第八章 8.5。
 *
 * 不 import expo / react-native / db —— 照片只用最小结构（见 `BatchPhoto`），
 * 不复用 `photos/pipeline` 的 `IngestedPhoto`，因为那个模块 import 了 expo-image-manipulator。
 */

import type { DateString, ItemDraft } from '../types';
import { EMPTY_FIELDS, type ExtractedFields, type ExtractedKey } from './extract';

/* ------------------------------------------------------------------ 类型 */

/**
 * 条目状态。
 *
 * `empty` 与 `failed` 分开是刻意的：前者是「模型看了但没读出字段」（图太糊、
 * 拍的是反面），后者是「这一趟没跑成」（超时、限流、网络）。对用户而言
 * 要做的事一样（补名字），但**提示语不同** —— 把网络抖动说成「识别不出来」
 * 会让人以为是自己拍得不好。
 */
export type BatchStatus = 'pending' | 'running' | 'done' | 'empty' | 'failed';

/**
 * 已落盘的照片引用（相对沙盒路径）。
 * 只保留批量用得到的两项；结构上是 `photos/pipeline` 的 `IngestedPhoto` 的子集。
 */
export interface BatchPhoto {
  filePath: string;
  thumbPath: string;
}

export interface BatchEntry {
  /** 稳定标识：列表 key、编辑定位、以及「哪些照片还没入库」的判据 */
  key: string;
  status: BatchStatus;
  /** 落盘后的照片。识别失败也留着 —— 它本来就是这件东西的图 */
  photo: BatchPhoto | null;
  /** 模型的原始输出（不被用户编辑覆盖，界面据此挂 AI 标） */
  fields: ExtractedFields;
  /** 模型真的给出了值的字段 */
  filled: ExtractedKey[];
  confidence: number | null;
  /** 覆盖默认提示（失败原因 / 空结果说明）。null ＝ 让界面按 status 生成 */
  notice: string | null;

  /* ---- 以下三行是「用户可编辑的草稿」，初始值来自识别结果 ---- */
  name: string;
  categoryId: string | null;
  locationId: string | null;
  expireDate: DateString | null;

  /** 是否勾选保存。默认勾上 —— 批量的默认意图就是「全都要」 */
  selected: boolean;
}

export interface BatchProgress {
  total: number;
  /** 已跑完的（done / empty / failed） */
  finished: number;
  /** 正在跑的（串行，只会是 0 或 1） */
  running: number;
}

/* ------------------------------------------------------------------ 构造与流转 */

/** 新建一条待识别条目。`key` 由调用方给（页面用序号 + 时间戳，测试里随便给） */
export function newEntry(key: string, photo: BatchPhoto | null): BatchEntry {
  return {
    key,
    status: 'pending',
    photo,
    fields: EMPTY_FIELDS,
    filled: [],
    confidence: null,
    notice: null,
    name: '',
    categoryId: null,
    locationId: null,
    expireDate: null,
    selected: true,
  };
}

/** 逐条替换某个 key 的条目（不改原数组） */
function patchEntry(
  entries: readonly BatchEntry[],
  key: string,
  patch: Partial<BatchEntry>,
): BatchEntry[] {
  return entries.map((e) => (e.key === key ? { ...e, ...patch } : e));
}

export function markRunning(entries: readonly BatchEntry[], key: string): BatchEntry[] {
  return patchEntry(entries, key, { status: 'running', notice: null });
}

/**
 * 挂上刚落盘的照片。
 *
 * 与 `newEntry` 分开是因为「先有照片才能挂」：条目在选完图的那一刻就建好了
 * （用户能立刻看到「要识别几张」），照片要等落盘那一步之后才有。
 * 落盘失败（或这张图本身处理不了）时照片为 null，条目照样留着等用户补名字。
 */
export function attachPhoto(
  entries: readonly BatchEntry[],
  key: string,
  photo: BatchPhoto | null,
): BatchEntry[] {
  return patchEntry(entries, key, { photo });
}

/**
 * 写入一次识别结果（成功分支）。
 *
 * ★ 只覆盖「模型真的给了值」的字段：`name` / `expireDate` / 分类 都是
 *   空则保留条目的现值。清单是流式出现的，用户在排队时可能已经改过前面几条 ——
 *   用空值去覆盖会把他的输入冲掉。
 *
 * 模型一个字段都没读出来时（`parseExtract` 返回 null → 调用方传 `null`），
 * 归为 `empty`：照片照旧留着，等用户补名字。
 */
export function applyResult(
  entries: readonly BatchEntry[],
  key: string,
  result: { fields: ExtractedFields; filled: ExtractedKey[]; confidence: number | null } | null,
): BatchEntry[] {
  if (!result) {
    return patchEntry(entries, key, { status: 'empty', notice: null });
  }
  const f = result.fields;
  const patch: Partial<BatchEntry> = {
    status: 'done',
    fields: f,
    filled: result.filled,
    confidence: result.confidence,
    notice: null,
  };
  /* 空值不覆盖 —— 与上面那条承诺一致：模型没读出来的字段，保留条目现值 */
  if (f.name) patch.name = f.name;
  if (f.expireDate) patch.expireDate = f.expireDate;
  return patchEntry(entries, key, patch);
}

/** 写入一次失败（超时 / 限流 / 网络）。照片留着，条目降级成「待补名」 */
export function markFailed(
  entries: readonly BatchEntry[],
  key: string,
  notice: string,
): BatchEntry[] {
  return patchEntry(entries, key, { status: 'failed', notice });
}

/** 用户改了名称 */
export function rename(entries: readonly BatchEntry[], key: string, name: string): BatchEntry[] {
  return patchEntry(entries, key, { name });
}

/** 用户改了分类 / 位置 / 到期（清单行内的轻量编辑） */
export function assign(
  entries: readonly BatchEntry[],
  key: string,
  patch: Partial<Pick<BatchEntry, 'categoryId' | 'locationId' | 'expireDate'>>,
): BatchEntry[] {
  return patchEntry(entries, key, patch);
}

export function toggleSelected(entries: readonly BatchEntry[], key: string): BatchEntry[] {
  const target = entries.find((e) => e.key === key);
  if (!target) return entries.slice();
  return patchEntry(entries, key, { selected: !target.selected });
}

/**
 * 统一分类 / 位置。
 *
 * 同一批东西多半塞同一个柜子 —— 逐行改十次不如顶上点一次。
 * ★ **只改用户没单独动过的行**做不到（没记录「是否动过」），所以这里是**全覆盖**，
 *   并且只作用在「仍勾选」的条目上：用户明确去掉勾的，不去碰它。
 */
export function applyUniform(
  entries: readonly BatchEntry[],
  patch: Partial<Pick<BatchEntry, 'categoryId' | 'locationId'>>,
): BatchEntry[] {
  return entries.map((e) => (e.selected ? { ...e, ...patch } : e));
}

export function removeEntry(entries: readonly BatchEntry[], key: string): BatchEntry[] {
  return entries.filter((e) => e.key !== key);
}

/* ------------------------------------------------------------------ 派生 */

export function progressOf(entries: readonly BatchEntry[]): BatchProgress {
  let finished = 0;
  let running = 0;
  for (const e of entries) {
    if (e.status === 'done' || e.status === 'empty' || e.status === 'failed') finished += 1;
    else if (e.status === 'running') running += 1;
  }
  return { total: entries.length, finished, running };
}

/**
 * 这一条能不能入库。
 *
 * ★ 判据只有两条：**勾了** 且 **有名字**。刻意**不看 status** ——
 *   识别失败/空结果的条目，只要用户补了名字就该能存进去（照片早就在了，
 *   丢掉它反而制造孤儿文件）。反过来，识别成功但名称为空（模型只读出
 *   品牌与型号）也不能存 —— `items.name` 是必填。
 */
export function isSavable(entry: BatchEntry): boolean {
  return entry.selected && entry.name.trim().length > 0;
}

export function savableCount(entries: readonly BatchEntry[]): number {
  return entries.reduce((n, e) => (isSavable(e) ? n + 1 : n), 0);
}

/**
 * 组装入库用的草稿。
 *
 * 字段来源分两处，别混：`name / categoryId / locationId / expireDate` 取
 * **用户草稿**；其余（品牌 / 型号 / 数量 / 单价 / 购买日期 / 标签 / 备注）
 * 直接取模型的 `fields` —— 清单行里没有这些的编辑位，用户也就没动过它们。
 *
 * `defaults` 是整批的兜底位置（录入页那套「沿用上次位置」的口径）。
 */
export function toDrafts(
  entries: readonly BatchEntry[],
  defaults: { categoryId?: string | null; locationId?: string | null } = {},
): ItemDraft[] {
  const out: ItemDraft[] = [];
  for (const e of entries) {
    if (!isSavable(e)) continue;
    const f = e.fields;
    out.push({
      name: e.name.trim(),
      categoryId: e.categoryId ?? defaults.categoryId ?? null,
      locationId: e.locationId ?? defaults.locationId ?? null,
      purchaseDate: f.purchaseDate,
      price: f.price,
      expireDate: e.expireDate,
      brand: f.brand,
      model: f.model,
      quantity: f.quantity,
      tags: f.tags,
      note: f.note,
      sortOrder: null,
    });
  }
  return out;
}

/**
 * 顶部那句进度文案。
 *
 * 放在纯函数里是因为它有三个分支（在跑 / 跑完 / 全空），
 * 而「跑完了却还显示在跑」是那种一眼看不出、只能靠断言的错。
 */
export function progressLabel(p: BatchProgress, savable: number): string {
  if (p.total === 0) return '没有待识别的照片';
  if (p.running > 0) return `识别中 ${p.finished}/${p.total} · 别退出这一页`;
  if (p.finished < p.total) return `已识别 ${p.finished}/${p.total} 张`;
  return `${p.total} 张都跑完了 · ${savable} 条可保存`;
}
