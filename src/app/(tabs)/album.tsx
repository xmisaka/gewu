/**
 * 格物 · 相册
 *
 * 照片录都录了，就得有个专门看的地方。
 * 按年月分组而不是按物品分组 —— 翻相册的心理是「回忆/核对」，
 * 时间轴比分类树更贴合。
 *
 * 实现注记：SectionList 不支持 numColumns，所以把每个分组的照片
 * 预先切成「每行 3 张」的二维数组再渲染。
 *
 * ── 两个交互补全（原先是「点了只能跳物品」）────────────────
 *
 * ★ **点开大图**：缩略图看不清型号，而这一页的存在意义就是「翻照片」，
 *   点一下却跳走去看物品字段，与翻相册的心智对不上。
 * ★ **长按进多选删除**：删照片是这一页唯一的写操作，而且破坏性，
 *   所以刻意不给常驻入口 —— 长按进入、底部条确认、默认选中长按的那张。
 */

import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Alert, Pressable, SectionList, useWindowDimensions, View } from 'react-native';

import { PhotoThumb } from '@/components/domain/media';
import { PhotoViewer } from '@/components/domain/PhotoViewer';
import { Button } from '@/components/ui/controls';
import { EmptyState, Loading } from '@/components/ui/feedback';
import { PageHeader, Screen } from '@/components/ui/layout';
import { Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Space } from '@/constants/theme';
import { listAlbumPhotos, removePhoto, type AlbumPhoto } from '@/lib/db/photos';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { deleteFiles } from '@/lib/photos/pipeline';
import { useAppState } from '@/lib/store/app-state';
import { makeStyles } from '@/lib/theme';
import type { Photo } from '@/lib/types';

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
  const { dataVersion, bump } = useAppState();
  const { width } = useWindowDimensions();

  const state = useAsyncData(() => listAlbumPhotos(), [dataVersion], [] as AlbumPhoto[]);
  const photos = state.data;

  /** 全屏查看的**打开下标**：只在打开时写一次，翻页不回写，免得列表被拽回去 */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  /** 全屏里当前翻到第几张，只用于跟着换名字 */
  const [viewerCurrent, setViewerCurrent] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  /** 扁平数组下标：SectionList 里没有「第几张」这个概念，全屏查看要按扁平序走 */
  const flatIndexOf = useMemo(() => {
    const map = new Map<string, number>();
    photos.forEach((p, i) => map.set(p.id, i));
    return map;
  }, [photos]);

  /** 全屏查看要的是 Photo 形状；相册里没有 sort_order 可言，给 0 即可（不设封面） */
  const viewerPhotos = useMemo<Photo[]>(
    () =>
      photos.map((p) => ({
        id: p.id,
        itemId: p.itemId,
        filePath: p.filePath,
        thumbPath: p.thumbPath,
        sortOrder: 0,
      })),
    [photos],
  );

  const cellSize = useMemo(
    () => Math.floor((width - GUTTER * 2 - Space.sm * (COLUMNS - 1)) / COLUMNS),
    [width],
  );

  const sections = useMemo(() => {
    const map = new Map<string, AlbumPhoto[]>();
    for (const photo of photos) {
      const d = new Date(photo.takenAt);
      const key = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
      const list = map.get(key);
      if (list) list.push(photo);
      else map.set(key, [photo]);
    }
    return [...map.entries()].map(([title, list]) => ({
      title,
      count: list.length,
      data: chunkRows(list, COLUMNS),
    }));
  }, [photos]);

  const total = photos.length;

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onPhotoPress = (photo: AlbumPhoto) => {
    if (selectMode) {
      toggle(photo.id);
      return;
    }
    const at = flatIndexOf.get(photo.id) ?? 0;
    setViewerIndex(at);
    setViewerCurrent(at);
  };

  const runDelete = async () => {
    setBusy(true);
    try {
      for (const id of selected) {
        // 先删记录拿路径，再删文件 —— 与编辑页同一条通路
        const files = await removePhoto(id);
        deleteFiles(files);
      }
      exitSelect();
      bump();
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    if (selected.size === 0 || busy) return;
    Alert.alert(
      '删除这些照片？',
      `选中的 ${selected.size} 张会从对应物品上移除，物品本身不动 —— 只是不再有这张图了。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => void runDelete() },
      ],
    );
  };

  return (
    <Screen>
      <PageHeader
        title={selectMode ? `已选 ${selected.size} 张` : '相册'}
        subtitle={
          selectMode
            ? '点照片可继续增删，删掉只是从物品上移除'
            : total > 0
              ? `${total} 张照片，都存在应用内`
              : '录物品时拍的照片会汇总到这里'
        }
        right={
          selectMode ? <Button label="取消" tone="ghost" block={false} onPress={exitSelect} /> : undefined
        }
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
            {row.map((photo) => {
              const isPicked = selected.has(photo.id);
              return (
                <Pressable
                  key={photo.id}
                  accessibilityRole="button"
                  accessibilityLabel={
                    selectMode
                      ? `${photo.itemName} 的照片，${isPicked ? '已选' : '未选'}`
                      : `${photo.itemName} 的照片，点开大图`
                  }
                  onPress={() => onPhotoPress(photo)}
                  onLongPress={() => {
                    if (selectMode) return;
                    setSelectMode(true);
                    setSelected(new Set([photo.id]));
                  }}
                  delayLongPress={280}
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
                  {selectMode ? (
                    <View style={[styles.check, isPicked && styles.checkOn]}>
                      {isPicked ? (
                        <Ionicons name="checkmark" size={13} color={Palette.pure} />
                      ) : null}
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
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

      {/* 多选工具条：与物品页同一种写法（浮起的深色圆角条，文字走 onAccent） */}
      {selectMode ? (
        <View style={styles.selectionBar}>
          <Label color={Palette.onAccent}>已选 {selected.size} 张</Label>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="删除选中的照片"
            disabled={selected.size === 0 || busy}
            hitSlop={6}
            onPress={confirmDelete}
            style={({ pressed }) => [
              styles.barAction,
              (selected.size === 0 || busy) && styles.barActionInert,
              pressed && styles.barActionPressed,
            ]}>
            <Ionicons name="trash-outline" size={14} color={Palette.onAccent} />
            <Label color={Palette.onAccent} style={styles.barActionText}>
              删除
            </Label>
          </Pressable>
        </View>
      ) : null}

      <PhotoViewer
        visible={viewerIndex !== null}
        photos={viewerPhotos}
        initialIndex={viewerIndex ?? 0}
        /* 翻页时跟着换名字：相册里相邻两张很可能不是同一件东西 */
        itemName={viewerIndex === null ? '' : (photos[viewerCurrent]?.itemName ?? '')}
        onClose={() => setViewerIndex(null)}
        onIndexChange={setViewerCurrent}
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

  /* 多选勾选圈：压在照片右上角。未选是空心白圈，已选是品牌色实心 */
  check: {
    position: 'absolute',
    top: Space.sm,
    right: Space.sm,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Palette.pure,
    backgroundColor: Palette.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: Palette.brand, borderColor: Palette.brand },

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
  barAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.sm,
    paddingVertical: Space.xs,
  },
  barActionInert: { opacity: 0.5 },
  barActionPressed: { opacity: 0.6 },
  barActionText: { fontWeight: '600' },
}));
