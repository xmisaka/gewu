/**
 * 格物 · 相册
 *
 * 照片录都录了，就得有个专门看的地方。
 * 按年月分组而不是按物品分组 —— 翻相册的心理是「回忆/核对」，
 * 时间轴比分类树更贴合。
 *
 * 实现注记：SectionList 不支持 numColumns，所以把每个分组的照片
 * 预先切成「每行 3 张」的二维数组再渲染。
 */

import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, SectionList, useWindowDimensions, View } from 'react-native';

import { PhotoThumb } from '@/components/domain/media';
import { EmptyState, Loading } from '@/components/ui/feedback';
import { PageHeader, Screen } from '@/components/ui/layout';
import { Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Space } from '@/constants/theme';
import { listAlbumPhotos, type AlbumPhoto } from '@/lib/db/photos';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import { makeStyles } from '@/lib/theme';

const COLUMNS = 3;

/** 一维数组按每行 n 个切成二维 */
function chunkRows<T>(arr: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    rows.push(arr.slice(i, i + size));
  }
  return rows;
}

export default function AlbumScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { dataVersion } = useAppState();
  const { width } = useWindowDimensions();

  const state = useAsyncData(() => listAlbumPhotos(), [dataVersion], [] as AlbumPhoto[]);

  const cellSize = useMemo(
    () => Math.floor((width - GUTTER * 2 - Space.sm * (COLUMNS - 1)) / COLUMNS),
    [width],
  );

  const sections = useMemo(() => {
    const map = new Map<string, AlbumPhoto[]>();
    for (const photo of state.data) {
      const d = new Date(photo.takenAt);
      const key = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
      const list = map.get(key);
      if (list) list.push(photo);
      else map.set(key, [photo]);
    }
    return [...map.entries()].map(([title, photos]) => ({
      title,
      count: photos.length,
      data: chunkRows(photos, COLUMNS),
    }));
  }, [state.data]);

  const total = state.data.length;

  return (
    <Screen>
      <PageHeader
        title="相册"
        subtitle={total > 0 ? `${total} 张照片，都存在应用内` : '录物品时拍的照片会汇总到这里'}
      />

      <SectionList
        sections={sections}
        keyExtractor={(row) => row[0].id}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHead}>
            <Meta tone="ink3">{section.title}</Meta>
            <Meta tone="ink4">{section.count} 张</Meta>
          </View>
        )}
        renderItem={({ item: row }) => (
          <View style={styles.row}>
            {row.map((photo) => (
              <Pressable
                key={photo.id}
                accessibilityRole="button"
                accessibilityLabel={`${photo.itemName} 的照片`}
                onPress={() => router.push({ pathname: '/item/[id]', params: { id: photo.itemId } })}
                style={{ width: cellSize, height: cellSize }}>
                <PhotoThumb
                  thumb={photo.thumbPath}
                  name={photo.itemName}
                  size={cellSize}
                  radius={Space.md}
                />
                <View style={styles.caption}>
                  <Label color={Palette.pure} numberOfLines={1} style={styles.captionText}>
                    {photo.itemName}
                  </Label>
                </View>
              </Pressable>
            ))}
          </View>
        )}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          state.loading ? (
            <Loading />
          ) : (
            <EmptyState
              icon="images-outline"
              title="还没有照片"
              description="录入物品时加一张照片，以后盘点、理赔、出手都用得上。"
            />
          )
        }
      />
    </Screen>
  );
}

const useStyles = makeStyles((Palette) => ({
  content: { paddingHorizontal: GUTTER, paddingBottom: 120 },
  row: { flexDirection: 'row', gap: Space.sm, marginBottom: Space.sm },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Space.lg,
    paddingBottom: Space.sm,
  },
  caption: {
    position: 'absolute',
    left: Space.md,
    right: Space.md,
    bottom: 6,
  },
  /* 白字压在任意照片上，靠一圈深色晕开保证可读。
     用 shadow 令牌而不是写死的黑 —— 它在浅色档是暖墨、深色档是纯黑，
     两档都能兜住，也避免成为主题守护脚本的漏网之鱼 */
  captionText: { fontSize: 10.5, textShadowColor: Palette.shadow, textShadowRadius: 3 },
}));
