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
import { PhotoViewer } from '@/components/domain/PhotoViewer';
import { Button, FormRow, IconButton } from '@/components/ui/controls';
import { Loading, PlainTag, StatusTag } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, Display, Label, Meta, Num } from '@/components/ui/typography';
import { GUTTER, Palette, Space } from '@/constants/theme';
import { formatDateCN, isJustAcquired } from '@/lib/date';
import { adjustQuantity, getItemView, setQuantity, softDeleteItem } from '@/lib/db/items';
import { listPhotos, promotePhoto } from '@/lib/db/photos';
import { formatMoney } from '@/lib/format';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { stockLabel, stockStateText } from '@/lib/stock';
import { useAppState } from '@/lib/store/app-state';
import type { ItemView, Photo, StockState } from '@/lib/types';
import { makeStyles } from '@/lib/theme';

/**
 * 库存状态 → 文字色。三档语义色锁死，与列表胶囊、底部面板同一套。
 * 写成函数而不是模块级常量表：Palette 是渲染期解析的代理。
 */
function stockColor(state: StockState): string {
  if (state === 'empty') return Palette.clay;
  if (state === 'low') return Palette.amber;
  if (state === 'ok') return Palette.sage;
  return Palette.ink3;
}

export default function ItemDetailScreen() {
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { dataVersion, bump } = useAppState();
  const [activePhoto, setActivePhoto] = useState(0);
  /** 全屏看图。详情页只有缩略条时读不清型号，全屏是这一页唯一的「看清」出口 */
  const [viewerOpen, setViewerOpen] = useState(false);
  /** 库存加减正在落库，用于挡住连点 */
  const [stockBusy, setStockBusy] = useState(false);

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

  /**
   * 库存 ±1。落库后只 bump 一次，剩下的交给 useAsyncData 重新读回来 ——
   * 不在这里自己维护一份数量副本，那会多出一个「和数据库不一致」的状态。
   *
   * 这里**不弹撤销条**：+1 就在旁边（这正是候选 E 的全部意义），
   * 点错了原地再点一下即可，比去底部找撤销条快。撤销条留给首页那种
   * 「操作完已经把面板关掉、按钮不在眼前」的场景。
   */
  const stepStock = useCallback(
    async (delta: number) => {
      if (!item || stockBusy) return;
      setStockBusy(true);
      try {
        await adjustQuantity(item.id, delta);
        bump();
      } finally {
        setStockBusy(false);
      }
    },
    [item, stockBusy, bump],
  );

  const emptyStock = useCallback(async () => {
    if (!item || stockBusy) return;
    setStockBusy(true);
    try {
      await setQuantity(item.id, 0);
      bump();
    } finally {
      setStockBusy(false);
    }
  }, [item, stockBusy, bump]);

  /**
   * 设为封面 = 把这张照片提到最前（`promotePhoto` 把它的 sort_order 变成最小值）。
   *
   * 列表封面取的是 sort_order 最小的那张，所以「提到最前」和「换封面」是同一件事。
   * 落库后只 bump 一次，让列表封面自己刷新 —— 不在这里改本地那份 photos，
   * 那会多出一个「和数据库不一致」的状态。
   */
  const setCover = useCallback(
    async (filePath: string) => {
      if (!item) return;
      await promotePhoto(item.id, filePath);
      bump();
    },
    [item, bump],
  );

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
        {/* 点大图进全屏：盘点、理赔时要看清型号，230px 的大图位读不出来 */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="全屏查看照片"
          disabled={photos.length === 0}
          onPress={() => setViewerOpen(true)}>
          <PhotoStage thumb={current?.thumbPath ?? null} name={item.name} height={230} />
        </Pressable>

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

        {/* 库存卡：候选 E 的核心改动 —— 从「滚动才看得到」提到
            照片正下方、持有成本卡之上。买了六瓶酱油的人打开这条记录，
            十次里有九次是为了改数量，所以它排第一。
            持有成本卡没被删，只是让了一位。
            ★ 只在启用了库存（quantity 非 null）时渲染：绝大多数物品是单件，
              给它们挂一张「未启用」的卡纯属噪音，还会把持有成本卡挤下去。 */}
        {item.quantity !== null ? (
          <View style={styles.stockWrap}>
            <Card style={styles.stockCard}>
              <View style={styles.stockHead}>
                <Label tone="ink3" style={styles.stockEyebrow}>
                  库存
                </Label>
                <Meta color={stockColor(item.stock)} style={styles.stockState}>
                  {stockStateText(item.quantity)}
                </Meta>
              </View>

              <View style={styles.stockMain}>
                <View style={styles.stockNumWrap}>
                  <Num color={stockColor(item.stock)} style={styles.stockNum}>
                    {item.quantity}
                  </Num>
                  <Meta tone="ink4" style={styles.stockUnit}>
                    件
                  </Meta>
                </View>
              </View>

              {/* 价格口径要印在卡里：看到「6 件」和「¥15.80」摆在一起，
                  第一反应一定是「总价 94.8？」，得当场说清单件价不随数量变 */}
              {item.price != null && item.quantity > 1 ? (
                <Meta tone="ink4" style={styles.stockPriceNote}>
                  {formatMoney(item.price)} 是单件价，日均成本也只按单件算
                </Meta>
              ) : null}

              <View style={styles.stockBtns}>
                <Button
                  label="用掉一件"
                  onPress={() => void stepStock(-1)}
                  disabled={stockBusy || item.quantity === 0}
                  block={false}
                  style={styles.stockBtn}
                />
                <Button
                  label="补一件"
                  tone="secondary"
                  onPress={() => void stepStock(1)}
                  disabled={stockBusy}
                  block={false}
                  style={styles.stockBtn}
                />
              </View>

              <View style={styles.stockLinks}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="标记用完"
                  disabled={stockBusy || item.quantity === 0}
                  hitSlop={8}
                  onPress={() => void emptyStock()}>
                  <Meta
                    tone={item.quantity === 0 ? 'ink4' : 'brand'}
                    style={styles.stockLinkText}>
                    标记用完
                  </Meta>
                </Pressable>
              </View>
            </Card>
          </View>
        ) : null}

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
              {/* 数量在字段表里再留一行：库存卡上的大数字是「快速改」，
                  这一行是「回头看」。没启用库存时 stockLabel 给空串，
                  FieldValue 会显示「未设置」—— 与其它空字段一致。
                  注意这里显示的是「剩 2」而不是「2 件」：同一个数字在
                  胶囊、面板、这里三处口径一致，用户不必对账。 */}
              <FormRow label="数量">
                <FieldValue text={stockLabel(item.quantity)} />
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
          <Card style={styles.fieldCard}>
            <Body tone={item.note ? 'ink' : 'ink3'}>{item.note?.trim() || '未设置'}</Body>
          </Card>
        </SectionCard>

        <SectionCard title="照片">
          <Card style={styles.fieldCard}>
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
          {/* 复制走的是「新建」而不是「编辑」：同款买第二个是最常见的录入场景，
              让它离详情页只有一步（PRD 把「一键复制」列为对冲录入疲劳的三项之一） */}
          <Button
            label="复制为新物品"
            tone="secondary"
            icon="copy-outline"
            onPress={() => router.push({ pathname: '/item/[id]/duplicate', params: { id: item.id } })}
          />
        </View>
      </ScrollView>

      <PhotoViewer
        visible={viewerOpen}
        photos={photos}
        initialIndex={activePhoto}
        itemName={item.name}
        onClose={() => setViewerOpen(false)}
        onIndexChange={setActivePhoto}
        onSetCover={setCover}
      />
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

  /* 库存卡。比持有成本卡矮一档、也不上品牌浅底 ——
     一张卡上只有一个焦点，两个都在抢就没有焦点了。
     卡片左右边距必须自己扛（Card 不负责），漏了不报错。 */
  stockWrap: { paddingHorizontal: GUTTER, paddingTop: Space.xxl },
  stockCard: { padding: Space.lg, gap: Space.xs },
  stockHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stockEyebrow: { letterSpacing: 1.2 },
  stockState: { fontSize: 12.5 },
  stockMain: { flexDirection: 'row', alignItems: 'flex-end' },
  stockNumWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  stockNum: { fontSize: 30, lineHeight: 36 },
  stockUnit: { marginBottom: 6 },
  stockPriceNote: { fontSize: 11.5, lineHeight: 16 },
  stockBtns: { flexDirection: 'row', gap: Space.sm, marginTop: Space.sm },
  stockBtn: { flex: 1 },
  stockLinks: { alignItems: 'center', marginTop: Space.sm },
  stockLinkText: { fontSize: 11.5 },

  fieldCard: { marginHorizontal: GUTTER },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  photoHint: { marginTop: Space.sm },
  footer: { paddingHorizontal: GUTTER, paddingTop: Space.xxl, gap: 2 },
  actions: { paddingHorizontal: GUTTER, paddingTop: Space.lg },
}));
