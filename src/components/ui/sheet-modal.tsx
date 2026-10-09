/**
 * 格物 · 底部弹层的统一外壳（含键盘避让）
 *
 * 五个弹层原来各写一遍「Modal + 背板 + sheet」，于是同一个 bug 也各写了一遍：
 * **键盘弹起来会把输入框盖住**。用户在「自定义端点」里填 URL 时，
 * 输入法直接糊住了输入框，看不见自己打了什么。
 *
 * ── 为什么要手动算键盘高度，而不是用 KeyboardAvoidingView ──────
 * Android 上 `adjustResize` 是设在 **Activity** 上的（见 AndroidManifest），
 * 而 RN 的 `Modal` 在 Android 上是一个**独立的 Dialog 窗口**，不继承这个属性 ——
 * 所以页面里的输入框没事，弹层里的会被盖住。
 * `KeyboardAvoidingView` 在这个 Dialog 里的行为随 RN 版本浮动，
 * 不如直接听键盘事件、把 sheet 抬上去来得确定。
 *
 * ★ 抬起的同时**要压住高度上限**：只抬不压，一个高弹层会被顶出屏幕顶部，
 *   标题和关闭按钮就点不到了。上限留的是「屏幕高 - 键盘高 - 顶部安全区」。
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Palette, Radius, Space } from '@/constants/theme';
import { makeStyles } from '@/lib/theme';

/**
 * 当前键盘高度；没弹起时为 0。
 *
 * iOS 用 `willShow`（动画开始就拿到高度，抬升与键盘同时进行）；
 * Android 只有 `didShow` 可靠 —— `willShow` 在部分 ROM 上不触发。
 */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => setHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener(hideEvent, () => setHeight(0));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return height;
}

export interface SheetModalProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 覆盖 sheet 的默认样式（少数弹层要改内边距或宽度） */
  sheetStyle?: StyleProp<ViewStyle>;
}

export function SheetModal({ visible, onClose, children, sheetStyle }: SheetModalProps) {
  const styles = useStyles();
  const { height: winHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();

  const lifted = keyboard > 0;

  /* 顶到屏幕顶部就点不到关闭按钮了，所以上限要跟着键盘收。
     留 200 的下限：再小就什么都看不见了，那种时候用户该先收起键盘。 */
  const maxHeight = lifted
    ? Math.max(200, winHeight - keyboard - insets.top - Space.lg)
    : undefined;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭"
          onPress={onClose}
          style={styles.backdrop}
        />
        <View
          style={[
            styles.sheet,
            sheetStyle,
            lifted && { marginBottom: keyboard },
            maxHeight != null && { maxHeight },
          ]}>
          <View style={styles.handle} />
          {children}
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles(() => ({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Palette.scrim,
  },
  sheet: {
    backgroundColor: Palette.surface,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    paddingBottom: Space.xxl,
    maxHeight: '85%',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Palette.line,
    alignSelf: 'center',
    marginTop: Space.sm,
  },
}));
