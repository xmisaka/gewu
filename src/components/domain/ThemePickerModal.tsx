/**
 * 格物 · 外观主题选择器
 *
 * 和排序 / 分类选择器同构：底部弹出的 Modal，不进路由。
 *
 * 只列六套浅色 —— 深色档（玄夜）不进这个列表。它不是「第七个选项」，
 * 而是系统深色时的自动接管，让用户手动选它等于要多维护一套可选项。
 *
 * 免费档可用「素笺」「靛青」「青瓷」三套；朱砂、藕荷、胭脂带「支持者」标，
 * 点它不换肤、改为弹门控浮层。列表顺序由 LIGHT_THEME_KEYS 决定 ——
 * 免费三套在前、会员三套在后，于是「前三个没标、后三个有标」，
 * 分界一眼可见。判断走 lib/entitlement 里那张唯一的表，这里不自己写规则。
 */

import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  GUTTER,
  LIGHT_THEME_KEYS,
  Palette,
  Radius,
  Space,
  THEMES,
  type ThemeKey,
} from '@/constants/theme';
import { isThemeLocked } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/store/entitlement';
import { makeStyles, useTheme } from '@/lib/theme';
import { PlainTag } from '../ui/feedback';
import { Divider } from '../ui/layout';
import { Body, Heading, Meta } from '../ui/typography';

export interface ThemePickerModalProps {
  visible: boolean;
  /** 用户当前**生效**的浅色主题 */
  value: ThemeKey;
  /** 系统此刻是否处于深色 —— 用于提示所选浅色暂未生效 */
  systemDark: boolean;
  onClose: () => void;
  onPick: (key: ThemeKey) => void;
  /** 点到被挡下的主题时：由外层关掉本弹层并弹门控浮层 */
  onLockedPick: (key: ThemeKey) => void;
}

export function ThemePickerModal({
  visible,
  value,
  systemDark,
  onClose,
  onPick,
  onLockedPick,
}: ThemePickerModalProps) {
  const styles = useStyles();
  const { entitled } = useEntitlement();
  const { preferredLightKey, lightKeyLocked } = useTheme();

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

        {/* 六套比原来长了一截：小屏或大字体下会顶到屏幕顶，
            加一个滚动兜底。列表本身不滚动时观感与原来一致 */}
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {LIGHT_THEME_KEYS.map((key, index) => (
            <View key={key}>
              {index > 0 ? <Divider /> : null}
              <ThemeOption
                themeKey={key}
                active={key === value}
                locked={isThemeLocked(key, entitled)}
                onPress={() => (isThemeLocked(key, entitled) ? onLockedPick(key) : onPick(key))}
              />
            </View>
          ))}
        </ScrollView>

        <View style={styles.foot}>
          {/* 被挡下的是「用户自己挑过的那一套」时，必须解释一句 ——
              否则他上次明明选的是靛青，这次进来看到素笺，只会当成 bug */}
          {lightKeyLocked ? (
            <Meta tone="ink3">
              {`你之前选的「${THEMES[preferredLightKey].name}」属于支持者功能，现在按「素笺」显示。
              激活之后它会自动回来，不用再选一次。`}
            </Meta>
          ) : (
            <Meta tone="ink3">
              {systemDark
                ? '系统当前是深色模式，界面正用「玄夜」，上面六套暂时看不到效果；关掉系统深色即可。这个选择已经记住了。'
                : '深色档跟随系统：系统切到深色时界面自动换成「玄夜」，这里的浅色选择会留着 —— 白天切回来还是这套。'}
            </Meta>
          )}
        </View>
      </View>
    </Modal>
  );
}

function ThemeOption({
  themeKey,
  active,
  locked,
  onPress,
}: {
  themeKey: ThemeKey;
  active: boolean;
  locked: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const def = THEMES[themeKey];

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: active, disabled: locked }}
      accessibilityLabel={locked ? `主题 ${def.name}，支持者功能` : `主题 ${def.name}`}
      onPress={onPress}
      android_ripple={{ color: Palette.ripple }}
      style={styles.option}>
      {/* 色点取该套主题的品牌色，与「我的」页指示器同源。
          被挡下时降透明度而不是换成灰色 —— 灰点会让用户以为这套配色本身是灰的 */}
      <View
        style={[styles.dot, { backgroundColor: def.tokens.brand }, locked && styles.dotLocked]}
      />

      <View style={styles.optionBody}>
        <Body>{def.name}</Body>
        <Meta tone="ink3">{def.note}</Meta>
      </View>

      {locked ? (
        <PlainTag text="支持者" tone="brand" />
      ) : active ? (
        <Ionicons name="checkmark" size={18} color={Palette.brand} />
      ) : null}
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
  /* 六套之后列表长了一截：给个上限让它必要时可滚，
     否则小屏或大字体下会把下面的脚注与关闭按钮顶出屏幕 */
  list: { paddingHorizontal: GUTTER, maxHeight: '62%' },
  listContent: { paddingBottom: Space.xs },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingVertical: Space.md,
  },
  dot: { width: 26, height: 26, borderRadius: 13 },
  /* 被挡下的色点降透明度：把「现在不能用」表达出来，同时保留它本来的颜色 */
  dotLocked: { opacity: 0.45 },
  optionBody: { flex: 1, gap: 1 },
  foot: {
    paddingHorizontal: GUTTER,
    paddingTop: Space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
  },
}));
