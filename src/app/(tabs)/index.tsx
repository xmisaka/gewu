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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { CabinetGrid } from '@/components/domain/CabinetGrid';
import { CategoryPickerModal } from '@/components/domain/CategoryPickerModal';
import { ItemRow } from '@/components/domain/ItemRow';
import { LocationPickerModal } from '@/components/domain/LocationPickerModal';
import { StockSheet, type StockSheetTarget } from '@/components/domain/StockSheet';
import {
  SortPickerModal,
  isItemSort,
  sortOptionOf,
} from '@/components/domain/SortPickerModal';
import { Chip, ChipRow, IconButton, SearchField, Segmented } from '@/components/ui/controls';
import { EmptyState, LegendStrip, Loading, MetricStrip, UndoBar, type UndoAction } from '@/components/ui/feedback';
import { Card, PageHeader, Screen } from '@/components/ui/layout';
import { Body, Heading, Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import { describeRemaining } from '@/lib/date';
import { SupporterGateSheet } from '@/components/domain/SupporterGateSheet';
import { listCategories } from '@/lib/db/categories';
import {
  DEFAULT_ITEM_SORT,
  adjustQuantity,
  assignCategory,
  assignLocation,
  listItems,
  setManualOrder,
  setQuantity,
  softDeleteMany,
} from '@/lib/db/items';
import { listCabinetViews } from '@/lib/db/locations';
import { PREF_ITEM_SORT, readPref, writePref } from '@/lib/db/prefs';
import { formatMoneyCompact } from '@/lib/format';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useDebouncedSearch } from '@/lib/hooks/use-debounced-search';
import { filterCabinets } from '@/lib/search';
import { nextQuantity, stockLabel } from '@/lib/stock';
import { useAppState } from '@/lib/store/app-state';
import { useEntitlement } from '@/lib/store/entitlement';
import type { ItemSort, ItemView } from '@/lib/types';
import { makeStyles } from '@/lib/theme';

type ViewMode = 'list' | 'location';

