/**
 * 格物 · 反馈类组件
 */

import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

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

export function PlainTag({
  text,
  icon,
  tone = 'neutral',
}: {
  text: string;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: 'neutral' | 'brand';
}) {
  const styles = useStyles();
  const fg = tone === 'brand' ? Palette.brand : Palette.ink2;
  const bg = tone === 'brand' ? Palette.brandBg : Palette.inset;
  return (
    <View style={[styles.tag, { backgroundColor: bg }]}>
      {icon ? <Ionicons name={icon} size={11} color={fg} /> : null}
      <Label style={[styles.tagText, { color: fg }]}>{text}</Label>
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
 */
export function LegendStrip({
  items,
}: {
  items: { tone: LegendTone; label: string; count: number }[];
}) {
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
}));
