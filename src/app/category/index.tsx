/**
 * 格物 · 分类管理
 *
 * PRD 第 7 章把「分类管理」列在「我的」页里，V1 却只做到了「能选」——
 * createCategory / renameCategory / deleteCategory 三个函数从建库起就没被调用过，
 * 用户只能用种子里的那 14 个分类，想加一个「相机镜头」都做不到。
 * 这一页把它们接出来。
 *
 * 三条设计决定：
 *   1. 内置分类**不可删除、但可以改名**。不可删是因为猜词结果得有实体可挂；
 *      可以改是因为「数码」「五金」未必贴合每个人的生活，把命名权交回去更合理。
 *      代价是改名后这类不再自动猜中（猜词词典按原名建索引），
 *      所以编辑内置分类时把这句话写在编辑区里，不藏着。
 *   2. 排序走「整表重写」（理由见 db/categories.ts 的 applyCategoryOrder），
 *      重排后 bump 一次，列表按新顺序重新读回来。
 *   3. 默认保质期收在这一页。录入页只是消费它 ——
 *      否则用户改了这个值却看不出任何变化，会以为坏了。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Button, IconButton } from '@/components/ui/controls';
import { EmptyState, Loading, PlainTag } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, ItemText, Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import {
  CATEGORY_NAME_MAX,
  applyCategoryOrder,
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
  type CategoryWithCount,
} from '@/lib/db/categories';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import { EXPIRY_PRESETS } from '@/lib/suggest';
import { makeStyles } from '@/lib/theme';

export default function CategoryScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { dataVersion, bump } = useAppState();

  const state = useAsyncData(() => listCategories(), [dataVersion], [] as CategoryWithCount[]);
  const categories = state.data;

  /* 新建 */
  const [name, setName] = useState('');
  const [months, setMonths] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  /* 改名 / 改保质期：一次只展开一行，避免一堆输入框同时亮着 */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editMonths, setEditMonths] = useState<number | null>(null);

  /** 重排期间锁住上下移，防止连点把两次重排叠在一起 */
  const [busy, setBusy] = useState(false);

  const builtinCount = useMemo(() => categories.filter((c) => c.builtin).length, [categories]);

  const openEdit = (cat: CategoryWithCount) => {
    if (expanded === cat.id) {
      setExpanded(null);
      return;
    }
    setExpanded(cat.id);
    setEditName(cat.name);
    setEditMonths(cat.defaultExpireMonths);
  };

  const runCreate = async () => {
    setSaving(true);
    try {
      await createCategory(name, months);
      setName('');
      setMonths(null);
      bump();
    } catch (err) {
      Alert.alert('没能新建', err instanceof Error ? err.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  const runUpdate = async (id: string) => {
    setSaving(true);
    try {
      await updateCategory(id, editName, editMonths);
      setExpanded(null);
      bump();
    } catch (err) {
      Alert.alert('没能保存', err instanceof Error ? err.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  const runDelete = (cat: CategoryWithCount) => {
    Alert.alert(
      `删除「${cat.name}」？`,
      cat.itemCount > 0
        ? `归在这一类下的 ${cat.itemCount} 件物品会回到「未分类」，物品本身不会被删。`
        : '这一类下面还没有物品，删掉不影响任何东西。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            const result = await deleteCategory(cat.id);
            if (!result.ok) {
              Alert.alert('没能删除', result.reason ?? '未知原因');
              return;
            }
            setExpanded(null);
            bump();
          },
        },
      ],
    );
  };

  /* 重排：把当前展示顺序当成基准，交换相邻两项后整体写回 */
  const move = async (id: string, delta: -1 | 1) => {
    const ids = categories.map((c) => c.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;

    [ids[from], ids[to]] = [ids[to], ids[from]];

    setBusy(true);
    try {
      await applyCategoryOrder(ids);
      bump();
    } catch (err) {
      Alert.alert('没能调整顺序', err instanceof Error ? err.message : '未知错误');
    } finally {
      setBusy(false);
    }
  };

  const canCreate = name.trim().length > 0 && !saving;
  const showLoading = state.loading && categories.length === 0;

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
        <Meta tone="ink3" style={styles.topHint}>
          {categories.length > 0 ? `${categories.length} 个` : ''}
        </Meta>
      </View>

      <PageHeader title="分类管理" subtitle="给东西归类，列表里就能按类筛" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <SectionCard title="新建分类">
            {/* 卡片自己扛左右边距：SectionCard 只给标题加边距，内容区裸露 */}
            <Card padded={false} style={styles.formCard}>
              <Gutter>
                <View style={styles.fieldRow}>
                  <Body style={styles.fieldLabel}>名称</Body>
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    placeholder="例：相机镜头"
                    placeholderTextColor={Palette.ink4}
                    style={styles.input}
                    maxLength={CATEGORY_NAME_MAX}
                    returnKeyType="done"
                    onSubmitEditing={() => {
                      if (canCreate) void runCreate();
                    }}
                    allowFontScaling={false}
                  />
                </View>
              </Gutter>

              <Gutter>
                <Meta tone="ink3" style={styles.blockHead}>
                  默认保质期（选填）
                </Meta>
                <MonthChips value={months} onChange={setMonths} />
                <Meta tone="ink4" style={styles.blockNote}>
                  录物品时选到这一类，会自动按购买日期带出过期时间
                </Meta>

                <Button
                  label={saving ? '保存中…' : '添加分类'}
                  onPress={() => void runCreate()}
                  disabled={!canCreate}
                  size="lg"
                  style={styles.createAction}
                />
              </Gutter>
            </Card>
          </SectionCard>

          <SectionCard title={`已有分类（${categories.length}）`}>
            {showLoading ? (
              <Loading />
            ) : categories.length === 0 ? (
              <EmptyState
                icon="pricetags-outline"
                title="一个分类都没有"
                description="正常情况下内置分类是不会消失的。上面新建一个就能用。"
              />
            ) : (
              <View style={styles.list}>
                {categories.map((cat, index) => {
                  const open = expanded === cat.id;
                  const first = index === 0;
                  const last = index === categories.length - 1;

                  return (
                    <Card key={cat.id} style={styles.catCard}>
                      <View style={styles.catHead}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`编辑 ${cat.name}`}
                          onPress={() => openEdit(cat)}
                          style={styles.catTitleWrap}>
                          <View style={styles.catNameRow}>
                            <ItemText numberOfLines={1}>{cat.name}</ItemText>
                            {cat.builtin ? <PlainTag text="内置" /> : null}
                          </View>
                          <Meta tone="ink3" numberOfLines={1}>
                            {cat.itemCount > 0 ? `${cat.itemCount} 件 · ` : ''}
                            {expiryLabel(cat.defaultExpireMonths)}
                          </Meta>
                        </Pressable>

                        <MoveButton
                          dir="up"
                          label={`把 ${cat.name} 上移`}
                          disabled={first || busy}
                          onPress={() => void move(cat.id, -1)}
                        />
                        <MoveButton
                          dir="down"
                          label={`把 ${cat.name} 下移`}
                          disabled={last || busy}
                          onPress={() => void move(cat.id, 1)}
                        />
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`编辑 ${cat.name}`}
                          hitSlop={6}
                          onPress={() => openEdit(cat)}
                          style={styles.chevron}>
                          <Ionicons
                            name={open ? 'chevron-up' : 'chevron-down'}
                            size={16}
                            color={Palette.ink4}
                          />
                        </Pressable>
                      </View>

                      {open ? (
                        <View style={styles.catBody}>
                          <View style={styles.editRow}>
                            <Body style={styles.fieldLabel}>名称</Body>
                            <TextInput
                              value={editName}
                              onChangeText={setEditName}
                              placeholder={cat.name}
                              placeholderTextColor={Palette.ink4}
                              style={styles.input}
                              maxLength={CATEGORY_NAME_MAX}
                              allowFontScaling={false}
                            />
                          </View>

                          <Meta tone="ink3" style={styles.blockHead}>
                            默认保质期
                          </Meta>
                          <MonthChips value={editMonths} onChange={setEditMonths} />

                          {cat.builtin ? (
                            <Meta tone="amber" style={styles.builtinNote}>
                              猜词的关键词是按种子里的名字索引的，一旦改名，这一类就不再自动猜中，
                              录物品时需要手动选一次。
                            </Meta>
                          ) : null}

                          <View style={styles.editActions}>
                            <Button
                              label={saving ? '保存中…' : '保存'}
                              onPress={() => void runUpdate(cat.id)}
                              disabled={!editName.trim() || saving}
                              block={false}
                              style={styles.editSave}
                            />
                            <Button
                              label="取消"
                              tone="secondary"
                              block={false}
                              onPress={() => setExpanded(null)}
                            />
                            {cat.builtin ? null : (
                              <Button
                                label="删除"
                                tone="danger"
                                icon="trash-outline"
                                block={false}
                                style={styles.editDelete}
                                onPress={() => runDelete(cat)}
                              />
                            )}
                          </View>
                        </View>
                      ) : null}
                    </Card>
                  );
                })}
              </View>
            )}
          </SectionCard>

          <Gutter>
            <Meta tone="ink4" style={styles.hint}>
              内置分类 {builtinCount} 个不可删除 —— 打字时自动猜分类要靠它们挂靠。
              顺序就是首页筛选条的先后，用右侧箭头调整。
            </Meta>
          </Gutter>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/* ------------------------------------------------------------ 局部件 */

/** 默认保质期选择：一排 chip，「不设」在最前 */
function MonthChips({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  const styles = useStyles();
  const options: { label: string; months: number | null }[] = [
    { label: '不设', months: null },
    ...EXPIRY_PRESETS.map((preset) => ({ label: preset.label, months: preset.months as number | null })),
  ];

  return (
    <View style={styles.chips}>
      {options.map((opt) => {
        const active = opt.months === value;
        return (
          <Pressable
            key={opt.label}
            accessibilityRole="button"
            accessibilityLabel={`保质期 ${opt.label}`}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(opt.months)}
            style={[styles.chip, active && styles.chipOn]}>
            <Label color={active ? Palette.onAccent : Palette.ink2}>{opt.label}</Label>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 上移 / 下移。
 *
 * 不用 IconButton：它没有禁用态，首项的上移箭头仍会显示成可按的样子。
 * 这里把「到底了」画成浅一档的灰，并真的禁用掉。
 */
function MoveButton({
  dir,
  label,
  disabled,
  onPress,
}: {
  dir: 'up' | 'down';
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={styles.moveBtn}>
      <Ionicons
        name={dir === 'up' ? 'chevron-up' : 'chevron-down'}
        size={17}
        color={disabled ? Palette.ink4 : Palette.ink3}
      />
    </Pressable>
  );
}

/** 把月数说成人话：整年的说年，其余说月 */
function expiryLabel(months: number | null): string {
  if (months == null) return '不设默认保质期';
  if (months % 12 === 0) return `默认保质期 ${months / 12} 年`;
  return `默认保质期 ${months} 个月`;
}

const useStyles = makeStyles((Palette) => ({
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER - Space.sm,
    paddingVertical: Space.sm,
  },
  topHint: { paddingRight: Space.sm },
  scroll: { paddingBottom: 120 },

  formCard: { marginHorizontal: GUTTER },
  fieldRow: { flexDirection: 'row', alignItems: 'center', minHeight: 50 },
  fieldLabel: { width: 60, color: Palette.ink2 },
  input: {
    flex: 1,
    padding: 0,
    ...(Type.body as object),
    color: Palette.ink,
  },
  blockHead: { paddingTop: Space.lg, paddingBottom: Space.sm },
  blockNote: { paddingTop: Space.sm },
  createAction: { marginTop: Space.lg },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  chip: {
    paddingHorizontal: Space.md,
    paddingVertical: 5,
    borderRadius: Radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line,
    backgroundColor: Palette.surface2,
  },
  chipOn: { backgroundColor: Palette.brand, borderColor: Palette.brand },

  list: { paddingHorizontal: GUTTER, gap: Space.md },
  catCard: { paddingHorizontal: Space.md, paddingVertical: Space.xs },
  catHead: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  catTitleWrap: { flex: 1, gap: 2, paddingVertical: Space.md },
  catNameRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  moveBtn: { padding: Space.xs },
  chevron: { padding: Space.xs },

  catBody: {
    paddingBottom: Space.md,
    paddingTop: Space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
  },
  editRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  builtinNote: { paddingTop: Space.md, lineHeight: 19 },
  editActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingTop: Space.lg,
  },
  editSave: { minWidth: 96 },
  editDelete: { marginLeft: 'auto' },

  hint: { paddingTop: Space.lg, lineHeight: 19 },
}));