export default function ItemsScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { stats, dataVersion, bump } = useAppState();
  const { entitled } = useEntitlement();

  /* 统计、图例、分类筛选、排序这一整段，是列表的「头部」而不是页面的固定区。
     做法是把它们交给 FlatList 的 ListHeaderComponent —— 滚下去时随原生滚动一起离开
     屏幕，回到顶部自然又回来。

     为什么不再用「跟手折叠高度」那一套：折叠要动 height，而 height 是布局属性，
     240ms 的过渡里每一帧都要重排整页（头部 + 卡片 + 列表），列表卡本身还带圆角裁剪，
     等于每帧重建一次离屏层。实测那几帧里出现了「同一行文字被复制成两层、偏移 3–4px」
     的重影。现在滚动完全由原生列表驱动，一帧布局都不用做。 */
  const listRef = useRef<FlatList<ItemView>>(null);

  const [mode, setMode] = useState<ViewMode>('list');
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [sort, setSort] = useState<ItemSort>(DEFAULT_ITEM_SORT);
  const [sortOpen, setSortOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);

  /** 位置视图的搜索词。柜子只有几十个，纯前端筛，不必等数据库 */
  const [locationQuery, setLocationQuery] = useState('');

  /** 正在重排的那一行，用于挡住连点 */
  const [movingId, setMovingId] = useState<string | null>(null);

  /** 多选模式：低摩擦录入的补偿机制，用于批量补分类 / 改位置 / 删除 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;

  /** 库存面板正对着的那件物品；null = 面板关着 */
  const [stockTarget, setStockTarget] = useState<StockSheetTarget | null>(null);
  /** 面板里的操作正在进行，用于挡住连点（连点两下很容易真的扣掉两件） */
  const [stockBusy, setStockBusy] = useState(false);
  /** 撤销条。★ 只在面板关掉之后才浮出来 —— 见下面 closeStock 的注释 */
  const [undo, setUndo] = useState<UndoAction | null>(null);
  /** 面板打开时那件物品的原始数量；撤销条回滚的是整段操作，不是最后一次点击 */
  const [stockBase, setStockBase] = useState<number | null>(null);

  /** 免费档点「问一问」或「语音」时弹的门控浮层 */
  const [gateOpen, setGateOpen] = useState(false);

  /**
   * 搜索框右侧那两格，两个都要门控。
   *
   * ★ 2026-10-09：语音从「免费」改为支持者功能。原来的理由 ——
   *   「不联网、不要 Key、不申请权限，锁它等于给『记东西』本身加门槛」——
   *   技术上仍然成立（这条链路确实零成本），改的是产品定位：
   *   语音与识物、问一问同属「智能录入」，一档解锁。
   *   要回退只需把 openVoice 的门控去掉，其余不用动。
   * 问一问依赖库内检索的整理能力（以及可选的模型润色）。
   *
   * 两个都写成字面量路由（而不是一个接 path 参数的通用函数）：
   * 传变量的形式过不了 expo-router 的 typed routes。
   */
  const openAsk = useCallback(() => {
    if (!entitled) {
      setGateOpen(true);
      return;
    }
    router.push('/ask');
  }, [entitled, router]);

  const openVoice = useCallback(() => {
    if (!entitled) {
      setGateOpen(true);
      return;
    }
    router.push('/voice');
  }, [entitled, router]);

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

  /* 输入框是受控的、每次按键立刻回显；送给查询的那个值压了一档 ——
     库不大，但没理由每敲一个字就跑一次 SQLite。清空立即生效 */
  const debouncedQuery = useDebouncedSearch(query);

  /* 换筛选 / 换排序 / 改搜索词之后，列表要回到顶部。
     折叠头部现在长在列表里，停在半路就等于用户看不见自己刚改了什么 ——
     筛选条本身已经滚出屏幕了，结果却从中间开始显示，会让人以为「点了没反应」 */
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [mode, debouncedQuery, categoryId, sort]);

  /* 手动排序的箭头只在「看得见整份列表」时才给。
     带着筛选调顺序，被过滤掉的物品会插在中间，用户看着像是点了没反应 */
  const manualReorder = sort === 'manual' && debouncedQuery.length === 0 && categoryId === null;

  const itemsState = useAsyncData(
    () => listItems({ query: debouncedQuery, categoryId, sort }),
    [debouncedQuery, categoryId, sort, dataVersion],
    [] as ItemView[],
  );
  const categoryState = useAsyncData(() => listCategories(), [dataVersion], []);
  const cabinetState = useAsyncData(() => listCabinetViews(), [dataVersion], []);

  const cabinets = useMemo(
    () => filterCabinets(cabinetState.data, locationQuery),
    [cabinetState.data, locationQuery],
  );

  const categories = useMemo(
    () => categoryState.data.filter((c) => c.itemCount > 0 || categoryId === c.id),
    [categoryState.data, categoryId],
  );

  const items = itemsState.data;
  const currentSort = sortOptionOf(sort);
  const sortHint =
    sort !== 'manual'
      ? currentSort.hint
      : manualReorder
        ? '用右侧箭头直接调顺序'
        : '清掉搜索与分类筛选后，可用箭头调顺序';
  const activeCategory = useMemo(
    () => categories.find((c) => c.id === categoryId) ?? null,
    [categories, categoryId],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      listItems({ query: debouncedQuery, categoryId, sort }).catch(() => undefined),
      listCategories().catch(() => undefined),
      listCabinetViews().catch(() => undefined),
    ]);
    itemsState.reload();
    categoryState.reload();
    cabinetState.reload();
    setRefreshing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, categoryId, sort]);

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

  const applyBulkLocation = async (nextLocationId: string | null) => {
    await assignLocation([...selected], nextLocationId);
    setLocationPickerOpen(false);
    clearSelection();
    bump();
  };

  /* 批量删除走的是软删除，照片与字段都留着 —— 确认文案必须说清
     这是「进回收站」而不是抹掉，否则没人敢按 */
  const confirmBulkDelete = () => {
    const count = selected.size;
    Alert.alert('移入回收站？', `选中的 ${count} 件物品会进入回收站，之后可以整批恢复。`, [
      { text: '取消', style: 'cancel' },
      { text: '移入回收站', style: 'destructive', onPress: () => void runBulkDelete() },
    ]);
  };

  const runBulkDelete = async () => {
    await softDeleteMany([...selected]);
    clearSelection();
    bump();
  };

  /**
   * 把某一行上移 / 下移一格，然后把整份顺序一次性写回。
   *
   * 为什么重写整份而不是只改这两行：sort_order 只在手动档下有意义，
   * 整体归一成 10 的倍数之后，后续插队永远有缝隙可用，也不会出现
   * 「一半有值一半为空」那种自己都说不清的中间态。
   */
  const moveItem = useCallback(
    async (itemId: string, delta: -1 | 1) => {
      if (movingId) return;
      const ids = items.map((i) => i.id);
      const from = ids.indexOf(itemId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= ids.length) return;

      ids.splice(to, 0, ...ids.splice(from, 1));
      setMovingId(itemId);
      try {
        await setManualOrder(ids);
        bump();
      } catch {
        // 写失败就维持原顺序，不弹框：这是随手可再试一次的操作
      } finally {
        setMovingId(null);
      }
    },
    [items, movingId, bump],
  );

  /* ---------------------------------------------------------- 库存 */

  /**
   * 打开库存面板。只有启用了库存的物品才会走到这里 ——
   * 单件物品的行尾根本没有那个胶囊，点不出这个回调。
   */
  const openStock = useCallback((item: ItemView) => {
    if (item.quantity === null) return;
    setStockTarget({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      expireText: describeRemaining(item.daysToExpiry),
    });
    // 记下面板刚打开时的数量：撤销条回滚的是**整段操作**，
    // 不是最后一次点击 —— 连点三下 −1 之后按撤销，应该整段退回去
    setStockBase(item.quantity);
  }, []);

  /**
   * 关面板。★ 撤销条**只在这里**浮出来。
   *
   * 面板开着的时候不弹撤销条：它贴在屏幕底部，会和面板叠在一起，
   * 两个东西抢同一块地方，还容易被当成面板的一部分去点。
   * 而且面板上的大数字本身就是确认，用户看得见自己刚做了什么。
   *
   * 计时也从这一刻才开始 —— 若在面板打开时就把它挂出去，用户在面板里
   * 多待十秒，撤销条早就过期了，等于没给。
   */
  const closeStock = useCallback(() => {
    const target = stockTarget;
    const base = stockBase;
    if (target && base !== null && target.quantity !== base) {
      const used = base - target.quantity;
      setUndo({
        message: `${used > 0 ? `已用掉 ${used} 件` : `已补回 ${-used} 件`} · ${stockLabel(target.quantity)}`,
        onUndo: () => {
          void setQuantity(target.id, base).then(bump);
        },
      });
    }
    setStockTarget(null);
    setStockBase(null);
  }, [stockTarget, stockBase, bump]);

  /**
   * 面板里 ±1 与「本次用完」共用的落库路径。
   *
   * 面板刻意不关：连用两件是常见场景，按完关掉会逼用户重新点开。
   * 所以这里只更新面板上的数字，让列表与统计靠 bump() 跟上。
   */
  const applyStock = useCallback(
    async (delta: number) => {
      const target = stockTarget;
      if (!target || stockBusy) return;
      setStockBusy(true);
      try {
        const before = await adjustQuantity(target.id, delta);
        if (before === null) {
          // 中途被改成「单件物品」了，什么都没发生。直接把面板收掉，
          // 免得用户对着一个不会动的数字一直点
          setStockTarget(null);
          setStockBase(null);
          return;
        }
        // 新值走纯函数，不在 SQL 里写 quantity - 1 —— 见 stock.ts 的注释
        const after = nextQuantity(before, delta) as number;
        setStockTarget({ ...target, quantity: after });
        bump();
      } finally {
        setStockBusy(false);
      }
    },
    [stockTarget, stockBusy, bump],
  );

  const emptyStock = useCallback(async () => {
    const target = stockTarget;
    if (!target || stockBusy || target.quantity === 0) return;
    setStockBusy(true);
    try {
      await setQuantity(target.id, 0);
      setStockTarget({ ...target, quantity: 0 });
      bump();
    } finally {
      setStockBusy(false);
    }
  }, [stockTarget, stockBusy, bump]);

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
            /* 右侧两格：麦克风（说一句话录入）与星标（问一问）。
               设计稿 01 屏把它们并排画在这里，而不是挤进底部第五格 ——
               底部五格是「找东西」的骨架，AI 是辅助，不该占黄金位 */
            right={
              <View style={styles.searchActions}>
                <IconButton
                  icon="mic-outline"
                  size={18}
                  tone="ink3"
                  accessibilityLabel="语音录入"
                  onPress={openVoice}
                />
                <IconButton
                  icon="sparkles-outline"
                  size={18}
                  tone={entitled ? 'brand' : 'ink3'}
                  accessibilityLabel="问一问"
                  onPress={openAsk}
                />
              </View>
            }
          />

          {/* 统计 / 图例 / 分类 / 排序这一整段是「列表的头部」，不是页面的固定区：
              交给 FlatList 的 ListHeaderComponent，滚下去随原生滚动一起离开屏幕，
              回到顶部自然又回来 —— 全程没有一处布局动画。

              外观仍是两段式：统计是一张独立小卡，图例 / 分类 / 排序浮在画布上，
              再往下才是列表那张卡（由每一行拼出来，见 renderItem 的 rowShell）。
              整段头部都在卡外，所以左右留白一律 GUTTER，和以前一致 */}
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(item) => item.id}
            style={styles.listFlex}
            ListHeaderComponent={
              <View style={styles.headBlock}>
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

                <ChipRow>
                  <Chip
                    label="全部"
                    selected={categoryId === null}
                    onPress={() => setCategoryId(null)}
                  />
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
                    style={({ pressed }) => [
                      styles.sortTrigger,
                      pressed && styles.sortTriggerPressed,
                    ]}>
                    <Ionicons name="swap-vertical-outline" size={13} color={Palette.brand} />
                    <Label tone="brand">排序 · {currentSort.label}</Label>
                    <Ionicons name="caret-down" size={11} color={Palette.brand} />
                  </Pressable>
                  <Meta tone="ink4" numberOfLines={1} style={styles.sortHint}>
                    {sortHint}
                  </Meta>
                </View>
              </View>
            }
            /* 列表的「卡」由每一行拼出来：左右边框每行都画，首行加上圆角与顶边，
               末行加下圆角与底边 —— 接起来仍是一张有轮廓的卡，但它现在是列表内容，
               可以整张随滚动走；外面不能再套一层容器，那会把头部一并包进去 */
            renderItem={({ item, index }) => (
              <View
                style={[
                  styles.rowShell,
                  index === 0 && styles.rowShellFirst,
                  index === items.length - 1 && styles.rowShellLast,
                ]}>
                <ItemRow
                  item={item}
                  selected={selected.has(item.id)}
                  selecting={selecting}
                  showSortOrder={sort === 'manual'}
                  onPress={openItem}
                  onLongPress={(it) => setSelected(new Set([it.id]))}
                  /* 多选状态下不接库存面板：那会儿整行是「待处理的勾选项」，
                     点尾巴弹出的应该是勾选，不是库存 */
                  onOpenStock={selecting ? undefined : openStock}
                  /* 多选状态下不给排序钮：两套操作抢同一个手势区，谁都点不准 */
                  onMoveUp={manualReorder && !selecting ? () => void moveItem(item.id, -1) : undefined}
                  onMoveDown={manualReorder && !selecting ? () => void moveItem(item.id, 1) : undefined}
                  canMoveUp={index > 0}
                  canMoveDown={index < items.length - 1}
                />
              </View>
            )}
            contentContainerStyle={styles.listInner}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Palette.brand} />
            }
            ListEmptyComponent={
              <Card style={styles.emptyCard}>
                {itemsState.loading ? (
                  <Loading />
                ) : debouncedQuery || categoryId ? (
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
                )}
              </Card>
            }
          />
        </>
      ) : (
        <>
          {/* 位置视图也要能搜 —— 柜子多了之后，靠滚去找一个柜子同样费劲。
              搜索框留在屏上（不进 ScrollView），滚多远都能改词 */}
          <SearchField
            value={locationQuery}
            onChange={setLocationQuery}
            placeholder="搜索柜子或格位"
          />

          <ScrollView
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Palette.brand} />
            }>
            {/* 搜索期间收掉开场白：正在找东西的人不需要再被介绍一下这页是干什么的 */}
            {locationQuery.length > 0 ? null : (
              <View style={styles.locationIntro}>
                <Heading>按位置找东西</Heading>
                <Meta tone="ink3" style={styles.locationHint}>
                  你知道东西在哪，就不必再买一件
                </Meta>
              </View>
            )}

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
            ) : cabinets.length === 0 ? (
              <EmptyState
                icon="search-outline"
                title="没有这个柜子"
                description="柜子名和格位名都能搜，换个词试试。"
                actionLabel="清空搜索"
                onAction={() => setLocationQuery('')}
              />
            ) : (
              <CabinetGrid
                cabinets={cabinets}
                onOpen={(cabinet) => router.push({ pathname: '/cabinet/[id]', params: { id: cabinet.id } })}
                onAdd={() => router.push('/cabinet/new')}
              />
            )}
          </ScrollView>
        </>
      )}

      {selecting ? (
        <View style={styles.selectionBar}>
          <Body color={Palette.onAccent}>已选 {selected.size} 件</Body>
          <View style={styles.selectionActions}>
            <BarAction icon="pricetag-outline" label="补分类" onPress={() => setPickerOpen(true)} />
            <BarAction
              icon="location-outline"
              label="改位置"
              onPress={() => setLocationPickerOpen(true)}
            />
            <BarAction icon="trash-outline" label="删除" onPress={confirmBulkDelete} />
          </View>
        </View>
      ) : null}

      <CategoryPickerModal
        visible={pickerOpen}
        categories={categoryState.data}
        onClose={() => setPickerOpen(false)}
        onPick={applyBulkCategory}
      />

      <LocationPickerModal
        visible={locationPickerOpen}
        cabinets={cabinetState.data}
        selectedId={null}
        onClose={() => setLocationPickerOpen(false)}
        onPick={applyBulkLocation}
        onManage={() => {
          setLocationPickerOpen(false);
          router.push('/cabinet/new');
        }}
      />

      <SortPickerModal
        visible={sortOpen}
        value={sort}
        onClose={() => setSortOpen(false)}
        onPick={changeSort}
      />

      {/* 库存面板挂在页面根上，不挂在 ItemRow 里 —— 行会被虚拟化反复重挂，
          Modal 跟着重建就会自己关掉。 */}
      <StockSheet
        target={stockTarget}
        busy={stockBusy}
        onClose={closeStock}
        onStep={(delta) => void applyStock(delta)}
        onSetEmpty={() => void emptyStock()}
        onEditQuantity={() => {
          const target = stockTarget;
          closeStock();
          if (target) router.push({ pathname: '/item/[id]/edit', params: { id: target.id } });
        }}
      />

      {/* 撤销条放在面板之后、且在面板关掉之前不会出现（见 closeStock） */}
      <UndoBar action={undo} onDismiss={() => setUndo(null)} />

      {/* 免费档点「问一问」时的门控。文案与浮层复用与皮肤同一套，
          不为 AI 再写一个 —— 「哪个功能要支持者」这张表只有一处实现 */}
      <SupporterGateSheet visible={gateOpen} feature="ai" onClose={() => setGateOpen(false)} />
    </Screen>
  );
}

