/**
 * 格物 · 物品详情
 *
 * 页面重心是「持有成本卡」—— 全 App 唯一带情绪回报的信息，
 * 也是唯一允许大面积品牌浅底的地方。它独立成卡，不混进字段表：
 * 混进去就会被淹没成一堆灰字里的一行。
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { PhotoStage, PhotoThumb } from '@/components/domain/media';
import { Button, FormRow, IconButton } from '@/components/ui/controls';
import { Loading, PlainTag, StatusTag } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, Display, Label, Meta, Num } from '@/components/ui/typography';
import { GUTTER, Space } from '@/constants/theme';
import { formatDateCN, isJustAcquired } from '@/lib/date';
import { getItemView, softDeleteItem } from '@/lib/db/items';
import { listPhotos } from '@/lib/db/photos';
import { formatMoney } from '@/lib/format';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import type { ItemView, Photo } from '@/lib/types';
import { makeStyles } from '@/lib/theme';

export default function ItemDetailScreen() {
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { dataVersion, bump } = useAppState();
  const [activePhoto, setActivePhoto] = useState(0);

  const itemState = useAsyncData(() => getItemView(id), [id, dataVersion], null as ItemView | null);
  const photoState = useAsyncData(() => listPhotos(id), [id, dataVersion], [] as Photo[]);

  const item = itemState.data;

  const onDelete = useCallback(() => {
    if (!item) return;
    Alert.alert('移入回收站？', `「${item.name}」会被移到回收站，照片与记录都还在，可以随时恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '移入回收站',
        style: 'destructive',
        onPress: async () => {
          await softDeleteItem(item.id);
          bump();
          router.back();
        },
      },
    ]);
  }, [item, bump, router]);

  if (itemState.loading && !item) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  if (!item) {
    return (
      <Screen>
        <PageHeader title="物品不存在" right={<IconButton icon="close" accessibilityLabel="返回" onPress={() => router.back()} />} />
        <Gutter>
          <Body tone="ink3">它可能已被彻底删除。</Body>
        </Gutter>
      </Screen>
    );
  }

  const photos = photoState.data;
  const current = photos[Math.min(activePhoto, Math.max(photos.length - 1, 0))];

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
        <View style={styles.topActions}>
          <IconButton
            icon="create-outline"
            accessibilityLabel="编辑"
            onPress={() => router.push({ pathname: '/item/[id]/edit', params: { id: item.id } })}
          />
          <IconButton icon="trash-outline" accessibilityLabel="删除" tone="ink3" onPress={onDelete} />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <PhotoStage thumb={current?.thumbPath ?? null} name={item.name} height={230} />

        {photos.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.thumbStrip}>
            {photos.map((p, i) => (
              <Pressable key={p.id} onPress={() => setActivePhoto(i)}>
                <PhotoThumb
                  thumb={p.thumbPath}
                  name={item.name}
                  size={48}
                  style={i === activePhoto ? styles.thumbActive : undefined}
                />
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.identity}>
          <Display style={styles.name}>{item.name}</Display>
          <View style={styles.tagLine}>
            {item.categoryName ? (
              <PlainTag text={item.categoryName} tone="brand" />
            ) : (
              <PlainTag text="未分类" />
            )}
            {item.locationName ? (
              <PlainTag
                text={item.cabinetName ? `${item.cabinetName} · ${item.locationName}` : item.locationName}
                icon="location-outline"
              />
            ) : null}
            {item.expiry !== 'none' ? (
              <StatusTag
                state={item.expiry}
                text={
                  item.daysToExpiry != null && item.daysToExpiry < 0
                    ? `过期 ${Math.abs(item.daysToExpiry)} 天`
                    : item.daysToExpiry === 0
                      ? '今天到期'
                      : `还剩 ${item.daysToExpiry} 天`
                }
              />
            ) : null}
          </View>
        </View>

        {/* 持有成本卡：任一前提缺失则整卡隐藏，绝不显示 ¥0.00 / 天 */}
        {item.dailyCost != null && item.holdingDays != null ? (
          <View style={styles.costWrap}>
            <Card tone="brandBg" style={styles.costCard}>
              <View style={styles.costHead}>
                <Label tone="brand" style={styles.costEyebrow}>
                  持有成本
                </Label>
                <Meta tone="brand" style={styles.costDays}>
                  {isJustAcquired(item.purchaseDate) ? '刚入手' : `已经陪你 ${item.holdingDays} 天`}
                </Meta>
              </View>

              <View style={styles.costMain}>
                <Num tone="brand">{formatMoney(item.dailyCost, { decimals: 'always' })}</Num>
                <Body tone="brand" style={styles.costUnit}>
                  / 天
                </Body>
              </View>

              <Body tone="brand" style={styles.costNote}>
                {costNoteOf(item)}
              </Body>
            </Card>
          </View>
        ) : null}

        <SectionCard title="详细字段">
          <Card padded={false} style={styles.fieldCard}>
            <Gutter>
              <FormRow label="分类">{<FieldValue text={item.categoryName} />}</FormRow>
              <FormRow label="位置">
                <FieldValue
                  text={
                    item.locationName
                      ? item.cabinetName
                        ? `${item.cabinetName} · ${item.locationName}`
                        : item.locationName
                      : null
                  }
                />
              </FormRow>
              <FormRow label="购买日期">
                <FieldValue text={item.purchaseDate ? formatDateCN(item.purchaseDate) : null} />
              </FormRow>
              <FormRow label="价格">
                <FieldValue text={item.price != null ? formatMoney(item.price) : null} />
              </FormRow>
              <FormRow label="过期时间">
                <FieldValue text={item.expireDate ? formatDateCN(item.expireDate) : null} />
              </FormRow>
              <FormRow label="品牌">
                <FieldValue text={item.brand} />
              </FormRow>
              <FormRow label="型号">
                <FieldValue text={item.model} />
              </FormRow>
              <FormRow label="标签" last={item.tags.length === 0}>
                {item.tags.length > 0 ? (
                  <View style={styles.tagWrap}>
                    {item.tags.map((t) => (
                      <PlainTag key={t} text={t} />
                    ))}
                  </View>
                ) : (
                  <FieldValue text={null} />
                )}
              </FormRow>
            </Gutter>
          </Card>
        </SectionCard>

        <SectionCard title="备注">
          <Card>
            <Body tone={item.note ? 'ink' : 'ink3'}>{item.note?.trim() || '未设置'}</Body>
          </Card>
        </SectionCard>

        <SectionCard title="照片">
          <Card>
            <Body tone={photos.length > 0 ? 'ink' : 'ink3'}>
              {photos.length > 0 ? `${photos.length} 张，已存入 App 沙盒` : '未设置'}
            </Body>
            <Meta tone="ink4" style={styles.photoHint}>
              照片保存在应用内，删除系统相册不会影响这里
            </Meta>
          </Card>
        </SectionCard>

        <View style={styles.footer}>
          <Meta tone="ink4">录入于 {formatDateCN(isoOf(item.createdAt))}</Meta>
          {item.updatedAt !== item.createdAt ? (
            <Meta tone="ink4">最近修改 {formatDateCN(isoOf(item.updatedAt))}</Meta>
          ) : null}
        </View>

        <View style={styles.actions}>
          <Button
            label="编辑这件物品"
            tone="secondary"
            icon="create-outline"
            onPress={() => router.push({ pathname: '/item/[id]/edit', params: { id: item.id } })}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

