/**
 * 格物 · 照片全屏查看
 *
 * 解决的是「看不清」：盘点、理赔、出手时要在照片上读型号和序列号，
 * 而详情页那条 230px 的大图位和 48px 的缩略条都读不出来。
 *
 * ── 四条设计约束 ───────────────────────────────────────────
 *
 * ★ 底色用 `Palette.shadow`，不是 `paper`/`ink`：这是**唯一在七套主题里都保证是深色**
 *   的令牌（浅色档是暖墨、玄夜是纯黑）。看照片需要一层稳定的深底，
 *   而 `ink` 在玄夜是浅色、`paper` 在素笺是浅色，两个都会让照片发飘。
 *
 * ★ 外壳与内容**拆成两个组件**（外层只判断 visible、零 hook，内层持有全部状态）。
 *   这样「每次打开都是全新挂载」，当前是第几张、放大没放大都由 useState 初值决定，
 *   不需要用 effect 去重置 —— 而那个 effect 一定会和「用户正在横滑翻页」打架：
 *   父级把新下标回传成 initialIndex，effect 就把列表滚回去，看着像翻页失灵。
 *
 * ★ 左右翻页与缩放的手势**不能打架**：单指横滑翻页（交给 FlatList 原生 paging），
 *   双指捏合缩放。只有在已经放大时才接管单指拖动来平移 —— 否则一放大就再也翻不了页。
 *   接管与否靠 `scrollEnabled={!zoomed}` 明说，不靠手势优先级去猜。
 *
 * ★ 「设为封面」只在**非首张**时可用：封面按 sort_order 取第一张，
 *   所以首张点它是个空操作，按钮直接显示「已是封面」并禁用 ——
 *   按钮点下去什么都没变，是用户最难判断的一类反馈。
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/controls';
import { Meta } from '@/components/ui/typography';
import { Palette, Space } from '@/constants/theme';
import { absoluteUri } from '@/lib/photos/pipeline';
import { makeStyles } from '@/lib/theme';
import type { Photo } from '@/lib/types';

/** 捏合缩放的上限。再大就只剩马赛克了，压住省得用户白费劲 */
const MAX_SCALE = 4;
/** 双击放大的倍数 */
const DOUBLE_TAP_SCALE = 2.5;

export interface PhotoViewerProps {
  visible: boolean;
  photos: Photo[];
  /** 打开时定位到第几张 */
  initialIndex?: number;
  itemName: string;
  onClose: () => void;
  /** 翻到某一张（用于把调用方的「当前图」同步过去） */
  onIndexChange?: (index: number) => void;
  /**
   * 把某张照片设为封面。不传就隐藏这个按钮（相册页只查看，不改）。
   * 传进来的是照片相对路径；可以是异步的 —— 完成后查看器会挪到首位（见下方）。
   */
  onSetCover?: (filePath: string) => void | Promise<void>;
}

/**
 * 外层刻意**零 hook**：早返回不会破坏 hooks 数量的一致性，
 * 同时保证「每次打开都是一次全新挂载」（见文件头第 2 条）。
 */
export function PhotoViewer({ visible, ...rest }: PhotoViewerProps) {
  if (!visible) return null;
  return <PhotoViewerBody {...rest} />;
}

