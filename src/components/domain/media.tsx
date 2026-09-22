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

/** 详情页大图位；缺图时给出明确的空位提示而不是灰色块 */
export function PhotoStage({
  thumb,
  name,
  height = 220,
}: {
  thumb: string | null;
  name: string;
  height?: number;
}) {
  const styles = useStyles();
  const uri = absoluteUri(thumb);

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