/* ------------------------------------------------------------ 局部组件 */

function FieldValue({ text }: { text: string | null | undefined }) {
  const filled = !!text && text.trim().length > 0;
  return <Body tone={filled ? 'ink' : 'ink3'}>{filled ? text : '未设置'}</Body>;
}

function costNoteOf(item: ItemView): string {
  if (item.price == null || item.holdingDays == null) return '';
  const days = item.holdingDays;
  if (days < 30) return `买来 ${days} 天，还在新鲜期`;
  if (days < 365) return `${formatMoney(item.price)} 摊到 ${days} 天，每天约 ${formatMoney(item.dailyCost, { decimals: 'always' })}`;
  return `${formatMoney(item.price)} 分摊到 ${(days / 365).toFixed(1)} 年，越来越划算`;
}

/** 时间戳 → YYYY-MM-DD，仅用于中文日期展示 */
function isoOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const useStyles = makeStyles((Palette) => ({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER - Space.sm,
    paddingVertical: Space.sm,
  },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  scroll: { paddingBottom: Space.xxxl * 2 },
  thumbStrip: { gap: Space.sm, paddingHorizontal: GUTTER, paddingTop: Space.md },
  thumbActive: { borderWidth: 2, borderColor: Palette.brand },
  identity: { paddingHorizontal: GUTTER, paddingTop: Space.xl, gap: Space.md },
  name: { fontSize: 27 },
  tagLine: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, alignItems: 'center' },

  costWrap: { paddingHorizontal: GUTTER, paddingTop: Space.xxl },
  costCard: { padding: Space.xl, gap: Space.sm },
  costHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  costEyebrow: { letterSpacing: 1.2 },
  costDays: { fontSize: 12.5 },
  costMain: { flexDirection: 'row', alignItems: 'flex-end', gap: Space.xs, marginTop: Space.xs },
  costUnit: { marginBottom: 5 },
  costNote: { fontSize: 12.5, opacity: 0.85, marginTop: Space.xs },

  fieldCard: { marginHorizontal: GUTTER },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  photoHint: { marginTop: Space.sm },
  footer: { paddingHorizontal: GUTTER, paddingTop: Space.xxl, gap: 2 },
  actions: { paddingHorizontal: GUTTER, paddingTop: Space.lg },
}));
