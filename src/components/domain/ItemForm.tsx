/**
 * 格物 · 物品表单（录入 / 编辑共用）
 *
 * 设计约束来自 PRD：
 *   - 只强制「名称」，其余全部选填，把录入摩擦压到最低
 *   - 配三个补偿机制：按名称智能猜分类、空值归入未分类、支持批量补分类
 *
 * 交付物是「表单值」而非「数据库写入」：写入由调用页面负责，
 * 这样录入页（连续录入）与编辑页能共用同一套输入逻辑却各走各的落库路径。
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { CategoryPickerModal } from '@/components/domain/CategoryPickerModal';
import { CoverPickerModal } from '@/components/domain/CoverPickerModal';
import { DatePickerModal } from '@/components/domain/DatePickerModal';
import { LocationPickerModal } from '@/components/domain/LocationPickerModal';
import { Button } from '@/components/ui/controls';
import { PlainTag } from '@/components/ui/feedback';
import { Card, Divider, Gutter, SectionCard } from '@/components/ui/layout';
import { Body, Heading, Label, Meta, Title } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import type { ExtractedFields, ExtractedKey } from '@/lib/ai/extract';
import { LOW_CONFIDENCE_HINT } from '@/lib/ai/extract';
import { addMonths, formatDateCN, today } from '@/lib/date';
import type { CategoryWithCount } from '@/lib/db/categories';
import { formatMoney, parseMoneyInput } from '@/lib/format';
import { normalizeQuantity } from '@/lib/stock';
import { deleteFiles, ingestMany, pickFromLibrary, type IngestedPhoto } from '@/lib/photos/pipeline';
import { clearStockCache, downloadToCache, type CoverCandidate } from '@/lib/photos/stock';
import { defaultExpireMonths, EXPIRY_PRESETS, guessCategory, UNCATEGORIZED } from '@/lib/suggest';
import type { CabinetView, Item, ItemDraft, ItemView, Photo } from '@/lib/types';

import { PhotoThumb } from './media';
import { makeStyles } from '@/lib/theme';

/* ------------------------------------------------------------ 载荷 */

export interface FormPayload {
  draft: ItemDraft;
  /** 本次新拍/新选、已压缩落盘的照片 */
  newPhotos: IngestedPhoto[];
  /** 原有但被用户移除的照片 id */
  removedPhotoIds: string[];
  /**
   * 应当被提到最前、作为列表封面的那张新照片（photos 表里的相对路径）。
   * 只有「找封面」会设置它 —— 用户点那个按钮的意图就是「让它当封面」，
   * 而 addPhoto 默认是追加到末尾，不特意提一下就会排到最后，等于白找。
   */
  coverPath: string | null;
}

/**
 * 一次识物识别的结果。
 *
 * `photo` 是**已经落进沙盒**的那张照片 —— 识物与「找封面」不同：
 * 用户拍的那张实物照本身就该成为物品的照片，所以它在网络往返之前
 * 就已经走完了压缩与入库这条管道，识别失败也只是拿不到字段，
 * 照片照旧留着。
 */
export interface AiRecognition {
  fields: ExtractedFields;
  /** 模型真的给出值的字段，界面只给这些挂 AI 标记 */
  filled: ExtractedKey[];
  confidence: number | null;
  photo: IngestedPhoto | null;
  /**
   * 覆盖表单自动生成的那句提示。
   *
   * 存在的理由：识别在**网络那一步**失败时，照片早已落盘 ——
   * 直接返回 `{ error }` 会让那张照片变成没人引用的孤儿文件。
   * 所以那种情况返回带 `photo` 的空结果，用 `notice` 说清发生了什么。
   */
  notice?: string;
}

/** 识物来源 */
export type AiRecognizeSource = 'camera' | 'library';

/** 识别失败/被挡下时的返回：`error` 会直接显示在表单的提示行里 */
export interface AiRecognizeError {
  error: string;
}

export interface ItemFormProps {
  /** 编辑模式传入；录入模式为 null */
  initialItem?: ItemView | null;
  /**
   * 复制模式：拿这件物品当模板预填，但**不是在改它**。
   *
   * 与 initialItem 的差别全在语义上 ——
   *   1. 不自动聚焦名称（已经填好了，弹键盘反而挡住要看的东西）；
   *   2. 分类视为「用户已定」，不被猜词覆盖（否则复制过来又被猜回老分类）；
   *   3. 购买日期回到今天、过期时间按分类重新带（新买的一件，
   *      照抄原件的日期会让持有成本和到期状态双双失真）。
   * 传什么是调用方的决定（见 item/[id]/duplicate.tsx）：照片与备注由那里裁掉。
   */
  prefill?: ItemSeed | null;
  initialPhotos?: Photo[];
  categories: CategoryWithCount[];
  cabinets: CabinetView[];
  /**
   * 连续录入时沿用的默认值：录完一件接着录下一件，
   * 位置和分类通常不变，沿用能把每次录入的操作量砍掉一半。
   */
  defaults?: { categoryId?: string | null; locationId?: string | null };
  submitLabel: string;
  /** 次要按钮文案；不传则不显示 */
  secondaryLabel?: string;
  onSubmit: (payload: FormPayload, action: 'primary' | 'secondary') => Promise<void>;
  submitting?: boolean;
  /** 顶部标题，录入页用「录入物品」 */
  heading?: string;
  /**
   * 识物预填。**不传就不显示那个入口** —— 表单本身不知道什么叫「支持者档」、
   * 也不该知道「AI 有没有配好」，那些判断留在调用页面里。
   *
   * 返回 `null` 表示「用户取消了」或「已经被挡下并给过提示」，表单什么都不做；
   * 返回 `{ error }` 则把那句话显示在提示行里。
   */
  onAiRecognize?: (source: AiRecognizeSource) => Promise<AiRecognition | AiRecognizeError | null>;
}

