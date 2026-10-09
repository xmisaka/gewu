/**
 * 格物 · 统计洞察
 *
 * 数据早就在库里了 —— 价格、购买日期、分类、位置、入库时间。
 * 这一页只是把它们摊开：钱花在哪、每天在烧多少、柜子塞到几成、最近半年买得多了还是少了。
 *
 * ── 几条钉死的规矩 ─────────────────────────────────────────
 *
 * ★ 入口在「我的 → 整理」，**不占底部第六格**：底部五格是「找东西」的骨架，
 *   往里塞统计会把骨架打乱（与 AI 助手不占第六格同一条理由）。
 *
 * ★ **不引图表库**。横向条、格位方块、月度柱全部用 View 拼 —— 一为体积，
 *   二为它们能直接吃主题令牌，换肤时不会有一块图还挂在旧配色上。
 *
 * ★ **两处口径必须写在页面上**：顶部「总价值」算的是所有有价格的，
 *   「日均合计」只算价格与购买日期都齐备的那部分 —— 两个数的样本不一样。
 *   不写清楚，用户会拿日均去对逐件相加，对不上就以为数据错了。
 *
 * ★ 排行条以**最大值**为满格，不是占比；只给榜首一根品牌色。理由见 lib/stats.ts 头注释。
 */

import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { SlotDots } from '@/components/domain/CabinetGrid';
import { IconButton } from '@/components/ui/controls';
import { EmptyState, Loading, MetricStrip } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen, ScreenScroll, SectionCard } from '@/components/ui/layout';
import { ItemText, Label, Meta } from '@/components/ui/typography';
import { Space } from '@/constants/theme';
import { listItems } from '@/lib/db/items';
import { listCabinetViews } from '@/lib/db/locations';
import { formatCount, formatDailyCost, formatMoney, formatMoneyCompact } from '@/lib/format';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import {
  buildMonthSeries,
  buildValueBars,
  describePeak,
  monthRatios,
  rankCabinets,
  rankDailyCost,
  summarize,
} from '@/lib/stats';
import { useAppState } from '@/lib/store/app-state';
import { makeStyles } from '@/lib/theme';
import type { CabinetView, ItemView } from '@/lib/types';

/**
 * 一张「排行」卡至少要有几条才值得出现。
 *
 * 只有一两行的排行不是排行，是「空卡换了个样子」—— 四个 ¥0、两根零长条，
 * 看起来像坏了。稀有到此为止的卡片整张隐藏，比显示一张半空的强。
 */
const MIN_RANK_ROWS = 3;