function PhotoViewerBody({
  photos,
  initialIndex = 0,
  itemName,
  onClose,
  onIndexChange,
  onSetCover,
}: Omit<PhotoViewerProps, 'visible'>) {
  const styles = useStyles();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<Photo>>(null);
  /** 初值即「打开时看第几张」。因为是全新挂载，不需要任何 effect 去同步 */
  const [index, setIndex] = useState(initialIndex);
  const [zoomed, setZoomed] = useState(false);
  /** 设封面正在落库，用于挡住连点 */
  const [settingCover, setSettingCover] = useState(false);

  const onMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(e.nativeEvent.contentOffset.x / width);
      setIndex(next);
      setZoomed(false);
      onIndexChange?.(next);
    },
    [width, onIndexChange],
  );

  const current = photos[Math.min(index, Math.max(photos.length - 1, 0))];
  const isCover = index === 0;

  return (
    <Modal
      visible
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
      /* 这是「盖住整屏的查看器」，不是从底部升起的表单 —— 不走 SheetModal */
      presentationStyle="overFullScreen">
      <View style={styles.root}>
        <FlatList
          ref={listRef}
          data={photos}
          keyExtractor={(p) => p.id}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          /* getItemLayout + initialScrollIndex：打开就直接停在目标那张，不用等布局完再滚 */
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          initialScrollIndex={Math.min(initialIndex, Math.max(photos.length - 1, 0))}
          initialNumToRender={1}
          windowSize={3}
          onMomentumScrollEnd={onMomentumEnd}
          renderItem={({ item }) => (
            <ZoomableImage
              uri={absoluteUri(item.filePath)}
              width={width}
              height={height}
              onZoomChange={setZoomed}
            />
          )}
        />

        <View style={[styles.top, { paddingTop: insets.top + Space.sm }]} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            hitSlop={10}
            onPress={onClose}
            style={styles.iconBtn}>
            <Ionicons name="close" size={22} color={Palette.pure} />
          </Pressable>
          {photos.length > 1 ? (
            <Meta color={Palette.pure} style={styles.counter}>
              {index + 1} / {photos.length}
            </Meta>
          ) : (
            <View />
          )}
        </View>

        <View
          style={[styles.bottom, { paddingBottom: insets.bottom + Space.md }]}
          pointerEvents="box-none">
          <Meta color={Palette.pure} style={styles.name} numberOfLines={1}>
            {itemName}
          </Meta>
          {onSetCover ? (
            <Button
              label={isCover ? '已是封面' : '设为封面'}
              tone="secondary"
              icon="image-outline"
              block={false}
              loading={settingCover}
              disabled={isCover || !current}
              onPress={async () => {
                if (!current || settingCover) return;
                setSettingCover(true);
                try {
                  await onSetCover(current.filePath);
                  /* 封面就是第一张：设完跟着挪到首位。
                     不挪的话，列表顺序变了而 index 没变，这一页会莫名其妙换成另一张照片 ——
                     用户会以为「我点的明明是设为封面，怎么翻页了」。 */
                  setIndex(0);
                  listRef.current?.scrollToOffset({ offset: 0, animated: false });
                } finally {
                  setSettingCover(false);
                }
              }}
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

/**
 * 单张可缩放的照片。
 *
 * ★ 手势全在这一个组件里闭环：它自己知道自己有没有被放大，并把这个状态
 *   冒泡出去（父级用它决定 FlatList 要不要接受横滑）。
 *   把「放大没放大」留在父级再传回来，会多出一个必有一边忘了同步的状态。
 */
function ZoomableImage({
  uri,
  width,
  height,
  onZoomChange,
}: {
  uri: string | null;
  width: number;
  height: number;
  onZoomChange: (zoomed: boolean) => void;
}) {
  const styles = useStyles();
  const [zoomed, setZoomed] = useState(false);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const apply = useCallback(
    (next: boolean) => {
      setZoomed(next);
      onZoomChange(next);
    },
    [onZoomChange],
  );

  /* 手势对象只依赖「真正会影响判断的」外部值。
     ★ 共享值（scale / tx / ty …）**刻意不放进依赖数组**：
       它们的 `.value` 要在回调里被写，而 React Compiler 的 lint 规则
       会把「出现在 hook 参数里的值」视为只读，一写就报
       「This value cannot be modified」。共享值本身是稳定引用，本来就无需进依赖。 */
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .onUpdate((e) => {
          const next = savedScale.value * e.scale;
          scale.value = Math.min(MAX_SCALE, Math.max(1, next));
        })
        .onEnd(() => {
          savedScale.value = scale.value;
          if (scale.value <= 1.01) {
            // 缩回原尺寸：顺便把平移归零，否则会留下一张偏在角落的小图
            tx.value = withTiming(0);
            ty.value = withTiming(0);
            savedTx.value = 0;
            savedTy.value = 0;
            runOnJS(apply)(false);
          } else {
            runOnJS(apply)(true);
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 共享值是稳定引用，不进依赖（见上方说明）
    [apply],
  );

  /* ★ 只在放大后才接管单指拖动。始终接管的话，一放大就再也翻不了页；
     从不接管的话，放大了却只能看正中间那一块 */
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(zoomed)
        .onUpdate((e) => {
          const maxX = (width * (scale.value - 1)) / 2;
          const maxY = (height * (scale.value - 1)) / 2;
          tx.value = Math.min(maxX, Math.max(-maxX, savedTx.value + e.translationX));
          ty.value = Math.min(maxY, Math.max(-maxY, savedTy.value + e.translationY));
        })
        .onEnd(() => {
          savedTx.value = tx.value;
          savedTy.value = ty.value;
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 共享值是稳定引用，不进依赖（见上方说明）
    [zoomed, width, height],
  );

  const doubleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
          if (scale.value > 1.01) {
            scale.value = withTiming(1);
            savedScale.value = 1;
            tx.value = withTiming(0);
            ty.value = withTiming(0);
            savedTx.value = 0;
            savedTy.value = 0;
            runOnJS(apply)(false);
          } else {
            scale.value = withTiming(DOUBLE_TAP_SCALE);
            savedScale.value = DOUBLE_TAP_SCALE;
            runOnJS(apply)(true);
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 共享值是稳定引用，不进依赖（见上方说明）
    [apply],
  );

  const composed = useMemo(
    () => Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan)),
    [doubleTap, pinch, pan],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={composed}>
      <View style={[styles.page, { width, height }]}>
        {uri ? (
          <Animated.View style={[styles.imageWrap, animatedStyle]}>
            <Image source={{ uri }} style={styles.image} contentFit="contain" transition={120} />
          </Animated.View>
        ) : (
          <View style={styles.missing}>
            <Ionicons name="image-outline" size={26} color={Palette.ink4} />
          </View>
        )}
      </View>
    </GestureDetector>
  );
}

const useStyles = makeStyles(() => ({
  /* 唯一在七套主题里都保证是深色的令牌 —— 见文件头注释 */
  root: { flex: 1, backgroundColor: Palette.shadow },
  page: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  imageWrap: { width: '100%', height: '100%' },
  image: { width: '100%', height: '100%' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Space.lg,
  },
  iconBtn: { padding: Space.xs },
  counter: { fontSize: 12, fontVariant: ['tabular-nums'] },

  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
  },
  name: { fontSize: 12.5, maxWidth: '100%' },
}));
