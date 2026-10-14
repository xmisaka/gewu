/**
 * 格物 · 图片相关展示组件
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';

import { Palette, Radius } from '@/constants/theme';
import { initialOf } from '@/lib/format';
import { absoluteUri } from '@/lib/photos/pipeline';
import { Label } from '../ui/typography';
import { makeStyles } from '@/lib/theme';

/**
 * 缩略图。有图显示图，无图显示首字占位块。
 * 绝不显示破损图标 —— 缺图时首字占位比白框更有信息量。
 */
export function PhotoThumb({
  thumb,
  name,
  size = 44,
  radius = Radius.thumb,
  style,
}: {
  thumb: string | null;
  name: string;
  size?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  const uri = absoluteUri(thumb);
  const box: ViewStyle = { width: size, height: size, borderRadius: radius };

  if (!uri) {
    return (
      <View style={[styles.placeholder, box, style]}>
        <Label color={Palette.ink3} style={{ fontSize: Math.max(13, size * 0.34) }}>
          {initialOf(name)}
        </Label>
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      style={[box as ImageStyle, style as StyleProp<ImageStyle>]}
      contentFit="cover"
      transition={120}
      cachePolicy="memory-disk"
    />
  );
}

/**
 * 详情页大图位；缺图时给出明确的空位提示而不是灰色块。
 *
 * ★★★ **必须喂原图 `filePath`，不能喂 `thumbPath`。** 这个位子是**整屏宽 × 230dp**
 *   （`Screen` 与那一层的 `ScrollView` 都不给水平内边距），360dp 屏 @3x 就是
 *   **1080 物理像素**宽 —— 而缩略图只有 **320px** 宽，喂它进来等于 3.4 倍上采样，
 *   再叠一次 JPEG q0.75，看什么都糊。原图长边 1600，缩下去反而正好。
 *   `contentFit="cover"` 按宽度定标，纵向同倍放大，所以两个方向都靠这一条解决。
 *   （反证：全屏查看器一直用 `filePath`，所以它清晰；只有这里糊过。）
 *
 * ★ 兜底链 `filePath → thumb`：schema 里两者都是 NOT NULL，正常不会有单缺；
 *   但万一原图文件丢了，给一张糊的总好过一个白框 —— 与「绝不显示破损图标」同一条原则。
 */
export function PhotoStage({
  filePath,
  thumb,
  height = 220,
}: {
  /** 原图相对路径，形如 `photos/xxxx.jpg` —— 首选 */
  filePath?: string | null;
  /** 缩略图相对路径，形如 `thumbs/xxxx.jpg` —— 仅兜底 */
  thumb?: string | null;
  height?: number;
}) {
  const styles = useStyles();
  const uri = absoluteUri(filePath || thumb);

  if (!uri) {
    return (
      <View style={[styles.stage, { height }]}>
        <Ionicons name="image-outline" size={26} color={Palette.ink4} />
        <Label tone="ink3">还没有照片</Label>
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      style={{ width: '100%', height } as ImageStyle}
      contentFit="cover"
      transition={160}
      cachePolicy="memory-disk"
    />
  );
}

const useStyles = makeStyles((Palette) => ({
  placeholder: {
    backgroundColor: Palette.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stage: {
    backgroundColor: Palette.inset,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
}));
