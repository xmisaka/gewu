/**
 * 格物 · 反馈类组件
 */

import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { GUTTER, Palette, Radius, Space, StatusTones } from '@/constants/theme';
import type { ExpiryState } from '@/lib/types';
import { Button } from './controls';
import { Body, Label, Meta, Title } from './typography';
import { makeStyles } from '@/lib/theme';

/* ------------------------------------------------------------ 空态 */

export function EmptyState({
  icon = 'cube-outline',
  title,
  description,
  actionLabel,
  onAction,
  children,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={26} color={Palette.ink4} />
      </View>
      <Title style={styles.emptyTitle}>{title}</Title>
      {description ? (
        <Body tone="ink3" style={styles.emptyDesc}>
          {description}
        </Body>
      ) : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} tone="secondary" block={false} style={styles.emptyAction} />
      ) : null}
      {children}
    </View>
  );
}

/* ------------------------------------------------------------ 加载 */

export function Loading({ label }: { label?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={Palette.brand} />
      {label ? (
        <Meta tone="ink3" style={styles.loadingLabel}>
          {label}
        </Meta>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------ 到期状态标签 */

const STATE_ICON: Record<ExpiryState, keyof typeof Ionicons.glyphMap | null> = {
  overdue: 'alert-circle',
  soon: 'time-outline',
  fine: 'checkmark-circle-outline',
  none: null,
};

/**
 * 到期状态标签。语义与视觉严格绑定：
 * 琥珀=即将到期，橄榄=在库正常，砖红=已过期。不做装饰性使用。
 */
export function StatusTag({
  state,
  text,
  compact,
}: {
  state: ExpiryState;
  text: string;
  compact?: boolean;
}) {
  const styles = useStyles();
  if (state === 'none') return null;
  const tone = StatusTones[state];
  const icon = STATE_ICON[state];

  return (
    <View style={[styles.tag, { backgroundColor: tone.bg }, compact && styles.tagCompact]}>
      {icon ? <Ionicons name={icon} size={compact ? 10 : 11} color={tone.fg} /> : null}
      <Label style={[styles.tagText, { color: tone.fg }]}>{text}</Label>
    </View>
  );
}

/* ------------------------------------------------------------ 中性标签 */

/**
 * PlainTag 的配色档。
 *
 * ★ sage / amber / clay 三档**刻意不复用 StatusTones**。
 *   StatusTones 说的是「保质期」，这三档说的是「余量」—— 色值一样，语义不同。
 *   共用一个表，将来任何一边要调（比如把「即将见底」换成别的色相），
 *   就会顺手把到期标签一起改掉，而那次改动看上去毫无关联。
 */
export type PlainTagTone = 'neutral' | 'brand' | 'sage' | 'amber' | 'clay';

/**
 * 取档位对应的前后景。写成函数而不是模块级常量：
 * Palette 是渲染期解析的代理，在模块加载期读出来的色值会被固化，
 * 换主题时这一块不会跟着变（而且不报错）。
 */
function plainTagTone(tone: PlainTagTone): { fg: string; bg: string } {
  switch (tone) {
    case 'brand':
      return { fg: Palette.brand, bg: Palette.brandBg };
    case 'sage':
      return { fg: Palette.sage, bg: Palette.sageBg };
    case 'amber':
      return { fg: Palette.amber, bg: Palette.amberBg };
    case 'clay':
      return { fg: Palette.clay, bg: Palette.clayBg };
    default:
      return { fg: Palette.ink2, bg: Palette.inset };
  }
}

export function PlainTag({
  text,
  icon,
  tone = 'neutral',
  numeric,
  style,
}: {
  text: string;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: PlainTagTone;
  /** 内容是数字时打开等宽数字，免得「剩 1」和「剩 11」宽度跳来跳去 */
  numeric?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  const { fg, bg } = plainTagTone(tone);
  return (
    // 传进来的 style 放在最后，这样它能把自带的 alignSelf: 'flex-start' 掰回来
    // （列表行尾的胶囊需要右对齐）
    <View style={[styles.tag, { backgroundColor: bg }, style]}>
      {icon ? <Ionicons name={icon} size={11} color={fg} /> : null}
      <Label style={[styles.tagText, { color: fg }, numeric && styles.tagNumeric]}>{text}</Label>
    </View>
  );
}

/* ------------------------------------------------------------ 概览条 */

export function MetricStrip({
  metrics,
  framed = true,
}: {
  metrics: { label: string; value: string; tone?: 'ink' | 'brand' | 'clay' | 'amber' }[];
  /** false = 去掉自带卡片外壳，用于塞进已有的 Card 里（我的页概览用） */
  framed?: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.strip, !framed && styles.stripBare]}>
      {metrics.map((m, i) => (
        <View key={m.label} style={[styles.stripCell, i > 0 && styles.stripCellBorder]}>
          <Label
            style={styles.stripValue}
            color={
              m.tone === 'brand'
                ? Palette.brand
                : m.tone === 'clay'
                  ? Palette.clay
                  : m.tone === 'amber'
                    ? Palette.amber
                    : Palette.ink
            }>
            {m.value}
          </Label>
          <Meta tone="ink3" style={styles.stripLabel}>
            {m.label}
          </Meta>
        </View>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------ 语义计数条 */

export type LegendTone = 'fine' | 'soon' | 'overdue';

/**
 * 首页那条状态计数条：正常 / 将到期 / 已过期。
 *
 * 三项互斥，合计必须等于总数 —— 用户会拿它对总数，对不上就会怀疑数据错了。
 * 所以数字由调用方保证（见 getStats 的 fineCount，用总数减出来）。
 *
 * 左右留白用 GUTTER：它浮在画布上、不在任何卡片里。真要塞进卡片，
 * 得改用按卡内缘算的边距，直接叠 GUTTER 会翻倍。
 */
export function LegendStrip({ items }: { items: { tone: LegendTone; label: string; count: number }[] }) {
  const styles = useStyles();
  return (
    <View style={styles.legend}>
      {items.map((it) => {
        const tone = StatusTones[it.tone];
        return (
          <View key={it.tone} style={[styles.legendPill, { backgroundColor: tone.bg }]}>
            <Label style={[styles.legendText, { color: tone.fg }]}>
              {it.label} {it.count}
            </Label>
          </View>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------ 撤销条 */

/** 撤销条自动消失的时长。4 秒是「来得及反应」与「别挡着我继续用」的折中 */
export const UNDO_BAR_MS = 4000;

export interface UndoAction {
  /** 一句话说清刚才干了什么，如「已用掉 1 件 · 还剩 2」 */
  message: string;
  onUndo: () => void;
}

/**
 * 底部浮动撤销条。
 *
 * ★ 两条容易写错、错了也不报错的地方：
 *
 * 1. **计时器不能把 `onDismiss` 写进依赖数组**。调用方几乎一定写成
 *    `onDismiss={() => setUndo(null)}`，那是个每次渲染都换新的箭头函数，
 *    于是每渲染一次就清掉重设一次计时器 —— 只要页面在动，撤销条就永远不消失。
 *    所以最新的回调只放在 ref 里，依赖数组里只留 action。
 *    （ref 的同步写在 effect 里而不是渲染期：渲染期写 ref 会被 lint 拦下，
 *      而且并发渲染下本来就不该这么做。它排在计时器 effect 之前，先跑。）
 *
 * 2. **`action` 每变一次都要重新计时**（包括第一次）。连点两下 −1 时，
 *    第二下应该拿到完整的 4 秒，而不是「第一下的计时器还没走完就一起消失」——
 *    那样用户刚看清消息它就没了。用 action 的对象身份当依赖就能做到：
 *    调用方每次都要造一个新对象。
 *
 * 只有进场动画、没有退场动画：退场要留住最后一个 action 才能把文字继续渲染出来，
 * 那就得再养一份 state、还得在 effect 里同步它。一条 4 秒就走的浮条不值得。
 */
export function UndoBar({
  action,
  onDismiss,
  duration = UNDO_BAR_MS,
}: {
  action: UndoAction | null;
  /** 自动消失或点了撤销之后回调。**不必是稳定引用**，见上面第 1 条 */
  onDismiss: () => void;
  duration?: number;
}) {
  const styles = useStyles();
  const dismissRef = useRef(onDismiss);
  const progress = useSharedValue(0);

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!action) return;
    progress.value = 0;
    progress.value = withTiming(1, { duration: 180 });
    const timer = setTimeout(() => dismissRef.current(), duration);
    return () => clearTimeout(timer);
  }, [action, duration, progress]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 16 }],
  }));

  // 隐藏时整条不渲染：留着它就得处理「挡住下面那一行的点击」，还得操心
  // 「退场到一半又进来一条」的状态。直接消失最省事，观感上也没损失。
  if (!action) return null;

  return (
    <Animated.View style={[styles.undoWrap, animStyle]}>
      <View style={styles.undoBar}>
        <Meta style={styles.undoText} numberOfLines={1}>
          {action.message}
        </Meta>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="撤销刚才的操作"
          hitSlop={8}
          onPress={() => {
            action.onUndo();
            onDismiss();
          }}
          style={({ pressed }) => [styles.undoBtn, pressed && styles.undoBtnPressed]}>
          <Label style={styles.undoBtnText}>撤销</Label>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const useStyles = makeStyles((Palette) => ({
  empty: {
    alignItems: 'center',
    paddingHorizontal: GUTTER + 16,
    paddingVertical: Space.xxxl + Space.sm,
    gap: Space.sm,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Palette.inset,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.xs,
  },
  emptyTitle: { textAlign: 'center' },
  emptyDesc: { textAlign: 'center', lineHeight: 21 },
  emptyAction: { marginTop: Space.md },

  loading: { alignItems: 'center', paddingVertical: Space.xxxl, gap: Space.md },
  loadingLabel: { marginTop: Space.sm },

  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.tag,
    alignSelf: 'flex-start',
  },
  tagCompact: { paddingHorizontal: 5, paddingVertical: 1 },
  tagText: { fontSize: 11 },
  tagNumeric: { fontVariant: ['tabular-nums'] },

  strip: {
    flexDirection: 'row',
    marginHorizontal: GUTTER,
    marginTop: Space.md,
    backgroundColor: Palette.surface,
    borderRadius: Radius.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line2,
    overflow: 'hidden',
  },
  stripCell: { flex: 1, paddingVertical: Space.md, paddingHorizontal: Space.sm, alignItems: 'center', gap: 2 },
  stripCellBorder: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: Palette.line2 },
  stripValue: { fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  stripLabel: { fontSize: 11.5 },
  /* 裸壳：放进 Card 时要把自带的外壳全部撤掉，只留三格的排布 */
  stripBare: {
    marginHorizontal: 0,
    marginTop: 0,
    backgroundColor: 'transparent',
    borderRadius: 0,
    borderWidth: 0,
  },

  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.sm,
    marginHorizontal: GUTTER,
    marginTop: Space.md,
  },
  legendPill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: Radius.chip },
  legendText: { fontSize: 12, fontWeight: '600' },

  /* 撤销条：浮在 Tab 栏正上方。用 GUTTER 对齐，与列表卡片的左右缘一致。
     位置绝对定位 —— 它不该把下面的内容顶下去（顶下去会让列表在出现/消失时跳一下） */
  undoWrap: { position: 'absolute', left: 0, right: 0, bottom: Space.lg, paddingHorizontal: GUTTER },
  undoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
    paddingLeft: Space.lg,
    paddingRight: Space.sm,
    paddingVertical: Space.sm,
    borderRadius: Radius.button,
    backgroundColor: Palette.ink,
  },
  undoText: { flex: 1, fontSize: 12.5, color: Palette.pure },
  undoBtn: { paddingHorizontal: Space.md, paddingVertical: Space.xs, borderRadius: Radius.tag },
  undoBtnPressed: { opacity: 0.6 },
  /* ★ 浮条压在深色底上，文字用 pure 而不是品牌色 —— 深色背景上压品牌色会糊成一团 */
  undoBtnText: { fontSize: 12.5, fontWeight: '600', color: Palette.pure },
}));