/** 多选工具条上的一枚动作。文字 + 图标，压在深色条上 */
function BarAction({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.barAction, pressed && styles.barActionPressed]}>
      <Ionicons name={icon} size={14} color={Palette.onAccent} />
      <Label color={Palette.onAccent} style={styles.barActionText}>
        {label}
      </Label>
    </Pressable>
  );
}

const useStyles = makeStyles((Palette) => ({
  /** 位置视图用（整页滚动，要避开 Tab 栏） */
  listContent: { paddingBottom: 120 },
  /** 列表本体。它不再套外层卡，卡边由每一行的 rowShell 拼出来 */
  listFlex: { flex: 1 },
  /**
   * 列表头部整段（统计卡 + 图例 + 分类 + 排序）。
   *
   * 它现在是列表内容，但整段都在卡外 —— 统计自带卡片外壳，其余三项浮在画布上，
   * 所以左右留白一律交给各组件自己的 GUTTER，这里只负责与列表卡之间那点间距。
   * ★ 别给这里再加 paddingHorizontal：各组件已经让过一次，叠起来边距会翻倍。
   */
  headBlock: { paddingBottom: Space.md },
  /**
   * 拼成「列表卡」的行壳。
   *
   * 头部要独立成卡，就不能再拿一张 Card 把整个 FlatList 包起来 —— 那会把头部
   * 一起包进去，整片同色、只剩一条发丝线，看上去就是「连成一片」。
   * 改由每一行提供卡边：左右边框每行都画，接起来是一条连续的竖线；
   * 首行补上圆角与顶边，末行补下圆角与底边。
   *
   * 只有首行 / 末行需要 overflow:'hidden'，把 ItemRow 的矩形底色裁进圆角里；
   * 中间行不裁剪 —— 少一层离屏层，也就没有「每帧重建离屏层」那类隐患。
   */
  rowShell: {
    marginHorizontal: GUTTER,
    backgroundColor: Palette.surface,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line2,
  },
  rowShellFirst: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: Radius.card,
    borderTopRightRadius: Radius.card,
    overflow: 'hidden',
  },
  rowShellLast: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: Radius.card,
    borderBottomRightRadius: Radius.card,
    overflow: 'hidden',
  },
  /** 空态也得有卡片轮廓：头部在卡外，空态不给卡就成了一片裸底 */
  emptyCard: { marginHorizontal: GUTTER, marginBottom: Space.xl },
  /** 列表底部留白。列表不再被卡片包住，末行的下圆角要留在 Tab 栏上方 */
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
  /* 搜索框内右缘的两格。IconButton 自带 Space.xs 的内边距，两枚之间不再另加 gap，
     否则右边会多出一截空白，看起来像输入框没对齐 */
  searchActions: { flexDirection: 'row', alignItems: 'center', marginRight: -Space.xs },
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
  /* 批量操作的按钮做成文字工具条而不是实心按钮：三条并排还要放下「已选 N 件」，
     实心按钮一撑就换行；这里只要可点、看得清即可 */
  barAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Space.sm,
    paddingVertical: Space.xs,
  },
  barActionPressed: { opacity: 0.6 },
  barActionText: { fontWeight: '600' },
}));
