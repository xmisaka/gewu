/**
 * 格物 · 物品页（首页）
 *
 * 两条主线在这里合流：
 *   「记录」→ 列表视图，排序方式由页内切换器决定（默认最近变动）
 *   「找回」→ 位置视图按柜子/格位组织，这是收纳柜真正的差异化价值
 *
 * 位置视图刻意不占底部 Tab，用页头的「列表 / 位置」切换器承载；
 * 底部五个位置留给更高频的入口。
 *
 * 排序只作用于列表视图，且选择记在库里（见 lib/db/prefs）——
 * 「我习惯按什么看」是稳定的，不该每次开 App 都重选一遍。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { CabinetGrid } from '@/components/domain/CabinetGrid';
import { CategoryPickerModal } from '@/components/domain/CategoryPickerModal';
import { ItemRow } from '@/components/domain/ItemRow';
import {
  SortPickerModal,
  isItemSort,
  sortOptionOf,
} from '@/components/domain/SortPickerModal';
import { Collapse } from '@/components/ui/collapse';
import { Button, Chip, ChipRow, SearchField, Segmented } from '@/components/ui/controls';
import { EmptyState, LegendStrip, Loading, MetricStrip } from '@/components/ui/feedback';
import { Card, PageHeader, Screen } from '@/components/ui/layout';
import { Body, Heading, Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Space } from '@/constants/theme';
import { listCategories } from '@/lib/db/categories';
import { DEFAULT_ITEM_SORT, assignCategory, listItems } from '@/lib/db/items';
import { listCabinetViews } from '@/lib/db/locations';
import { PREF_ITEM_SORT, readPref, writePref } from '@/lib/db/prefs';
import { formatMoneyCompact } from '@/lib/format';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useScrollFold } from '@/lib/hooks/use-scroll-fold';
import { useAppState } from '@/lib/store/app-state';
import type { ItemSort, ItemView } from '@/lib/types';
import { makeStyles } from '@/lib/theme';

type ViewMode = 'list' | 'location';

/** 列表要在滚动里改头部高度，所以得用可动画的那份 FlatList */
const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<ItemView>);

