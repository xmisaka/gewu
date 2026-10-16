/**
 * 格物 · 柜内格位
 *
 * 「打开某个柜子看看里面有什么」—— 盘点场景的主视图。
 * 物品按格位分组，没有指定格位的单独归到「直接放在柜子里」，
 * 让用户一眼看出哪些位置记录缺失。
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';

import { PhotoThumb } from '@/components/domain/media';
import { Button, IconButton } from '@/components/ui/controls';
import { EmptyState, Loading, PlainTag } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { Heading, ItemText, Label, Meta, Title } from '@/components/ui/typography';
import { GUTTER, Radius, Space } from '@/constants/theme';
import { getCabinetView } from '@/lib/db/locations';
import { listItems } from '@/lib/db/items';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import type { CabinetView, ItemView } from '@/lib/types';
import { makeStyles } from '@/lib/theme';

const TILE = 72;

export default function CabinetDetailScreen() {
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { dataVersion } = useAppState();
  const { width } = useWindowDimensions();

  const cabinetState = useAsyncData(() => getCabinetView(id), [id, dataVersion], null as CabinetView | null);
  const itemsState = useAsyncData(() => listItems({ locationId: id }), [id, dataVersion], [] as ItemView[]);

  /**
   * 一行能摆几枚缩略图 —— 用来算每一格先摊开多少件（**每行几格 × 6**）。
   *
   * ★ 上限跟着屏宽走是这一页一直以来的设计，别改成写死的件数。
   */
  const tilesPerRow = useMemo(() => {
    const usable = width - GUTTER * 2 - Space.lg * 2;
    return Math.max(2, Math.floor((usable + Space.md) / (TILE + Space.md)));
  }, [width]);

  /**
   * 已展开的格位。
   *
   * ★ 没有它，那枚「+N」就只是一块**画着数字的死方块** ——
   *   用户看得见「还有 9 件」，却点不动、也翻不到（2026-10-16 反馈的正是这条）。
   * ★ 按**格位 key** 记而不是全局一个布尔：一个柜子里有好几格，
   *   在一格里点开不该把别的格子一起拉长。
   */
  const [expandedSlots, setExpandedSlots] = useState<Set<string>>(new Set());

  const toggleSlot = useCallback((key: string) => {
    setExpandedSlots((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** 一次查询 + 前端按 location_id 分组，避免每个格位各发一条 SQL */
  const grouped = useMemo(() => {
    const cabinet = cabinetState.data;
    if (!cabinet) return [];

    const bySlot = new Map<string, ItemView[]>();
    const loose: ItemView[] = [];

    for (const item of itemsState.data) {
      if (item.locationId === cabinet.id) {
        loose.push(item);
      } else if (item.locationId) {
        const list = bySlot.get(item.locationId);
        if (list) list.push(item);
        else bySlot.set(item.locationId, [item]);
      }
    }

    const sections = cabinet.slots.map((s) => ({
      key: s.slot.id,
      name: s.slot.name,
      items: bySlot.get(s.slot.id) ?? [],
    }));

    if (loose.length > 0 || cabinet.slots.length === 0) {
      sections.push({ key: '__loose__', name: '直接放在柜子里', items: loose });
    }

    return sections;
  }, [cabinetState.data, itemsState.data]);

  const cabinet = cabinetState.data;

  if (cabinetState.loading && !cabinet) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  if (!cabinet) {
    return (
      <Screen>
        <PageHeader
          title="柜子不存在"
          right={<IconButton icon="close" accessibilityLabel="返回" onPress={() => router.back()} />}
        />
        <EmptyState icon="alert-circle-outline" title="它可能已被删除" />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
        <IconButton
          icon="add"
          accessibilityLabel="管理格位"
          tone="brand"
          onPress={() => router.push('/cabinet/new')}
        />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.identity}>
          <Title style={styles.name}>{cabinet.name}</Title>
          <View style={styles.metaLine}>
            <PlainTag text={`${cabinet.totalCount} 件物品`} tone="brand" />
            <PlainTag text={`${cabinet.slots.length} 个格位`} />
          </View>
        </View>

        <Gutter>
          {/* ★ 把柜子**带上**：录入页拿它当位置默认值。
              以前只是 `push('/compose')`，于是位置只能取「上次用过的那个」，
              从别的柜子进来时那个值是错的（2026-10-11 真机反馈）。
              同一个 push 也把这一页压进了返回栈 —— 录完返回键回到这个柜子。

              参数走路由参数而不是全局变量：绑在这一次的录入页实例上，
              从别处（底部中央按钮）再进去时自然就没有了，不会串味。 */}
          <Button
            label={`在「${cabinet.name}」里录一件`}
            icon="add"
            onPress={() => router.push({ pathname: '/compose', params: { locationId: cabinet.id } })}
            style={styles.primaryAction}
          />
        </Gutter>

        {cabinet.slots.length === 0 && itemsState.data.length === 0 ? (
          <EmptyState
            icon="file-tray-outline"
            title="这个柜子还是空的"
            description="可以先把物品录进来，也可以先划几个格位再往里放。"
            actionLabel="管理格位"
            onAction={() => router.push('/cabinet/new')}
          />
        ) : null}

        {grouped.map((section) => (
          <View key={section.key} style={styles.section}>
            <Gutter>
              <View style={styles.sectionHead}>
                <Heading>{section.name}</Heading>
                <Meta tone="ink4">{section.items.length} 件</Meta>
              </View>
            </Gutter>

            {section.items.length === 0 ? (
              <Gutter>
                <Card tone="inset" style={styles.emptySlot}>
                  <Meta tone="ink3">这一格是空的</Meta>
                </Card>
              </Gutter>
            ) : (
              <View style={[styles.tileWrap, { paddingHorizontal: GUTTER - Space.sm }]}>
                {(expandedSlots.has(section.key)
                  ? section.items
                  : section.items.slice(0, tilesPerRow * 6)
                ).map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
                    style={styles.tile}>
                    <PhotoThumb
                      thumb={item.coverThumb}
                      name={item.name}
                      size={TILE}
                      radius={Radius.input}
                    />
                    <ItemText numberOfLines={1} style={styles.tileName}>
                      {item.name}
                    </ItemText>
                  </Pressable>
                ))}

                {/* 折叠态那枚「+N」。
                    ★ 它以前是一块**纯展示**的 `View`：用户看得见「还有 9 件」，
                      却点不开、也没有别的地方能看全（2026-10-16 报的就是这个 bug）。
                      修法是只把外层换成 `Pressable` 接上展开，**外观一点没动** ——
                      不留底色、不加提示字，跟在缩略图后面和一格里的其他方块同款。 */}
                {!expandedSlots.has(section.key) && section.items.length > tilesPerRow * 6 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`查看「${section.name}」的全部 ${section.items.length} 件`}
                    onPress={() => toggleSlot(section.key)}
                    style={({ pressed }) => [
                      styles.tile,
                      styles.tileMore,
                      pressed && styles.tileMorePressed,
                    ]}>
                    <Label tone="ink3">+{section.items.length - tilesPerRow * 6}</Label>
                  </Pressable>
                ) : null}

                {/* 展开态末尾的「收起」。★ 必须给：一个 60 件的格位展开之后，
                    用户得能折回去，否则这一格会把下面几格推到很远的屏幕外 */}
                {expandedSlots.has(section.key) && section.items.length > tilesPerRow * 6 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`收起「${section.name}」`}
                    onPress={() => toggleSlot(section.key)}
                    style={({ pressed }) => [
                      styles.tile,
                      styles.tileMore,
                      pressed && styles.tileMorePressed,
                    ]}>
                    <Label tone="ink3">收起</Label>
                  </Pressable>
                ) : null}
              </View>
            )}
          </View>
        ))}

        <View style={styles.footer}>
          <Button
            label="查看全部柜子"
            tone="secondary"
            icon="grid-outline"
            onPress={() => router.back()}
          />
          <Meta tone="ink4" style={styles.footerHint}>
            共 {cabinet.slots.filter((s) => s.itemCount > 0).length} 个格位在用
          </Meta>
        </View>
      </ScrollView>
    </Screen>
  );
}

const useStyles = makeStyles((Palette) => ({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER - Space.sm,
    paddingVertical: Space.sm,
  },
  scroll: { paddingBottom: 120 },
  identity: { paddingHorizontal: GUTTER, gap: Space.md },
  name: { fontSize: 25 },
  metaLine: { flexDirection: 'row', gap: Space.sm },
  primaryAction: { marginTop: Space.xl },
  section: { marginTop: Space.xxl },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: Space.md,
  },
  emptySlot: { padding: Space.md },
  tileWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  tile: { width: TILE, gap: Space.xs },
  tileName: { fontSize: 11.5, textAlign: 'center' },
  /* 与原来那枚纯展示的方块**逐字一致**（没有底色） —— 这轮只修「点不动」，
     视觉不动。`tileMorePressed` 只在按住的那一瞬间出现，静止态看不出区别。 */
  tileMore: { height: TILE, alignItems: 'center', justifyContent: 'center' },
  tileMorePressed: { backgroundColor: Palette.inset, borderRadius: Radius.input },
  footer: { paddingHorizontal: GUTTER, paddingTop: Space.xxxl, gap: Space.md },
  footerHint: { textAlign: 'center' },
}));
