/**
 * 格物 · 列表排序选择器
 *
 * 和分类选择器同构：底部弹出的 Modal，不进路由。
 * 五档排序在这里集中定义，列表页只认 value，不自己写文案。
 */

import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import type { ItemSort } from '@/lib/types';
import { Divider } from '../ui/layout';
import { Body, Heading, Label, Meta } from '../ui/typography';
import { makeStyles } from '@/lib/theme';

export interface SortOption {
  value: ItemSort;
  label: string;
  /** 跟随在选项右侧的一句话说明 */
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
}

/** 顺序即弹层里的呈现顺序 */
export const SORT_OPTIONS: readonly SortOption[] = [
  { value: 'recent', label: '最近变动', hint: '刚改过的排前面', icon: 'time-outline' },
  { value: 'added', label: '最近录入', hint: '刚记进来的排前面', icon: 'add-circle-outline' },
  { value: 'name', label: '名称', hint: '按拼音 A→Z', icon: 'text-outline' },
  { value: 'expire', label: '到期时间', hint: '最快到期的排前面', icon: 'alarm-outline' },
  { value: 'manual', label: '手动排序', hint: '按录入时填的排序值', icon: 'reorder-four-outline' },
];

export function sortOptionOf(sort: ItemSort): SortOption {
  return SORT_OPTIONS.find((o) => o.value === sort) ?? SORT_OPTIONS[0];
}

export function isItemSort(value: string | null | undefined): value is ItemSort {
  return !!value && SORT_OPTIONS.some((o) => o.value === value);
}

export interface SortPickerModalProps {
  visible: boolean;
  value: ItemSort;
  onClose: () => void;
  onPick: (sort: ItemSort) => void;
}

export function SortPickerModal({ visible, value, onClose, onPick }: SortPickerModalProps) {
  const styles = useStyles();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Heading>排序方式</Heading>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={Palette.ink3} />
          </Pressable>
        </View>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {SORT_OPTIONS.map((opt, index) => (
            <View key={opt.value}>
              {index > 0 ? <Divider /> : null}
              <PickRow
                label={opt.label}
                hint={opt.hint}
                icon={opt.icon}
                active={opt.value === value}
                onPress={() => onPick(opt.value)}
              />
            </View>
          ))}
        </ScrollView>

        <View style={styles.foot}>
          <Meta tone="ink3">
            手动排序的数字在录入 / 编辑页的「更多信息 → 排序值」里填，越小越靠前；没填的排在最后。
          </Meta>
        </View>
      </View>
    </Modal>
  );
}

function PickRow({
  label,
  hint,
  icon,
  active,
  onPress,
}: {
  label: string;
  hint?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  active?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      android_ripple={{ color: Palette.ripple }}
      style={styles.pickRow}>
      {icon ? (
        <Ionicons name={icon} size={16} color={active ? Palette.brand : Palette.ink3} />
      ) : null}
      <Body style={styles.pickLabel}>{label}</Body>
      {hint ? (
        <Label tone="ink3" style={styles.pickHint}>
          {hint}
        </Label>
      ) : null}
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
  list: { paddingHorizontal: GUTTER, flexGrow: 0 },
  listContent: { paddingBottom: Space.sm },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingVertical: Space.md,
  },
  pickLabel: { flex: 1 },
  pickHint: { marginRight: Space.xs },
  foot: {
    paddingHorizontal: GUTTER,
    paddingTop: Space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
  },
}));
