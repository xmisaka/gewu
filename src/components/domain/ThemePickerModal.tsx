/**
 * 格物 · 外观主题选择器
 *
 * 和排序 / 分类选择器同构：底部弹出的 Modal，不进路由。
 *
 * 只列四套浅色 —— 深色档（玄夜）不进这个列表。它不是「第五个选项」，
 * 而是系统深色时的自动接管，让用户手动选它等于要维护五套可选项。
 */

import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import {
  GUTTER,
  LIGHT_THEME_KEYS,
  Palette,
  Radius,
  Space,
  THEMES,
  type ThemeKey,
} from '@/constants/theme';
import { makeStyles } from '@/lib/theme';
import { Divider } from '../ui/layout';
import { Body, Heading, Meta } from '../ui/typography';

export interface ThemePickerModalProps {
  visible: boolean;
  /** 用户当前选择的浅色主题 */
  value: ThemeKey;
  /** 系统此刻是否处于深色 —— 用于提示所选浅色暂未生效 */
  systemDark: boolean;
  onClose: () => void;
  onPick: (key: ThemeKey) => void;
}

export function ThemePickerModal({
  visible,
  value,
  systemDark,
  onClose,
  onPick,
}: ThemePickerModalProps) {
  const styles = useStyles();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Heading>外观主题</Heading>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={Palette.ink3} />
          </Pressable>
        </View>

        <View style={styles.list}>
          {LIGHT_THEME_KEYS.map((key, index) => (
            <View key={key}>
              {index > 0 ? <Divider /> : null}
              <ThemeOption themeKey={key} active={key === value} onPress={() => onPick(key)} />
            </View>
          ))}
        </View>

        <View style={styles.foot}>
          <Meta tone="ink3">
            {systemDark
              ? '系统当前是深色模式，界面正用「玄夜」，上面四套暂时看不到效果；关掉系统深色即可。这个选择已经记住了。'
              : '深色档跟随系统：系统切到深色时界面自动换成「玄夜」，这里的浅色选择会留着 —— 白天切回来还是这套。'}
          </Meta>
        </View>
      </View>
    </Modal>
  );
}

function ThemeOption({
  themeKey,
  active,
  onPress,
}: {
  themeKey: ThemeKey;
  active: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const def = THEMES[themeKey];

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`主题 ${def.name}`}
      onPress={onPress}
      android_ripple={{ color: Palette.ripple }}
      style={styles.option}>
      {/* 色点取该套主题的品牌色，与「我的」页指示器同源 */}
      <View style={[styles.dot, { backgroundColor: def.tokens.brand }]} />

      <View style={styles.optionBody}>
        <Body>{def.name}</Body>
        <Meta tone="ink3">{def.note}</Meta>
      </View>

      {active ? <Ionicons name="checkmark" size={18} color={Palette.brand} /> : null}
    </Pressable>
  );
}

const useStyles = makeStyles((Palette) => ({
  backdrop: { flex: 1, backgroundColor: Palette.scrim },
  sheet: {
    backgroundColor: Palette.surface,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    paddingBottom: Space.xxl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Palette.line,
    alignSelf: 'center',
    marginTop: Space.sm,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingTop: Space.lg,
    paddingBottom: Space.md,
  },
  list: { paddingHorizontal: GUTTER },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingVertical: Space.md,
  },
  dot: { width: 26, height: 26, borderRadius: 13 },
  optionBody: { flex: 1, gap: 1 },
  foot: {
    paddingHorizontal: GUTTER,
    paddingTop: Space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
  },
}));