/**
 * 预填只需物品的这几个字段。
 * 刻意用窄类型而不是 ItemView —— 否则调用方为了凑齐 categoryName / dailyCost
 * 那些派生字段，得先编造一堆假值出来。
 */
export type ItemSeed = Pick<
  Item,
  | 'name'
  | 'categoryId'
  | 'locationId'
  | 'purchaseDate'
  | 'price'
  | 'expireDate'
  | 'brand'
  | 'model'
  | 'quantity'
  | 'tags'
  | 'note'
  | 'sortOrder'
>;

interface DraftState {
  name: string;
  categoryId: string | null;
  locationId: string | null;
  purchaseDate: string | null;
  priceText: string;
  expireDate: string | null;
  brand: string;
  model: string;
  /**
   * 剩余件数，以文本持有。**空串与 `'0'` 是两回事**：
   * 空 = 只此一件、不启用库存（老用户全是这一档）；`'0'` = 用完了。
   * 这一点与 priceText / sortText 的处理方式一致，用字符串才分得清「留空」与 0。
   */
  quantityText: string;
  tagsText: string;
  note: string;
  /** 手动排序值，以文本持有以便区分「留空」与 0 */
  sortText: string;
}

function stateFrom(
  item: ItemSeed | null | undefined,
  defaults?: { categoryId?: string | null; locationId?: string | null },
): DraftState {
  return {
    name: item?.name ?? '',
    categoryId: item?.categoryId ?? defaults?.categoryId ?? null,
    locationId: item?.locationId ?? defaults?.locationId ?? null,
    // 购买日期默认今天：保证持有天数与资产统计不会因漏填而缺席
    purchaseDate: item ? item.purchaseDate : today(),
    priceText: item?.price != null ? String(item.price) : '',
    expireDate: item?.expireDate ?? null,
    brand: item?.brand ?? '',
    model: item?.model ?? '',
    quantityText: item?.quantity != null ? String(item.quantity) : '',
    tagsText: (item?.tags ?? []).join('、'),
    note: item?.note ?? '',
    sortText: item?.sortOrder != null ? String(item.sortOrder) : '',
  };
}

/**
 * 排序值只收整数；留空 / 非数字 → null，手动排序时沉到末尾。
 * 解析上允许负数（粘贴进来的话），虽然 number-pad 键盘本身敲不出负号 ——
 * 放宽解析不会有害，以后想换键盘类型也不用回来改。
 */
