/**
 * 格物 · 回收站
 *
 * 误删的最后一根绳子（PRD 6.6）。
 * 这里的东西不占列表，但照片和字段全都还在，可以随时捞回来。
 * 「彻底删除」才真正清文件 —— 所以它必须二次确认。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { PhotoThumb } from '@/components/domain/media';
import { Button, IconButton } from '@/components/ui/controls';
import { EmptyState, Loading } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { ItemText, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import { emptyTrash, listTrash, purgeItem, restoreItem } from '@/lib/db/items';
import { formatMoney, formatStamp } from '@/lib/format';
import { deleteFiles } from '@/lib/photos/pipeline';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import { makeStyles } from '@/lib/theme';

export default function TrashScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { dataVersion, bump } = useAppState();
  const [busy, setBusy] = useState(false);

  const state = useAsyncData(() => listTrash(), [dataVersion], []);
  const items = state.data;

  const restore = async (id: string, name: string) => {
    setBusy(true);
    try {
      await restoreItem(id);
      bump();
    } finally {
      setBusy(false);
    }
  };

  const purge = (id: string, name: string) => {
    Alert.alert(`彻底删除「${name}」？`, '记录和它带的照片会一并从手机里删除，无法恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '彻底删除',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            const files = await purgeItem(id);
            deleteFiles(files);
            bump();
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const clearAll = () => {
    Alert.alert('清空回收站？', `里面 ${items.length} 件物品的记录与照片会被全部删除，无法恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            const files = await emptyTrash();
            deleteFiles(files);
            bump();
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
        <Meta tone="ink3" style={styles.topHint}>
          {items.length > 0 ? `${items.length} 件` : ''}
        </Meta>
      </View>

      <PageHeader title="回收站" subtitle="误删的东西在这里，照片和字段都还在" />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {state.loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState
            icon="trash-outline"
            title="回收站是空的"
            description="删除物品时会先移到这里，确认不要了再彻底清掉。"
          />
        ) : (
          <>
            {items.map((item) => (
              <Card key={item.id} style={styles.row}>
                <PhotoThumb thumb={item.coverThumb} name={item.name} size={44} />
                <View style={styles.body}>
                  <ItemText numberOfLines={1}>{item.name}</ItemText>
                  <Meta tone="ink3" numberOfLines={1}>
                    {[
                      item.categoryName ?? '未分类',
                      item.price != null ? formatMoney(item.price) : null,
                      item.deletedAt ? `删除于 ${formatStamp(item.deletedAt)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Meta>
                </View>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="恢复"
                    hitSlop={6}
                    disabled={busy}
                    onPress={() => void restore(item.id, item.name)}
                    style={styles.iconAction}>
                    <Ionicons name="arrow-undo-outline" size={17} color={Palette.brand} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="彻底删除"
                    hitSlop={6}
                    disabled={busy}
                    onPress={() => purge(item.id, item.name)}
                    style={styles.iconAction}>
                    <Ionicons name="close-circle-outline" size={17} color={Palette.clay} />
                  </Pressable>
                </View>
              </Card>
            ))}

            <Gutter>
              <Button
                label="清空回收站"
                tone="danger"
                icon="trash-outline"
                onPress={clearAll}
                style={styles.clearAction}
              />
              <Meta tone="ink4" style={styles.clearHint}>
                彻底删除后照片文件也会一起清掉，无法找回
              </Meta>
            </Gutter>
          </>
        )}
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
  topHint: { paddingRight: Space.sm },
  scroll: { paddingBottom: 120 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    marginHorizontal: GUTTER,
    marginBottom: Space.sm,
    padding: Space.md,
  },
  body: { flex: 1, gap: 3 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  iconAction: {
    width: 34,
    height: 34,
    borderRadius: Radius.thumb,
    backgroundColor: Palette.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearAction: { marginTop: Space.xxl },
  clearHint: { textAlign: 'center', paddingTop: Space.sm },
}));
