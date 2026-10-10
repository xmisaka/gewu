/**
 * 格物 · 新建 / 管理柜子与格位
 *
 * 一次只做一件事：先给柜子起名，再往里加格位。
 * 允许「只有柜子没有格位」—— 强迫用户先建格位才能存东西，
 * 会让「位置」这个字段被彻底放弃使用。
 *
 * ★ 2026-10-10：这一页从「只能新建 / 删整柜」补成**可编辑** ——
 *   点柜子展开后能改柜子名，格位也能改名、单独删除。
 *   数据层 `renameLocation` / `deleteLocation` 从建库起就在，只是一直没接出来；
 *   交互沿用 `app/category/index.tsx` 的内联展开编辑，两页手感一致。
 *   改名只动 `locations.name`，物品的 `location_id` 不受影响；
 *   删格位只清该格位下物品的位置记录，物品本身保留（同删整柜的口径）。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
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
import { Loading } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, ItemText, Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import {
  createCabinet,
  createSlot,
  deleteLocation,
  listCabinetViews,
  renameLocation,
} from '@/lib/db/locations';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import type { CabinetView, StorageLocation } from '@/lib/types';
import { makeStyles } from '@/lib/theme';

export default function NewCabinetScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { dataVersion, bump } = useAppState();

  const cabinetsState = useAsyncData(() => listCabinetViews(), [dataVersion], [] as CabinetView[]);

  const [name, setName] = useState('');
  const [slotDrafts, setSlotDrafts] = useState<string[]>([]);
  const [slotInput, setSlotInput] = useState('');
  const [saving, setSaving] = useState(false);

  /** 已存在的柜子展开状态，用于继续添加格位，同时承载「编辑柜子名」 */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [extraSlot, setExtraSlot] = useState('');

  /** 展开中的柜子名草稿 —— 保存前不动库，取消即丢弃 */
  const [cabinetName, setCabinetName] = useState('');
  /** 正在改名的格位 id；一次只编一个，避免一排输入框同时亮着 */
  const [editingSlot, setEditingSlot] = useState<string | null>(null);
  const [slotName, setSlotName] = useState('');

  const canSave = name.trim().length > 0 && !saving;

  const addDraft = () => {
    const value = slotInput.trim();
    if (!value) return;
    setSlotDrafts((prev) => [...prev, value]);
    setSlotInput('');
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const cabinetId = await createCabinet(name.trim());
      for (const slot of slotDrafts) {
        await createSlot(cabinetId, slot);
      }
      bump();
      router.replace({ pathname: '/cabinet/[id]', params: { id: cabinetId } });
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  /** 展开 / 收起某个柜子；展开时把当前名预填进草稿，收起时清掉编辑态 */
  const toggleCabinet = (cabinet: CabinetView) => {
    const open = expanded === cabinet.id;
    setExpanded(open ? null : cabinet.id);
    setCabinetName(open ? '' : cabinet.name);
    setExtraSlot('');
    setEditingSlot(null);
  };

  const addSlotTo = async (cabinetId: string) => {
    const value = extraSlot.trim();
    if (!value) return;
    await createSlot(cabinetId, value);
    setExtraSlot('');
    bump();
  };

  const saveCabinetName = async (cabinetId: string) => {
    const value = cabinetName.trim();
    if (!value) return;
    await renameLocation(cabinetId, value);
    setCabinetName(value);
    bump();
  };

  const startEditSlot = (slot: StorageLocation) => {
    setEditingSlot(slot.id);
    setSlotName(slot.name);
  };

  const commitSlotName = async () => {
    if (!editingSlot) return;
    const value = slotName.trim();
    if (value) await renameLocation(editingSlot, value);
    setEditingSlot(null);
    bump();
  };

  const removeSlot = (slot: StorageLocation, count: number) => {
    Alert.alert(
      `删除格位「${slot.name}」？`,
      count > 0
        ? `这一格里的 ${count} 件物品不会被删除，只是不再记录位置。`
        : '这一格是空的，删掉不影响任何东西。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            await deleteLocation(slot.id);
            setEditingSlot(null);
            bump();
          },
        },
      ],
    );
  };

  const removeCabinet = (cabinetId: string, cabinetName2: string, count: number) => {
    Alert.alert(
      `删除「${cabinetName2}」？`,
      count > 0
        ? `柜子里的 ${count} 件物品不会被删除，只是不再记录位置。`
        : '这个柜子和它下面的格位都会被删除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            await deleteLocation(cabinetId);
            setExpanded(null);
            bump();
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <PageHeader
        title="柜子与格位"
        subtitle="位置结构决定你以后找不找得到东西"
        right={<IconButton icon="close" accessibilityLabel="关闭" onPress={() => router.back()} />}
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <SectionCard title="新建柜子">
            {/* 卡片自己扛左右边距：SectionCard 只给标题加边距，内容区裸露 */}
            <Card padded={false} style={styles.formCard}>
              <Gutter>
                <View style={styles.fieldRow}>
                  <Body style={styles.fieldLabel}>名称</Body>
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    placeholder="例：书房铁皮柜"
                    placeholderTextColor={Palette.ink4}
                    style={styles.input}
                    allowFontScaling={false}
                  />
                </View>
              </Gutter>
            </Card>

            <Gutter>
              <View style={styles.slotDraftHead}>
                <Meta tone="ink3">格位（可留空，之后再加）</Meta>
              </View>

              <View style={styles.slotInputRow}>
                <TextInput
                  value={slotInput}
                  onChangeText={setSlotInput}
                  placeholder="例：第一层"
                  placeholderTextColor={Palette.ink4}
                  style={[styles.input, styles.slotInput]}
                  onSubmitEditing={addDraft}
                  returnKeyType="done"
                  allowFontScaling={false}
                />
                <Button label="添加" tone="secondary" block={false} onPress={addDraft} />
              </View>

              {slotDrafts.length > 0 ? (
                <View style={styles.draftWrap}>
                  {slotDrafts.map((slot, i) => (
                    <Pressable
                      key={`${slot}-${i}`}
                      onPress={() => setSlotDrafts((prev) => prev.filter((_, idx) => idx !== i))}
                      style={styles.draftChip}>
                      <Label tone="ink2">{slot}</Label>
                      <Ionicons name="close" size={12} color={Palette.ink4} />
                    </Pressable>
                  ))}
                </View>
              ) : null}

              <Button
                label={saving ? '保存中…' : '创建柜子'}
                onPress={save}
                disabled={!canSave}
                size="lg"
                style={styles.saveAction}
              />
            </Gutter>
          </SectionCard>

          <SectionCard title={`已有柜子（${cabinetsState.data.length}）`}>
            {cabinetsState.loading ? (
              <Loading />
            ) : (
              <View style={styles.list}>
                {cabinetsState.data.map((cabinet) => {
                  const open = expanded === cabinet.id;
                  const nameChanged = cabinetName.trim().length > 0 && cabinetName.trim() !== cabinet.name;

                  return (
                    <Card key={cabinet.id} style={styles.cabinetCard}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${cabinet.name}，${cabinet.totalCount} 件物品`}
                        onPress={() => toggleCabinet(cabinet)}
                        style={styles.cabinetHead}>
                        <View style={styles.cabinetTitleWrap}>
                          <ItemText>{cabinet.name}</ItemText>
                          <Meta tone="ink3">
                            {cabinet.totalCount} 件 · {cabinet.slots.length} 个格位
                          </Meta>
                        </View>
                        <IconButton
                          icon="trash-outline"
                          accessibilityLabel={`删除 ${cabinet.name}`}
                          tone="ink3"
                          size={17}
                          onPress={() => removeCabinet(cabinet.id, cabinet.name, cabinet.totalCount)}
                        />
                        <Ionicons
                          name={open ? 'chevron-up' : 'chevron-down'}
                          size={16}
                          color={Palette.ink4}
                        />
                      </Pressable>

                      {open ? (
                        <View style={styles.cabinetBody}>
                          <View style={styles.editRow}>
                            <Body style={styles.fieldLabel}>名称</Body>
                            <TextInput
                              value={cabinetName}
                              onChangeText={setCabinetName}
                              placeholder={cabinet.name}
                              placeholderTextColor={Palette.ink4}
                              style={styles.input}
                              returnKeyType="done"
                              onSubmitEditing={() => void saveCabinetName(cabinet.id)}
                              allowFontScaling={false}
                            />
                          </View>
                          <View style={styles.editActions}>
                            <Button
                              label="保存名称"
                              block={false}
                              disabled={!nameChanged}
                              onPress={() => void saveCabinetName(cabinet.id)}
                              style={styles.editSave}
                            />
                            <Button
                              label="取消"
                              tone="secondary"
                              block={false}
                              onPress={() => setExpanded(null)}
                            />
                          </View>

                          <Meta tone="ink3" style={styles.slotHead}>
                            格位
                          </Meta>
                          {cabinet.slots.length > 0 ? (
                            <View style={styles.slotTagWrap}>
                              {cabinet.slots.map((s) => {
                                if (editingSlot === s.slot.id) {
                                  return (
                                    <View key={s.slot.id} style={styles.slotEditChip}>
                                      <TextInput
                                        value={slotName}
                                        onChangeText={setSlotName}
                                        autoFocus
                                        selectTextOnFocus
                                        style={styles.slotEditInput}
                                        returnKeyType="done"
                                        onSubmitEditing={() => void commitSlotName()}
                                        allowFontScaling={false}
                                      />
                                      <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="保存格位名"
                                        hitSlop={6}
                                        onPress={() => void commitSlotName()}>
                                        <Ionicons name="checkmark" size={16} color={Palette.brand} />
                                      </Pressable>
                                      <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`删除格位 ${s.slot.name}`}
                                        hitSlop={6}
                                        onPress={() => removeSlot(s.slot, s.itemCount)}>
                                        <Ionicons
                                          name="trash-outline"
                                          size={15}
                                          color={Palette.clay}
                                        />
                                      </Pressable>
                                    </View>
                                  );
                                }
                                return (
                                  <Pressable
                                    key={s.slot.id}
                                    accessibilityRole="button"
                                    accessibilityLabel={`编辑格位 ${s.slot.name}`}
                                    onPress={() => startEditSlot(s.slot)}
                                    style={[styles.slotChip, s.itemCount > 0 && styles.slotChipFull]}>
                                    <Label color={s.itemCount > 0 ? Palette.brand : Palette.ink2}>
                                      {s.itemCount > 0
                                        ? `${s.slot.name} · ${s.itemCount}`
                                        : s.slot.name}
                                    </Label>
                                  </Pressable>
                                );
                              })}
                            </View>
                          ) : (
                            <Meta tone="ink4">还没有格位</Meta>
                          )}

                          <View style={styles.slotInputRow}>
                            <TextInput
                              value={extraSlot}
                              onChangeText={setExtraSlot}
                              placeholder="新增格位，如：第二层"
                              placeholderTextColor={Palette.ink4}
                              style={[styles.input, styles.slotInput]}
                              onSubmitEditing={() => void addSlotTo(cabinet.id)}
                              returnKeyType="done"
                              allowFontScaling={false}
                            />
                            <Button
                              label="加格位"
                              tone="secondary"
                              block={false}
                              onPress={() => void addSlotTo(cabinet.id)}
                            />
                          </View>

                          {cabinet.slots.length > 0 ? (
                            <Meta tone="ink4" style={styles.slotHint}>
                              点格位可改名或删除
                            </Meta>
                          ) : null}
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
              点柜子展开后可改柜子名；点格位可改名或单独删除。
              删除柜子或格位都不会删除里面的物品 —— 只会把它们的位置记录清空。
            </Meta>
          </Gutter>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const useStyles = makeStyles((Palette) => ({
  flex: { flex: 1 },
  scroll: { paddingBottom: Space.xxxl * 2 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', minHeight: 50 },
  fieldLabel: { width: 60, color: Palette.ink2 },
  input: {
    flex: 1,
    padding: 0,
    ...(Type.body as object),
    color: Palette.ink,
  },
  slotDraftHead: { paddingTop: Space.lg, paddingBottom: Space.sm },
  slotInputRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  slotInput: {},
  draftWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs, paddingTop: Space.md },
  draftChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.md,
    paddingVertical: 5,
    borderRadius: Radius.chip,
    backgroundColor: Palette.inset,
  },
  saveAction: { marginTop: Space.lg },
  formCard: { marginHorizontal: GUTTER },
  list: { paddingHorizontal: GUTTER, gap: Space.md },
  cabinetCard: { padding: Space.lg },
  cabinetHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  cabinetTitleWrap: { flex: 1, gap: 2 },
  cabinetBody: { paddingTop: Space.md, gap: Space.md },
  editRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  editActions: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  editSave: { minWidth: 96 },
  slotHead: {},
  slotTagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  slotChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.md,
    paddingVertical: 5,
    borderRadius: Radius.chip,
    backgroundColor: Palette.inset,
  },
  slotChipFull: { backgroundColor: Palette.brandBg },
  slotEditChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.md,
    paddingVertical: 3,
    borderRadius: Radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.brand,
    backgroundColor: Palette.surface2,
  },
  slotEditInput: { minWidth: 72, padding: 0, ...(Type.body as object), color: Palette.ink },
  slotHint: {},
  hint: { paddingTop: Space.lg, lineHeight: 19 },
}));