export default function ItemsScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { stats, dataVersion, bump } = useAppState();

  /* 往下翻列表时把统计与筛选收起来，让位给物品本身；回到顶部一定放回来。
     两条路：onScroll 走 UI 线程跟手折叠，松手时再让 JS 侧确认一次位置 */
  const {
    progress: foldProgress,
    scrollHandler,
    settle: settleFold,
    expand: expandFold,
  } = useScrollFold();

  const [mode, setMode] = useState<ViewMode>('list');
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [sort, setSort] = useState<ItemSort>(DEFAULT_ITEM_SORT);
  const [sortOpen, setSortOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  /** 多选模式：低摩擦录入的补偿机制，用于批量补分类 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;

  // 排序方式记在库里，下次进来还是上次那档。读失败就安静地用默认值。
  useEffect(() => {
    let alive = true;
    readPref(PREF_ITEM_SORT)
      .then((saved) => {
        if (alive && isItemSort(saved)) setSort(saved);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const changeSort = useCallback((next: ItemSort) => {
    setSort(next);
    setSortOpen(false);
    void writePref(PREF_ITEM_SORT, next).catch(() => undefined);
  }, []);

  /* 换筛选 / 切视图时列表是程序化回到顶部的，不会有滚动回调来报位置 ——
     头部得主动放回来。搜索词除外：那会儿用户正在打字，不该有东西往上顶 */
  useEffect(() => {
    expandFold();
  }, [expandFold, mode, categoryId, sort]);

  const itemsState = useAsyncData(
    () => listItems({ query, categoryId, sort }),
    [query, categoryId, sort, dataVersion],
    [] as ItemView[],
  );
  const categoryState = useAsyncData(() => listCategories(), [dataVersion], []);
  const cabinetState = useAsyncData(() => listCabinetViews(), [dataVersion], []);

  const categories = useMemo(
    () => categoryState.data.filter((c) => c.itemCount > 0 || categoryId === c.id),
    [categoryState.data, categoryId],
  );

  const items = itemsState.data;
  const currentSort = sortOptionOf(sort);
  const activeCategory = useMemo(
    () => categories.find((c) => c.id === categoryId) ?? null,
    [categories, categoryId],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      listItems({ query, categoryId, sort }).catch(() => undefined),
      listCategories().catch(() => undefined),
      listCabinetViews().catch(() => undefined),
    ]);
    itemsState.reload();
    categoryState.reload();
    cabinetState.reload();
    setRefreshing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, categoryId, sort]);

  const toggleSelect = useCallback((item: ItemView) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const openItem = useCallback(
    (item: ItemView) => {
      if (selecting) {
        toggleSelect(item);
        return;
      }
      router.push({ pathname: '/item/[id]', params: { id: item.id } });
    },
    [selecting, toggleSelect, router],
  );

  const applyBulkCategory = async (nextCategoryId: string | null) => {
    await assignCategory([...selected], nextCategoryId);
    setPickerOpen(false);
    clearSelection();
    bump();
  };

  const headerRight = selecting ? (
    <Meta tone="brand" onPress={clearSelection} suppressHighlighting>
      取消
    </Meta>
  ) : (
    <Segmented<ViewMode>
      value={mode}
      onChange={setMode}
      options={[
        { value: 'list', label: '列表', icon: 'list-outline' },
        { value: 'location', label: '位置', icon: 'grid-outline' },
      ]}
    />
  );

  return (
    <Screen>
      <PageHeader
        title="我的物品"
        subtitle={
          stats.total > 0
            ? `在库 ${stats.total} 件 · 共 ${formatMoneyCompact(stats.totalValue)}`
            : '把家里的东西记进来，以后就找得到了'
        }
        right={headerRight}
      />

      {mode === 'list' ? (
        <>
          {/* 搜索始终留在屏上 —— 它是这一页唯一需要随手可及的操作。
              筛选生效时把它写进占位符：下面那行分类 chips 会被滚走的，
              用户总得有个地方能看见「我现在只看药品」 */}
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={activeCategory ? `在「${activeCategory.name}」中搜索` : undefined}
          />

          {/* 统计概览与筛选/排序一起构成那截「固定头部」，
              全展开时约 185dp，小屏上接近三分之一屏。滚动时整段收起。 */}
          <Collapse progress={foldProgress}>
            <MetricStrip
              metrics={[
                { label: '在库', value: String(stats.total) },
                { label: '总价值', value: formatMoneyCompact(stats.totalValue) },
                {
                  label: '即将到期',
                  value: String(stats.expiringCount),
                  tone: stats.expiringCount > 0 ? 'clay' : 'ink',
                },
              ]}
            />

            {/* 三项互斥、合计等于总数。空库时三行 0 没意义，直接不显示 */}
            {stats.total > 0 ? (
              <LegendStrip
                items={[
                  { tone: 'fine', label: '正常', count: stats.fineCount },
                  { tone: 'soon', label: '将到期', count: stats.soonCount },
                  { tone: 'overdue', label: '已过期', count: stats.overdueCount },
                ]}
              />
            ) : null}
          </Collapse>

          <Collapse progress={foldProgress}>
            <ChipRow>
              <Chip label="全部" selected={categoryId === null} onPress={() => setCategoryId(null)} />
              {categories.map((c) => (
                <Chip
                  key={c.id}
                  label={c.name}
                  count={c.itemCount}
                  selected={categoryId === c.id}
                  onPress={() => setCategoryId(categoryId === c.id ? null : c.id)}
                />
              ))}
            </ChipRow>

            <View style={styles.sortRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`排序方式：${currentSort.label}`}
                onPress={() => setSortOpen(true)}
                hitSlop={6}
                style={({ pressed }) => [styles.sortTrigger, pressed && styles.sortTriggerPressed]}>
                <Ionicons name="swap-vertical-outline" size={13} color={Palette.brand} />
                <Label tone="brand">排序 · {currentSort.label}</Label>
                <Ionicons name="caret-down" size={11} color={Palette.brand} />
              </Pressable>
              <Meta tone="ink4" numberOfLines={1} style={styles.sortHint}>
                {currentSort.hint}
              </Meta>
            </View>
          </Collapse>

          {/* 列表整体收进一张卡片：行与行之间只留发丝线，外轮廓由卡片给圆角，
              观感上从「一长条白底」变成「一张卡」，也顺带说明这张卡是可以滚的 */}
          <Card padded={false} style={styles.listCard}>
            <AnimatedFlatList
              data={items}
              onScroll={scrollHandler}
              /* 松手与惯性结束各确认一次：停在顶部附近就一定把头部放出来 */
              onScrollEndDrag={settleFold}
              onMomentumScrollEnd={settleFold}
              scrollEventThrottle={16}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <ItemRow
                  item={item}
                  selected={selected.has(item.id)}
                  selecting={selecting}
                  showSortOrder={sort === 'manual'}
                  onPress={openItem}
                  onLongPress={(it) => setSelected(new Set([it.id]))}
                />
              )}
              contentContainerStyle={styles.listInner}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Palette.brand} />
              }
              ListEmptyComponent={
                itemsState.loading ? (
                  <Loading />
                ) : query || categoryId ? (
                  <EmptyState
                    icon="search-outline"
                    title="没有找到"
                    description="换个词试试，或者清掉筛选条件"
                    actionLabel="清除筛选"
                    onAction={() => {
                      setQuery('');
                      setCategoryId(null);
                    }}
                  />
                ) : (
                  <EmptyState
                    icon="cube-outline"
                    title="还没有登记任何物品"
                    description="从最想找得到的那件开始，比如充电线、备用钥匙、药箱。"
                    actionLabel="录入第一件"
                    onAction={() => router.push('/compose')}
                  />
                )
              }
            />
          </Card>
        </>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Palette.brand} />
          }>
          <View style={styles.locationIntro}>
            <Heading>按位置找东西</Heading>
            <Meta tone="ink3" style={styles.locationHint}>
              你知道东西在哪，就不必再买一件
            </Meta>
          </View>

          {cabinetState.loading ? (
            <Loading />
          ) : cabinetState.data.length === 0 ? (
            <EmptyState
              icon="grid-outline"
              title="还没有登记柜子"
              description="先建一个柜子，再往里加格位。物品可以只挂到柜子，也可以精确到某一格。"
              actionLabel="新建柜子"
              onAction={() => router.push('/cabinet/new')}
            />
          ) : (
            <CabinetGrid
              cabinets={cabinetState.data}
              onOpen={(cabinet) => router.push({ pathname: '/cabinet/[id]', params: { id: cabinet.id } })}
              onAdd={() => router.push('/cabinet/new')}
            />
          )}
        </ScrollView>
      )}

      {selecting ? (
        <View style={styles.selectionBar}>
          <Body color={Palette.onAccent}>已选 {selected.size} 件</Body>
          <View style={styles.selectionActions}>
            <Button label="取消" tone="ghost" block={false} onPress={clearSelection} />
            <Button label="补分类" block={false} onPress={() => setPickerOpen(true)} />
          </View>
        </View>
      ) : null}

      <CategoryPickerModal
        visible={pickerOpen}
        categories={categoryState.data}
        onClose={() => setPickerOpen(false)}
        onPick={applyBulkCategory}
      />

      <SortPickerModal
        visible={sortOpen}
        value={sort}
        onClose={() => setSortOpen(false)}
        onPick={changeSort}
      />
    </Screen>
  );
}

const useStyles = makeStyles((Palette) => ({
  /** 位置视图用（整页滚动，要避开 Tab 栏） */
  listContent: { paddingBottom: 120 },
  /* 列表卡：左右让出边距，行的内容留白由 ItemRow 自己给 */
  listCard: { flex: 1, marginHorizontal: GUTTER, marginTop: Space.md },
  /** 卡片内列表：底部留白不必避开 Tab 栏，卡片底边就在它上面 */
  listInner: { paddingBottom: Space.xl },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.sm,
    paddingHorizontal: GUTTER,
    paddingTop: Space.md,
    paddingBottom: Space.xs,
  },
  sortTrigger: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  sortTriggerPressed: { opacity: 0.6 },
  sortHint: { flexShrink: 1 },
  locationIntro: { paddingHorizontal: GUTTER, paddingTop: Space.lg, paddingBottom: Space.sm },
  locationHint: { marginTop: 2 },
  selectionBar: {
    position: 'absolute',
    left: GUTTER,
    right: GUTTER,
    bottom: 96,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: Space.lg,
    paddingRight: Space.sm,
    paddingVertical: Space.sm,
    borderRadius: 14,
    backgroundColor: Palette.ink,
  },
  selectionActions: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
}));