export default function StatsScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { dataVersion } = useAppState();

  const itemsState = useAsyncData(() => listItems(), [dataVersion], [] as ItemView[]);
  const cabinetState = useAsyncData(() => listCabinetViews(), [dataVersion], [] as CabinetView[]);

  const items = itemsState.data;
  /** 时间轴在一进页面时定住，免得跨零点时柱子和标签对不上 */
  const now = useMemo(() => new Date(), []);

  const summary = useMemo(() => summarize(items), [items]);
  const valueBars = useMemo(() => buildValueBars(items), [items]);
  const costRank = useMemo(() => rankDailyCost(items), [items]);
  const cabinets = useMemo(() => rankCabinets(cabinetState.data), [cabinetState.data]);
  const months = useMemo(() => buildMonthSeries(items, now), [items, now]);
  const ratios = useMemo(() => monthRatios(months), [months]);
  const peak = useMemo(() => describePeak(months), [months]);
  const peakIndex = useMemo(
    () => (peak ? months.findIndex((m) => m.label === peak.label && m.count === peak.count) : -1),
    [months, peak],
  );

  const loading = itemsState.loading && items.length === 0;

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
      </View>
      <PageHeader title="统计洞察" />

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState
          icon="stats-chart-outline"
          title="还没有可统计的东西"
          description="先记几件东西，这里会告诉你钱花在哪、每天在烧多少、柜子塞到几成。"
          actionLabel="去记一件"
          onAction={() => router.push('/compose')}
        />
      ) : (
        <ScreenScroll>
          {/* ---------------- 总览 ---------------- */}
          <Gutter>
            <Card padded={false}>
              <MetricStrip
                framed={false}
                metrics={[
                  { label: '在库物品', value: formatCount(summary.total) },
                  { label: '总价值', value: formatMoneyCompact(summary.totalValue) },
                  {
                    label: '日均持有成本',
                    value: formatDailyCost(summary.dailyTotal),
                    tone: 'brand',
                  },
                ]}
              />
            </Card>
            <Meta tone="ink4" style={styles.caliber}>
              总价值按 {summary.pricedCount} 件有价格的算；日均合计只算同时填了价格与购买日期的{' '}
              {summary.dailySampleCount} 件。
            </Meta>
          </Gutter>

          {/* ---------------- 钱花在哪 ---------------- */}
          {summary.pricedCount === 0 ? (
            <SectionCard title="钱花在哪">
              <Gutter>
                <Card>
                  <Meta tone="ink3">
                    这 {summary.total} 件都还没填价格。补上价格之后，这里会告诉你哪一类最烧钱。
                  </Meta>
                </Card>
              </Gutter>
            </SectionCard>
          ) : valueBars.bars.length >= MIN_RANK_ROWS ? (
            <SectionCard
              title="钱花在哪"
              right={<Meta tone="ink4">按分类合计</Meta>}>
              <Gutter>
                <Card padded={false}>
                  {valueBars.bars.map((bar, i) => (
                    <View key={bar.label} style={[styles.rankRow, i > 0 && styles.rowBorder]}>
                      <Meta tone="ink2" style={styles.barLabel} numberOfLines={1}>
                        {bar.label}
                      </Meta>
                      <View style={styles.barTrack}>
                        {/* 满格基准是榜首那一类，不是总额 —— 见 lib/stats.ts */}
                        <View
                          style={[
                            styles.barFill,
                            i === 0 && styles.barFillTop,
                            { width: `${Math.round(bar.ratio * 100)}%` },
                          ]}
                        />
                      </View>
                      <Label style={styles.rankValue} numberOfLines={1}>
                        {formatMoney(bar.value)}
                      </Label>
                    </View>
                  ))}
                  {/* 汇总项：永远排最后、数字转灰。插在中间会打断「谁最烧钱」的阅读顺序 */}
                  {valueBars.restLabel ? (
                    <View style={[styles.rankRow, styles.rowBorder, styles.restRow]}>
                      <Meta tone="ink3" style={styles.barLabel} numberOfLines={1}>
                        {valueBars.restLabel}
                      </Meta>
                      <View style={styles.barTrack}>
                        <View
                          style={[styles.barFill, { width: `${Math.round(valueBars.restRatio * 100)}%` }]}
                        />
                      </View>
                      <Label tone="ink3" style={styles.rankValue} numberOfLines={1}>
                        {formatMoney(valueBars.restValue)}
                      </Label>
                    </View>
                  ) : null}
                </Card>
                <Meta tone="ink4" style={styles.caliber}>
                  条长以最高的一类为满格。合计 {formatMoneyCompact(valueBars.total)} 与上方「总价值」同源。
                </Meta>
              </Gutter>
            </SectionCard>
          ) : null}

          {/* ---------------- 每天在烧多少钱 ---------------- */}
          {summary.pricedCount > 0 && costRank.rows.length >= MIN_RANK_ROWS ? (
            <SectionCard
              title="每天在烧多少钱"
              right={<Meta tone="ink4">持有成本最高的 {costRank.rows.length} 件</Meta>}>
              <Gutter>
                <Card padded={false}>
                  {costRank.rows.map((row, i) => (
                    <View key={row.id} style={[styles.costRow, i > 0 && styles.rowBorder]}>
                      <ItemText style={styles.costName} numberOfLines={1}>
                        {row.name}
                      </ItemText>
                      {/* 摆出天数而不是再给一个金额：日均高有两种原因 —— 贵，还是刚买 */}
                      <Meta tone="ink3">{row.holdingDays} 天</Meta>
                      <Label style={styles.costValue} numberOfLines={1}>
                        {formatDailyCost(row.dailyCost)}
                        <Label tone="ink3">/天</Label>
                      </Label>
                    </View>
                  ))}
                </Card>
                <Meta tone="ink4" style={styles.caliber}>
                  与详情页成本卡同一套算法；缺价格或购买日期的物品不出现在这里。
                </Meta>
              </Gutter>
            </SectionCard>
          ) : null}

          {/* ---------------- 柜子 ---------------- */}
          {cabinets.length >= MIN_RANK_ROWS ? (
            <SectionCard
              title="柜子都塞满了吗"
              right={<Meta tone="ink4">按占用率</Meta>}>
              <Gutter>
                <Card padded={false}>
                  {cabinets.map((cab, i) => (
                    <View key={cab.id} style={[styles.cabRow, i > 0 && styles.rowBorder]}>
                      <Meta tone="ink2" style={styles.cabName} numberOfLines={1}>
                        {cab.name}
                      </Meta>
                      {/* 与柜子页同一排方块、同一个组件 —— 同一件事两页必须长一样 */}
                      <SlotDots slots={cab.slots} />
                      <Label style={styles.cabCount}>
                        {cab.occupiedSlots}/{cab.totalSlots}
                      </Label>
                    </View>
                  ))}
                </Card>
                <Meta tone="ink4" style={styles.caliber}>
                  按占用率排，不按件数 —— 12 格里放 8 件的柜子，比 6 格里放 5 件的更空。
                </Meta>
              </Gutter>
            </SectionCard>
          ) : null}

          {/* ---------------- 最近半年 ---------------- */}
          <SectionCard title="最近半年" right={<Meta tone="ink4">按入库时间</Meta>}>
            <Gutter>
              <Card>
                <View style={styles.cols}>
                  {months.map((m, i) => (
                    <View key={m.key} style={styles.col}>
                      <Label tone={i === peakIndex ? 'brand' : 'ink3'} style={styles.colCount}>
                        {m.count}
                      </Label>
                      <View style={styles.colTrack}>
                        <View
                          style={[
                            styles.colFill,
                            i === peakIndex && styles.colFillPeak,
                            { height: `${Math.round(ratios[i] * 100)}%` },
                          ]}
                        />
                      </View>
                      <Meta tone="ink4" style={styles.colLabel}>
                        {m.label}
                      </Meta>
                    </View>
                  ))}
                </View>
              </Card>
              <Meta tone="ink4" style={styles.caliber}>
                {peak
                  ? `买得最多的是 ${peak.label}，${peak.count} 件。`
                  : '这半年还没有新增。'}
              </Meta>
            </Gutter>
          </SectionCard>
        </ScreenScroll>
      )}
    </Screen>
  );
}