function parseSortValue(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * 数量只收非负整数；**留空 → null**（不启用库存），`0` 是一个有效值（用完了）。
 *
 * 夹取走 stock.ts 的 normalizeQuantity，与 setQuantity 共用同一条规则 ——
 * 表单里能粘进 `-3`，那种值落库后会让「剩 -3」直接上屏，而它既不报错也不告警。
 */
function parseQuantityValue(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? normalizeQuantity(value) : null;
}

export function ItemForm({
  initialItem,
  prefill,
  initialPhotos = [],
  categories,
  cabinets,
  defaults,
  submitLabel,
  secondaryLabel,
  onSubmit,
  submitting,
  heading,
  onAiRecognize,
}: ItemFormProps) {
  const styles = useStyles();
  const isEdit = !!initialItem;
  const isPrefill = !isEdit && !!prefill;

  const [draft, setDraft] = useState<DraftState>(() => {
    const base = stateFrom(initialItem ?? prefill, defaults);
    if (!isPrefill) return base;

    /* 复制出来的是**新**买的一件：购买日期回到今天，
       过期时间按分类重新带一份（原件的日期属于原件，抄过来就是错的）。 */
    const start = base.purchaseDate ?? today();
    const cat = categories.find((c) => c.id === base.categoryId);
    const months = cat?.defaultExpireMonths ?? defaultExpireMonths(cat?.name ?? null);
    return {
      ...base,
      purchaseDate: start,
      expireDate: months == null ? base.expireDate : addMonths(start, months),
    };
  });

  /**
   * 用户是否手动改过分类；改过就不再被猜词覆盖。
   * 编辑与复制都算「已定」—— 复制时被猜词改掉分类，等于复制功能白给。
   */
  const categoryTouched = useRef(isEdit || isPrefill);
  const nameRef = useRef<TextInput>(null);

  const [removedPhotoIds, setRemovedPhotoIds] = useState<string[]>([]);
  const [newPhotos, setNewPhotos] = useState<IngestedPhoto[]>([]);
  const [uploading, setUploading] = useState(false);

  const [categoryOpen, setCategoryOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  /** 找封面选中的那张图（photos 相对路径），提交时会被提到最前当封面 */
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [locationOpen, setLocationOpen] = useState(false);
  const [dateTarget, setDateTarget] = useState<'purchase' | 'expire' | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  /** 识物来源选择弹层 */
  const [recognizeOpen, setRecognizeOpen] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  /**
   * 模型填了、用户还没确认的字段。
   *
   * ★ 它是「信任」的载体：用户一眼要能分辨哪几个值是模型猜的。
   *   所以用户一旦手动改了某个字段，就必须把它从这里移掉 ——
   *   一个永远挂着的「AI」标，会让这个标记本身失去意义。
   */
  const [aiFields, setAiFields] = useState<Set<string>>(new Set());

  /** 提交后标记，避免卸载时把已入库的照片误删 */
  const committed = useRef(false);
  /**
   * 清理函数在卸载时才执行，那时闭包里的 newPhotos 会停留在初值 []，
   * 所以必须用 ref 跟踪最新值，否则「取消录入要删掉已落盘的照片」这条永远不生效。
   */
  const newPhotosRef = useRef<IngestedPhoto[]>([]);

  useEffect(() => {
    newPhotosRef.current = newPhotos;
  }, [newPhotos]);

  useEffect(() => {
    return () => {
      if (!committed.current && newPhotosRef.current.length > 0) {
        deleteFiles(newPhotosRef.current.flatMap((p) => [p.filePath, p.thumbPath]));
      }
    };
  }, []);

  const set = useCallback(<K extends keyof DraftState>(key: K, value: DraftState[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  /* ---------------------------------------------------------- AI 识物 */

  /**
   * 用户手动改过某个字段 → 摘掉那一行的「AI」标。
   *
   * 少了这一步，标记会永远挂着，用户很快就不再当真 ——
   * 那时「哪些值是模型猜的」这个信息等于没有。
   */
  const clearAi = useCallback((...keys: string[]) => {
    setAiFields((prev) => {
      if (!keys.some((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  }, []);

  /**
   * 把识别结果并进表单。
   *
   * 三条边界：
   *   ① **只覆盖模型真给了值的字段** —— 它返回 null 的字段保留用户已经填的，
   *      否则一次识别会把之前敲的字冲掉；
   *   ② 分类名要能在库里的分类中找得到才生效，找不到就整条丢掉（见 extract 的注释）；
   *   ③ 识别用的那张照片**同时就是这件物品的照片**，并且提到最前当封面 ——
   *      用户拍它的意图就是「给这件东西配张图」。
   */
  const applyRecognition = useCallback(
    (r: AiRecognition) => {
      const f = r.fields;
      const patch: Partial<DraftState> = {};
      const marked = new Set<string>();

      if (f.name) {
        patch.name = f.name;
        marked.add('name');
      }
      if (f.brand) {
        patch.brand = f.brand;
        marked.add('brand');
      }
      if (f.model) {
        patch.model = f.model;
        marked.add('model');
      }
      if (f.quantity != null) {
        patch.quantityText = String(f.quantity);
        marked.add('quantity');
      }
      if (f.expireDate) {
        patch.expireDate = f.expireDate;
        marked.add('expireDate');
      }
      if (f.tags.length > 0) {
        patch.tagsText = f.tags.join('、');
        marked.add('tags');
      }
      if (f.note) {
        patch.note = f.note;
        marked.add('note');
      }
      if (f.categoryName) {
        const target = categories.find((c) => c.name === f.categoryName);
        if (target) {
          patch.categoryId = target.id;
          marked.add('categoryId');
        }
      }

      setDraft((prev) => ({ ...prev, ...patch }));
      setAiFields(marked);
      // 分类是模型定的，别再被猜词覆盖回去
      if (marked.has('categoryId')) categoryTouched.current = true;

      if (r.photo) {
        setNewPhotos((prev) => [...prev, r.photo as IngestedPhoto]);
        setCoverPath(r.photo.filePath);
      }

      setHint(
        r.notice ??
          (marked.size === 0
            ? '识别没读出能用的字段，自己填一下'
            : r.confidence != null && r.confidence < 0.5
              ? LOW_CONFIDENCE_HINT
              : `AI 填了 ${marked.size} 项，带 AI 标的地方请你确认一下`),
      );
    },
    [categories],
  );

  const runRecognize = useCallback(
    async (source: AiRecognizeSource) => {
      if (!onAiRecognize || recognizing) return;
      setRecognizeOpen(false);
      setRecognizing(true);
      setHint(null);
      try {
        const outcome = await onAiRecognize(source);
        if (!outcome) return;
        if ('error' in outcome) {
          setHint(outcome.error);
          return;
        }
        applyRecognition(outcome);
      } finally {
        setRecognizing(false);
      }
    },
    [onAiRecognize, recognizing, applyRecognition],
  );

  /* ---------------------------------------------------------- 猜分类 */

  const suggestion = useMemo(() => {
    if (!draft.name.trim()) return null;
    const guessed = guessCategory(draft.name);
    if (!guessed) return null;
    const target = categories.find((c) => c.name === guessed);
    if (!target) return null;
    if (draft.categoryId === target.id) return null;
    return target;
  }, [draft.name, draft.categoryId, categories]);

  const applySuggestion = () => {
    if (!suggestion) return;
    categoryTouched.current = true;
    set('categoryId', suggestion.id);
    applyExpiryTemplate(suggestion.id);
  };

  /**
   * 按分类的默认保质期带出过期时间；只在用户还没填过期时间时出手。
   *
   * 取值**优先走数据库里那一列**（「我的 → 分类管理」可改），内置词典只作兜底。
   * 反过来会让新改的默认保质期看起来不生效 —— 用户改完来录入一次就该看到。
   */
  const applyExpiryTemplate = useCallback(
    (categoryId: string | null) => {
      const cat = categories.find((c) => c.id === categoryId);
      const months = cat?.defaultExpireMonths ?? defaultExpireMonths(cat?.name ?? null);
      if (months == null) return;
      setDraft((prev) => {
        if (prev.expireDate) return prev;
        const base = prev.purchaseDate ?? today();
        return { ...prev, expireDate: addMonths(base, months) };
      });
    },
    [categories],
  );

  /* ---------------------------------------------------------- 照片 */

  const keptPhotos = useMemo(
    () => initialPhotos.filter((p) => !removedPhotoIds.includes(p.id)),
    [initialPhotos, removedPhotoIds],
  );

  const pickPhotos = async () => {
    const { sources, denied } = await pickFromLibrary();
    if (denied) {
      setHint('没有相册权限，暂时无法选图');
      return;
    }
    if (sources.length === 0) return;

    setUploading(true);
    const result = await ingestMany(sources);
    setUploading(false);

    if (result.photos.length > 0) {
      setNewPhotos((prev) => [...prev, ...result.photos]);
    }
    if (result.failed.length > 0) {
      setHint(`${result.failed.length} 张图片处理失败，已跳过`);
    }
  };

  const removeKeptPhoto = (photoId: string) => setRemovedPhotoIds((prev) => [...prev, photoId]);
  const removeNewPhoto = (filePath: string) => {
    setNewPhotos((prev) => {
      const target = prev.find((p) => p.filePath === filePath);
      if (target) deleteFiles([target.filePath, target.thumbPath]);
      return prev.filter((p) => p.filePath !== filePath);
    });
    // 被移掉的正好是刚找的封面，就别再惦记它了
    if (coverPath === filePath) setCoverPath(null);
  };

  /**
   * 选定网图后入库。
   *
   * 关键点：网图不走自己的落盘路径，而是包装成 SourceImage 喂给 ingestMany，
   * 于是压缩、缩略图、沙盒路径与相册图完全一致 —— 备份包、导出、相册视图
   * 都不需要为「这张图是网上找的」加任何特判。
   *
   * 另外把它记成 coverPath：用户点「找封面」的意图就是让它当封面，
   * 而入库时新照片一律追加到末尾，不提一下就会排在已有照片后面，白找一趟。
   */
  const useCoverPhoto = async (candidate: CoverCandidate) => {
    setUploading(true);
    try {
      const source = await downloadToCache(candidate);
      const result = await ingestMany([source]);
      if (result.photos.length > 0) {
        setNewPhotos((prev) => [...prev, ...result.photos]);
        setCoverPath(result.photos[0].filePath);
      } else {
        setHint('这张图处理失败，换一张试试');
      }
    } catch (err) {
      setHint(err instanceof Error ? err.message : '图片下载失败，换一张试试');
    } finally {
      // 中转文件用完即清，缓存目录不该为一次选择长期留垃圾
      clearStockCache();
      setUploading(false);
      setCoverOpen(false);
    }
  };

  /** 名称与分类都空时，搜出来必然是随机图，不如不给入口 */
  const canFindCover = draft.name.trim().length > 0;

  /* ---------------------------------------------------------- 提交 */

  const price = parseMoneyInput(draft.priceText);
  const nameOk = draft.name.trim().length > 0;
  const canSubmit = nameOk && !submitting && !uploading;

  const submit = async (action: 'primary' | 'secondary') => {
    if (!canSubmit) return;
    const tags = draft.tagsText
      .split(/[、,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const payload: FormPayload = {
      draft: {
        name: draft.name.trim(),
        categoryId: draft.categoryId,
        locationId: draft.locationId,
        purchaseDate: draft.purchaseDate,
        price,
        expireDate: draft.expireDate,
        brand: draft.brand.trim() || null,
        model: draft.model.trim() || null,
        quantity: parseQuantityValue(draft.quantityText),
        tags,
        note: draft.note.trim() || null,
        sortOrder: parseSortValue(draft.sortText),
      },
      newPhotos,
      removedPhotoIds,
      // 只在照片真的还留在列表里时才声明封面，避免指向一个已被移除的文件
      coverPath: coverPath && newPhotos.some((p) => p.filePath === coverPath) ? coverPath : null,
    };

    committed.current = true;
    await onSubmit(payload, action);
  };

  /* ---------------------------------------------------------- 渲染 */

  const categoryLabel =
    categories.find((c) => c.id === draft.categoryId)?.name ?? UNCATEGORIZED;

  const locationLabel = (() => {
    if (!draft.locationId) return '未设置';
    for (const cab of cabinets) {
      if (cab.id === draft.locationId) return cab.name;
      const slot = cab.slots.find((s) => s.slot.id === draft.locationId);
      if (slot) return `${cab.name} · ${slot.slot.name}`;
    }
    return '未设置';
  })();

  const photoCount = keptPhotos.length + newPhotos.length;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {heading ? (
          <View style={styles.heading}>
            <Title>{heading}</Title>
          </View>
        ) : null}

        <SectionCard title={`照片（${photoCount}）`}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.photoStrip}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="添加照片"
              onPress={pickPhotos}
              disabled={uploading}
              style={styles.photoAdd}>
              <Ionicons
                name={uploading ? 'hourglass-outline' : 'camera-outline'}
                size={20}
                color={Palette.ink3}
              />
              <Label tone="ink3">{uploading ? '处理中' : '添加'}</Label>
            </Pressable>

            {/* 联网找封面：与「添加」并排，但用品牌色描边区分 ——
                它不是一次本地选择，而是会发网络请求的动作 */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="联网查找封面图"
              accessibilityState={{ disabled: uploading || !canFindCover }}
              onPress={() => setCoverOpen(true)}
              disabled={uploading || !canFindCover}
              style={[styles.photoAdd, styles.photoFind]}>
              <Ionicons
                name="sparkles-outline"
                size={20}
                color={canFindCover ? Palette.brand : Palette.ink4}
              />
              <Label color={canFindCover ? Palette.brand : Palette.ink4}>找封面</Label>
            </Pressable>

            {/* 拍照识物。只有调用方提供了处理函数才出现 ——
                表单自己不知道「支持者档」「有没有配 Key」这些事 */}
            {onAiRecognize ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="拍照识物，自动填表"
                accessibilityState={{ disabled: uploading || recognizing }}
                onPress={() => setRecognizeOpen(true)}
                disabled={uploading || recognizing}
                style={[styles.photoAdd, styles.photoAi]}>
                <Ionicons
                  name={recognizing ? 'hourglass-outline' : 'scan-outline'}
                  size={20}
                  color={recognizing ? Palette.ink3 : Palette.brand}
                />
                <Label color={recognizing ? Palette.ink3 : Palette.brand}>
                  {recognizing ? '识别中' : '识物'}
                </Label>
              </Pressable>
            ) : null}

            {keptPhotos.map((p) => (
              <View key={p.id}>
                <PhotoThumb thumb={p.thumbPath} name={draft.name || '照片'} size={72} radius={Radius.input} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="移除这张照片"
                  onPress={() => removeKeptPhoto(p.id)}
                  hitSlop={6}
                  style={styles.photoRemove}>
                  <Ionicons name="close" size={12} color={Palette.onAccent} />
                </Pressable>
              </View>
            ))}

            {newPhotos.map((p) => (
              <View key={p.filePath}>
                <PhotoThumb thumb={p.thumbPath} name={draft.name || '照片'} size={72} radius={Radius.input} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="移除这张照片"
                  onPress={() => removeNewPhoto(p.filePath)}
                  hitSlop={6}
                  style={styles.photoRemove}>
                  <Ionicons name="close" size={12} color={Palette.onAccent} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Gutter>
            <Meta tone="ink4" style={styles.photoNote}>
              图片会压缩后存入应用内，删除系统相册不影响这里
            </Meta>
          </Gutter>
        </SectionCard>

        <SectionCard title="必填">
          <Card padded={false} style={styles.cardGutter}>
            <Gutter>
              <FieldRow label="名称" required ai={aiFields.has('name')}>
                <TextInput
                  ref={nameRef}
                  value={draft.name}
                  onChangeText={(t) => {
                    set('name', t);
                    clearAi('name');
                    if (!categoryTouched.current) {
                      const guessed = guessCategory(t);
                      if (guessed) {
                        const target = categories.find((c) => c.name === guessed);
                        if (target) set('categoryId', target.id);
                      }
                    }
                  }}
                  placeholder="例：Type-C 数据线 1 米"
                  placeholderTextColor={Palette.ink4}
                  style={styles.input}
                  autoFocus={!isEdit && !isPrefill}
                  returnKeyType="next"
                  allowFontScaling={false}
                />
              </FieldRow>

              {suggestion ? (
                <Pressable
                  onPress={() => {
                    clearAi('categoryId');
                    applySuggestion();
                  }}
                  style={styles.suggest}>
                  <Ionicons name="sparkles-outline" size={13} color={Palette.brand} />
                  <Label tone="brand">猜它属于「{suggestion.name}」，点一下采纳</Label>
                </Pressable>
              ) : null}
            </Gutter>
          </Card>
        </SectionCard>

        <SectionCard title="归类">
          <Card padded={false} style={styles.cardGutter}>
            <Gutter>
              <FieldRow label="分类" ai={aiFields.has('categoryId')}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setCategoryOpen(true)}
                  style={styles.pickerValue}>
                  <Body tone={draft.categoryId ? 'ink' : 'ink3'}>{categoryLabel}</Body>
                  <Ionicons name="chevron-forward" size={15} color={Palette.ink4} />
                </Pressable>
              </FieldRow>
              <FieldRow label="位置" last>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setLocationOpen(true)}
                  style={styles.pickerValue}>
                  <Body tone={draft.locationId ? 'ink' : 'ink3'} numberOfLines={1}>
                    {locationLabel}
                  </Body>
                  <Ionicons name="chevron-forward" size={15} color={Palette.ink4} />
                </Pressable>
              </FieldRow>
            </Gutter>
          </Card>
        </SectionCard>

        <SectionCard title="时间与花费">
          <Card padded={false} style={styles.cardGutter}>
            <Gutter>
              <FieldRow label="购买日期">
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDateTarget('purchase')}
                  style={styles.pickerValue}>
                  <Body tone={draft.purchaseDate ? 'ink' : 'ink3'}>
                    {draft.purchaseDate ? formatDateCN(draft.purchaseDate) : '未设置'}
                  </Body>
                  <Ionicons name="calendar-outline" size={15} color={Palette.ink4} />
                </Pressable>
              </FieldRow>

              <FieldRow label="价格">
                <View style={styles.priceRow}>
                  <Body tone="ink2" style={styles.currency}>
                    ¥
                  </Body>
                  <TextInput
                    value={draft.priceText}
                    onChangeText={(t) => set('priceText', t)}
                    placeholder="未设置"
                    placeholderTextColor={Palette.ink4}
                    keyboardType="decimal-pad"
                    style={[styles.input, styles.priceInput]}
                    allowFontScaling={false}
                  />
                </View>
              </FieldRow>

              <FieldRow label="过期时间" ai={aiFields.has('expireDate')}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDateTarget('expire')}
                  style={styles.pickerValue}>
                  <Body tone={draft.expireDate ? 'ink' : 'ink3'}>
                    {draft.expireDate ? formatDateCN(draft.expireDate) : '未设置'}
                  </Body>
                  <Ionicons name="calendar-outline" size={15} color={Palette.ink4} />
                </Pressable>
              </FieldRow>

              {draft.expireDate == null ? (
                <View style={styles.presets}>
                  {EXPIRY_PRESETS.map((p) => (
                    <Pressable
                      key={p.label}
                      accessibilityRole="button"
                      onPress={() => {
                        const base = draft.purchaseDate ?? today();
                        set('expireDate', addMonths(base, p.months));
                        clearAi('expireDate');
                      }}
                      style={styles.preset}>
                      <Label tone="ink2">{p.label}</Label>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              {/* 数量紧挨着过期时间：两者都是「耗材属性」，一起填符合心理模型。
                  留空即单件、不启用库存 —— 这是老用户的默认档，不填任何东西行为不变。 */}
              <FieldRow label="数量" ai={aiFields.has('quantity')} last>
                <TextInput
                  value={draft.quantityText}
                  onChangeText={(t) => {
                    set('quantityText', t);
                    clearAi('quantity');
                  }}
                  placeholder="留空 = 只此一件"
                  placeholderTextColor={Palette.ink4}
                  keyboardType="number-pad"
                  style={styles.input}
                  allowFontScaling={false}
                />
              </FieldRow>
              <Meta tone="ink4" style={styles.quantityHint}>
                填了数字行尾才会显示数量胶囊，可以就地用掉 / 补一件；单位不用填，写在备注里即可
              </Meta>
            </Gutter>
          </Card>
        </SectionCard>

        <SectionCard title="更多信息（选填）">
          <Card padded={false} style={styles.cardGutter}>
            <Gutter>
              <FieldRow label="品牌" ai={aiFields.has('brand')}>
                <TextInput
                  value={draft.brand}
                  onChangeText={(t) => {
                    set('brand', t);
                    clearAi('brand');
                  }}
                  placeholder="未设置"
                  placeholderTextColor={Palette.ink4}
                  style={styles.input}
                  allowFontScaling={false}
                />
              </FieldRow>
              <FieldRow label="型号" ai={aiFields.has('model')}>
                <TextInput
                  value={draft.model}
                  onChangeText={(t) => {
                    set('model', t);
                    clearAi('model');
                  }}
                  placeholder="未设置"
                  placeholderTextColor={Palette.ink4}
                  style={styles.input}
                  allowFontScaling={false}
                />
              </FieldRow>
              <FieldRow label="标签" ai={aiFields.has('tags')}>
                <TextInput
                  value={draft.tagsText}
                  onChangeText={(t) => {
                    set('tagsText', t);
                    clearAi('tags');
                  }}
                  placeholder="用顿号分隔，如：办公、备用"
                  placeholderTextColor={Palette.ink4}
                  style={styles.input}
                  allowFontScaling={false}
                />
              </FieldRow>
              <FieldRow label="备注" ai={aiFields.has('note')}>
                <TextInput
                  value={draft.note}
                  onChangeText={(t) => {
                    set('note', t);
                    clearAi('note');
                  }}
                  placeholder="未设置"
                  placeholderTextColor={Palette.ink4}
                  style={[styles.input, styles.multiline]}
                  multiline
                  allowFontScaling={false}
                />
              </FieldRow>
              <FieldRow label="排序值" last>
                <TextInput
                  value={draft.sortText}
                  onChangeText={(t) => set('sortText', t)}
                  placeholder="未设置"
                  placeholderTextColor={Palette.ink4}
                  keyboardType="number-pad"
                  style={styles.input}
                  allowFontScaling={false}
                />
              </FieldRow>
              <Meta tone="ink4" style={styles.sortHint}>
                列表选「手动排序」时按这个数从小到大排；留空的不参与，排在最后
              </Meta>
            </Gutter>
          </Card>
        </SectionCard>

        {hint ? (
          <Gutter>
            <Meta tone="clay" style={styles.hint}>
              {hint}
            </Meta>
          </Gutter>
        ) : null}

        <View style={styles.actions}>
          {price != null && draft.purchaseDate ? (
            <Meta tone="brand" style={styles.preview}>
              按今天算，大约 {formatMoney(price / Math.max(1, daysSince(draft.purchaseDate)))} / 天
            </Meta>
          ) : null}

          <Button
            label={submitLabel}
            onPress={() => submit('primary')}
            disabled={!canSubmit}
            loading={submitting}
            size="lg"
          />
          {secondaryLabel ? (
            <Button
              label={secondaryLabel}
              tone="secondary"
              onPress={() => submit('secondary')}
              disabled={!canSubmit}
            />
          ) : null}
          {!nameOk ? (
            <Meta tone="ink4" style={styles.mustName}>
              名称是唯一必填项，填上就能保存
            </Meta>
          ) : null}
        </View>
      </ScrollView>

      <CategoryPickerModal
        visible={categoryOpen}
        categories={categories}
        selectedId={draft.categoryId}
        onClose={() => setCategoryOpen(false)}
        onPick={(id) => {
          categoryTouched.current = true;
          set('categoryId', id);
          if (id) applyExpiryTemplate(id);
        }}
      />

      <LocationPickerModal
        visible={locationOpen}
        cabinets={cabinets}
        selectedId={draft.locationId}
        onClose={() => setLocationOpen(false)}
        onPick={(id) => set('locationId', id)}
      />

      <DatePickerModal
        visible={dateTarget !== null}
        value={dateTarget === 'expire' ? draft.expireDate : draft.purchaseDate}
        title={dateTarget === 'expire' ? '过期时间' : '购买日期'}
        onClose={() => setDateTarget(null)}
        onPick={(date) => {
          if (dateTarget === 'expire') set('expireDate', date);
          else set('purchaseDate', date);
        }}
      />

      <CoverPickerModal
        visible={coverOpen}
        itemName={draft.name.trim()}
        categoryName={categories.find((c) => c.id === draft.categoryId)?.name ?? null}
        onClose={() => setCoverOpen(false)}
        onConfirm={useCoverPhoto}
      />

      <RecognizeSourceSheet
        visible={recognizeOpen}
        busy={recognizing}
        onClose={() => setRecognizeOpen(false)}
        onPick={runRecognize}
      />
    </KeyboardAvoidingView>
  );
}

/* ------------------------------------------------------------ 局部件 */

/**
 * 识物来源选择（拍一张 / 从相册选）。
 *
 * ★ 为什么单独弹一层、而不是点了直接进相机：
 *   识物的典型场景确实是「对着一件东西拍包装」，但网购截图、别人发来的图
 *   只能走相册。多问一句的成本，远低于进错入口白拍一张。
 *   （与「添加照片」直接进相册不同：那个要的是多选，识物只要一张。）
 */
function RecognizeSourceSheet({
  visible,
  busy,
  onClose,
  onPick,
}: {
  visible: boolean;
  busy: boolean;
  onClose: () => void;
  onPick: (source: AiRecognizeSource) => void;
}) {
  const styles = useStyles();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHead}>
          <Heading>拍照识物</Heading>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={Palette.ink3} />
          </Pressable>
        </View>

        <View style={styles.sheetBody}>
          <SourceRow
            icon="camera-outline"
            label="拍一张"
            hint="对着包装拍，识别最准"
            disabled={busy}
            onPress={() => onPick('camera')}
          />
          <Divider />
          <SourceRow
            icon="images-outline"
            label="从相册选"
            hint="网购截图、别人发来的图"
            disabled={busy}
            onPress={() => onPick('library')}
          />
        </View>

        <View style={styles.sheetFoot}>
          <Meta tone="ink3">
            识别会把这件物品的照片上传给模型，只上传压到 1024px 的副本；读出的字段带「AI」标，保存前你自己确认。糊图或反光拍不清时，它宁可少填一个字段，也不会替你猜。
          </Meta>
        </View>
      </View>
    </Modal>
  );
}

function SourceRow({
  icon,
  label,
  hint,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      android_ripple={{ color: Palette.ripple }}
      style={styles.sourceRow}>
      <Ionicons name={icon} size={18} color={disabled ? Palette.ink4 : Palette.brand} />
      <Body style={styles.sourceLabel}>{label}</Body>
      <Label tone="ink3">{hint}</Label>
    </Pressable>
  );
}

function FieldRow({
  label,
  required,
  ai,
  last,
  children,
}: {
  label: string;
  required?: boolean;
  /**
   * 这个值是不是模型填的 —— 是就在值右侧挂一个「AI」标。
   *
   * ★ 只标模型填的，不标规则带出的（分类默认保质期那条走的是 applyExpiryTemplate）。
   *   两者混在一起标，用户就没法分辨「哪几个值需要他确认一下」，
   *   而「保存前你说了算」这句话正是建立在能分辨之上的。
   */
  ai?: boolean;
  last?: boolean;
  children: React.ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.fieldRow, !last && styles.fieldRowBorder]}>
      <Body style={styles.fieldLabel}>
        {label}
        {required ? <Body color={Palette.clay}> *</Body> : null}
      </Body>
      <View style={styles.fieldContent}>
        {children}
        {ai ? <PlainTag text="AI" tone="brand" style={styles.fieldAi} /> : null}
      </View>
    </View>
  );
}

function daysSince(date: string): number {
  const d = new Date(date);
  return Math.max(1, Math.round((Date.now() - d.getTime()) / 86_400_000));
}

const useStyles = makeStyles((Palette) => ({
  flex: { flex: 1 },
  scroll: { paddingBottom: Space.xxxl * 2 },
  heading: { paddingHorizontal: GUTTER, paddingTop: Space.sm, paddingBottom: Space.xs },

  /* ★ 卡片必须自己扛左右边距（v1.3.0 修：以前四张卡都漏了，整页顶到屏幕两边）。
     SectionCard 只给「标题」加左右边距，内容区是裸露的 —— 卡片要不要内缩
     全看调用方，**漏了不报错**。
     这里用 marginHorizontal 而不是在外面再包一层 <Gutter>：卡片内部已经有一层
     <Gutter> 给字段行做左右内距（fieldRow 只设了 paddingVertical），
     若改包外层 Gutter，就得把内层那层挪走，字段行会立刻贴住卡片边缘。
     同一种做法见详情页的 fieldCard（也是 marginHorizontal: GUTTER）。 */
  cardGutter: { marginHorizontal: GUTTER },

  photoStrip: { gap: Space.sm, paddingHorizontal: GUTTER, paddingVertical: Space.xs },
  photoAdd: {
    width: 72,
    height: 72,
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: Palette.line,
    backgroundColor: Palette.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  photoRemove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: Palette.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* 找封面：实线品牌描边，与「添加」的虚线中性态区分开 */
  photoFind: { borderStyle: 'solid', borderColor: Palette.brandBg, backgroundColor: Palette.surface },
  /* 识物：同是实线品牌描边，但底色换成品牌浅底 —— 三个方块里它最像「主操作」，
     用户第一眼要能挑出来，所以给实底色而不是另一个描边方块 */
  photoAi: { borderStyle: 'solid', borderColor: Palette.brand, backgroundColor: Palette.brandBg },
  photoNote: { marginTop: Space.sm },

  fieldRow: { flexDirection: 'row', alignItems: 'center', minHeight: 50, paddingVertical: Space.sm },
  fieldRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Palette.line3 },
  fieldLabel: { width: 76, color: Palette.ink2 },
  /* ★ 横排而非纵排：这样「AI」标才能跟在值的右侧（设计稿是同行的），
     而不是掉到值下面一行。单子元素时行为与改前一致 ——
     TextInput 自带 flex:1 会占满，pickerValue 无 flex 则被 justifyContent 顶到右端。 */
  fieldContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Space.xs,
  },
  fieldAi: { alignSelf: 'center', flexShrink: 0 },
  input: {
    flex: 1,
    width: '100%',
    textAlign: 'right',
    padding: 0,
    ...(Type.body as object),
    color: Palette.ink,
  },
  multiline: { minHeight: 44, textAlignVertical: 'top', paddingTop: 0 },
  sortHint: { paddingBottom: Space.md, textAlign: 'right' },
  /* 数量行是这张卡的收尾，说明文字要留出底部内距，不然贴着卡片下缘 */
  quantityHint: { paddingBottom: Space.md, textAlign: 'right', lineHeight: 17 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  currency: { fontSize: 14 },
  priceInput: { textAlign: 'right' },
  pickerValue: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, maxWidth: '100%' },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs, paddingBottom: Space.md },
  preset: {
    paddingHorizontal: Space.sm + 2,
    paddingVertical: 4,
    borderRadius: Radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line,
    backgroundColor: Palette.surface2,
  },
  suggest: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingVertical: Space.sm,
    paddingBottom: Space.md,
  },
  hint: { marginTop: Space.md },
  actions: { paddingHorizontal: GUTTER, paddingTop: Space.xxl, gap: Space.sm, alignItems: 'stretch' },
  preview: { textAlign: 'center', marginBottom: Space.xs },
  mustName: { textAlign: 'center' },

  /* 识物来源弹层：与 SortPickerModal 同构（底部滑出、不进路由） */
  sheetBackdrop: { flex: 1, backgroundColor: Palette.scrim },
  sheet: {
    backgroundColor: Palette.surface,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    paddingBottom: Space.xxl,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Palette.line,
    alignSelf: 'center',
    marginTop: Space.sm,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingTop: Space.lg,
    paddingBottom: Space.md,
  },
  sheetBody: { paddingHorizontal: GUTTER, paddingBottom: Space.sm },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingVertical: Space.md },
  sourceLabel: { flex: 1 },
  sheetFoot: {
    paddingHorizontal: GUTTER,
    paddingTop: Space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
  },
}));
