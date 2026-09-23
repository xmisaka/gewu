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
import { Card, Gutter, SectionCard } from '@/components/ui/layout';
import { Body, Label, Meta, Title } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import { addMonths, formatDateCN, today } from '@/lib/date';
import type { CategoryWithCount } from '@/lib/db/categories';
import { formatMoney, parseMoneyInput } from '@/lib/format';
import { deleteFiles, ingestMany, pickFromLibrary, type IngestedPhoto } from '@/lib/photos/pipeline';
import { clearStockCache, downloadToCache, type CoverCandidate } from '@/lib/photos/stock';
import { defaultExpireMonths, EXPIRY_PRESETS, guessCategory, UNCATEGORIZED } from '@/lib/suggest';
import type { CabinetView , ItemDraft, ItemView, Photo } from '@/lib/types';

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

export interface ItemFormProps {
  /** 编辑模式传入；录入模式为 null */
  initialItem?: ItemView | null;
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
}

interface DraftState {
  name: string;
  categoryId: string | null;
  locationId: string | null;
  purchaseDate: string | null;
  priceText: string;
  expireDate: string | null;
  brand: string;
  model: string;
  tagsText: string;
  note: string;
  /** 手动排序值，以文本持有以便区分「留空」与 0 */
  sortText: string;
}

function stateFrom(
  item: ItemView | null | undefined,
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

export function ItemForm({
  initialItem,
  initialPhotos = [],
  categories,
  cabinets,
  defaults,
  submitLabel,
  secondaryLabel,
  onSubmit,
  submitting,
  heading,
}: ItemFormProps) {
  const styles = useStyles();
  const isEdit = !!initialItem;
  const [draft, setDraft] = useState<DraftState>(() => stateFrom(initialItem, defaults));

  /** 用户是否手动改过分类；改过就不再被猜词覆盖 */
  const categoryTouched = useRef(isEdit);
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
    applyExpiryTemplate(suggestion.name);
  };

  /** 按分类默认保质期带出过期时间；只在用户还没填过期时间时出手 */
  const applyExpiryTemplate = useCallback(
    (categoryName: string | null) => {
      const months = defaultExpireMonths(categoryName);
      if (months == null) return;
      setDraft((prev) => {
        if (prev.expireDate) return prev;
        const base = prev.purchaseDate ?? today();
        return { ...prev, expireDate: addMonths(base, months) };
      });
    },
    [],
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
          <Card padded={false}>
            <Gutter>
              <FieldRow label="名称" required>
                <TextInput
                  ref={nameRef}
                  value={draft.name}
                  onChangeText={(t) => {
                    set('name', t);
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
                  autoFocus={!isEdit}
                  returnKeyType="next"
                  allowFontScaling={false}
                />
              </FieldRow>

              {suggestion ? (
                <Pressable onPress={applySuggestion} style={styles.suggest}>
                  <Ionicons name="sparkles-outline" size={13} color={Palette.brand} />
                  <Label tone="brand">猜它属于「{suggestion.name}」，点一下采纳</Label>
                </Pressable>
              ) : null}
            </Gutter>
          </Card>
        </SectionCard>

        <SectionCard title="归类">
          <Card padded={false}>
            <Gutter>
              <FieldRow label="分类">
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
          <Card padded={false}>
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

              <FieldRow label="过期时间" last={draft.expireDate == null}>
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
                      }}
                      style={styles.preset}>
                      <Label tone="ink2">{p.label}</Label>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </Gutter>
          </Card>
        </SectionCard>

        <SectionCard title="更多信息（选填）">
          <Card padded={false}>
            <Gutter>
              <FieldRow label="品牌">
                <TextInput
                  value={draft.brand}
                  onChangeText={(t) => set('brand', t)}
                  placeholder="未设置"
                  placeholderTextColor={Palette.ink4}
                  style={styles.input}
                  allowFontScaling={false}
                />
              </FieldRow>
              <FieldRow label="型号">
                <TextInput
                  value={draft.model}
                  onChangeText={(t) => set('model', t)}
                  placeholder="未设置"
                  placeholderTextColor={Palette.ink4}
                  style={styles.input}
                  allowFontScaling={false}
                />
              </FieldRow>
              <FieldRow label="标签">
                <TextInput
                  value={draft.tagsText}
                  onChangeText={(t) => set('tagsText', t)}
                  placeholder="用顿号分隔，如：办公、备用"
                  placeholderTextColor={Palette.ink4}
                  style={styles.input}
                  allowFontScaling={false}
                />
              </FieldRow>
              <FieldRow label="备注">
                <TextInput
                  value={draft.note}
                  onChangeText={(t) => set('note', t)}
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
          if (id) {
            const name = categories.find((c) => c.id === id)?.name ?? null;
            applyExpiryTemplate(name);
          }
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
    </KeyboardAvoidingView>
  );
}

/* ------------------------------------------------------------ 局部件 */

function FieldRow({
  label,
  required,
  last,
  children,
}: {
  label: string;
  required?: boolean;
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
      <View style={styles.fieldContent}>{children}</View>
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
  photoNote: { marginTop: Space.sm },

  fieldRow: { flexDirection: 'row', alignItems: 'center', minHeight: 50, paddingVertical: Space.sm },
  fieldRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Palette.line3 },
  fieldLabel: { width: 76, color: Palette.ink2 },
  fieldContent: { flex: 1, alignItems: 'flex-end' },
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
}));
