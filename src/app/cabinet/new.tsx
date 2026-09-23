/**
 * 格物 · 新建 / 管理柜子与格位
 *
 * 一次只做一件事：先给柜子起名，再往里加格位。
 * 允许「只有柜子没有格位」—— 强迫用户先建格位才能存东西，
 * 会让「位置」这个字段被彻底放弃使用。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import { Button, IconButton } from '@/components/ui/controls';
import { Loading, PlainTag } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, ItemText, Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import { createCabinet, createSlot, deleteLocation, listCabinetViews } from '@/lib/db/locations';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import { makeStyles } from '@/lib/theme';

export default function NewCabinetScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { dataVersion, bump } = useAppState();

  const cabinetsState = useAsyncData(() => listCabinetViews(), [dataVersion], []);

  const [name, setName] = useState('');
  const [slotDrafts, setSlotDrafts] = useState<string[]>([]);
  const [slotInput, setSlotInput] = useState('');
  const [saving, setSaving] = useState(false);

  /** 已存在的柜子展开状态，用于继续添加格位 */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [extraSlot, setExtraSlot] = useState('');

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

  const addSlotTo = async (cabinetId: string) => {
    const value = extraSlot.trim();
    if (!value) return;
    await createSlot(cabinetId, value);
    setExtraSlot('');
    bump();
  };

  const removeCabinet = (cabinetId: string, cabinetName: string, count: number) => {
    Alert.alert(
      `删除「${cabinetName}」？`,
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
                  return (
                    <Card key={cabinet.id} style={styles.cabinetCard}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                          setExpanded(open ? null : cabinet.id);
                          setExtraSlot('');
                        }}
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
                          {cabinet.slots.length > 0 ? (
                            <View style={styles.slotTagWrap}>
                              {cabinet.slots.map((s) => (
                                <PlainTag
                                  key={s.slot.id}
                                  text={
                                    s.itemCount > 0 ? `${s.slot.name} · ${s.itemCount}` : s.slot.name
                                  }
                                  tone={s.itemCount > 0 ? 'brand' : 'neutral'}
                                />
                              ))}
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
              删除柜子不会删除里面的物品 —— 只会把它们的位置记录清空。
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
  slotTagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  hint: { paddingTop: Space.lg },
}));