const useStyles = makeStyles((Palette) => ({
  topBar: { flexDirection: 'row', alignItems: 'center', paddingLeft: Space.sm, paddingTop: Space.xs },

  /* 口径小字：比正文再小一档、比 ink3 再淡一档。
     它必须存在（两个数的样本不一样），但绝不能抢走数字的注意力 */
  caliber: { marginTop: Space.sm, lineHeight: 17 },

  /* 一份「行」的公共骨：白卡里每行之间只画一条发丝线 */
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Palette.line3 },

  /* ---------------- 分类价值条 ---------------- */
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.md, paddingVertical: Space.sm },
  restRow: { backgroundColor: Palette.surface2 },
  barLabel: { width: 64 },
  barTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: Palette.line3, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: Palette.ink4 },
  /* 只给榜首一根品牌色：强调色只标「要你先看的那个」，整页红棕就没人看了 */
  barFillTop: { backgroundColor: Palette.brand },
  rankValue: { width: 66, textAlign: 'right', fontVariant: ['tabular-nums'] },

  /* ---------------- 日均成本 ---------------- */
  costRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.md, paddingVertical: Space.sm },
  costName: { flex: 1 },
  costValue: { fontVariant: ['tabular-nums'] },

  /* ---------------- 柜子 ---------------- */
  cabRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.md, paddingVertical: Space.sm },
  cabName: { flex: 1 },
  cabCount: { fontVariant: ['tabular-nums'] },

  /* ---------------- 月度柱 ---------------- */
  cols: { flexDirection: 'row', alignItems: 'flex-end', gap: Space.sm },
  col: { flex: 1, alignItems: 'center' },
  colCount: { fontVariant: ['tabular-nums'], marginBottom: 3 },
  colTrack: { width: '100%', height: 56, justifyContent: 'flex-end' },
  colFill: { width: '100%', minHeight: 3, borderRadius: 4, backgroundColor: Palette.line3 },
  colFillPeak: { backgroundColor: Palette.brand },
  colLabel: { marginTop: Space.xs },
}));
