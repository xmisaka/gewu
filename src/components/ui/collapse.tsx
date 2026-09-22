/**
 * 格物 · 折叠容器
 *
 * 把子区块的自然高度量下来，再用 progress（1 = 展开 / 0 = 收起）去插值高度。
 * 高度是在 UI 线程改的，跟着手指走，不会因为 JS 线程忙而掉帧。
 *
 * 里面那层 View 不是多余的：
 *   外层高度被压到 0 的同一帧里，内层要是被一起压扁，就再也量不到自然高度、
 *   展开回不去了。显式写上 flexShrink: 0 把这件事说死 —— RN 的默认值本来就是 0，
 *   但这一处一旦被谁改成 flex: 1，整个折叠会静默失效（不报错，只是再也不展开）。
 *
 * 透明度的取值刻意保守：只在快收完的最后四成里淡出，高度还剩四成以上时一律
 * 全不透明。反过来的写法（先淡掉、再收高度）观感更顺，但会留出一个
 * 「占着高度、却完全透明」的中间态 —— 万一动画被打断停在那儿，看到的就是
 * 一块空白。这里选可靠性。
 */

import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

export function Collapse({
  progress,
  children,
  style,
}: {
  /** 1 = 展开，0 = 收起 */
  progress: SharedValue<number>;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const natural = useSharedValue(0);

  const clipStyle = useAnimatedStyle(() => {
    // 还没量到高度之前不设 height —— 否则首帧会从 0 弹一下
    if (natural.value <= 0) return {};
    const p = progress.value;
    return {
      height: natural.value * p,
      opacity: interpolate(p, [0, 0.4, 1], [0, 1, 1], Extrapolation.CLAMP),
    };
  }, [progress]);

  return (
    <Animated.View style={[{ overflow: 'hidden' }, clipStyle, style]}>
      <View
        // 只接受量到的正高度：折叠到底时若系统报回一个 0，
        // 收下它就会把自然高度抹掉，之后再展开就成了 0
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (h > 0) natural.value = h;
        }}
        style={{ flexShrink: 0 }}>
        {children}
      </View>
    </Animated.View>
  );
}
