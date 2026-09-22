/**
 * 格物 · 柜内格位
 *
 * 「打开某个柜子看看里面有什么」—— 盘点场景的主视图。
 * 物品按格位分组，没有指定格位的单独归到「直接放在柜子里」，
 * 让用户一眼看出哪些位置记录缺失。
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';

import { PhotoThumb } from '@/components/domain/media';
import { Button, IconButton } from '@/components/ui/controls';
import { EmptyState, Loading, PlainTag } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { Body, Heading, ItemText, Label, Meta, Title } from '@/components/ui/typography';
import { GUTTER, Radius, Space } from '@/constants/theme';
import { getCabinetView, listCabinetViews } from '@/lib/db/locations';
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

  const tilesPerRow = useMemo(() => {
    const usable = width - GUTTER * 2 - Space.lg * 2;
    return Math.max(2, Math.floor((usable + Space.md) / (TILE + Space.md)));
  }, [width]);

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
          <Button
            label={`在「${cabinet.name}」里录一件`}
            icon="add"
            onPress={() => router.push('/compose')}
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
                {section.items.slice(0, tilesPerRow * 6).map((item) => (
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
                {section.items.length > tilesPerRow * 6 ? (
                  <View style={[styles.tile, styles.tileMore]}>
                    <Label tone="ink3">+{section.items.length - tilesPerRow * 6}</Label>
                  </View>
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
  tileMore: { height: TILE, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingHorizontal: GUTTER, paddingTop: Space.xxxl, gap: Space.md },
  footerHint: { textAlign: 'center' },
}));
