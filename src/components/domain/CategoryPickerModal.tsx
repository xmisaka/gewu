/**
 * 格物 · 分类选择器
 *
 * 底部弹出的 Modal，录入页与批量补分类共用。
 * 不做成路由：它不承载独立语境，做成路由会让返回栈与表单状态纠缠。
 */

import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import type { CategoryWithCount } from '@/lib/db/categories';
import { Divider } from '../ui/layout';
import { Body, Heading, Label, Meta } from '../ui/typography';
import { makeStyles } from '@/lib/theme';

export interface CategoryPickerModalProps {
  visible: boolean;
  categories: CategoryWithCount[];
  onClose: () => void;
  /** 传 null 表示「未分类」 */
  onPick: (categoryId: string | null) => void;
  title?: string;
  /** 当前选中项，用于打勾 */
  selectedId?: string | null;
}

export function CategoryPickerModal({
  visible,
  categories,
  onClose,
  onPick,
  title = '选择分类',
  selectedId,
}: CategoryPickerModalProps) {
  const styles = useStyles();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Heading>{title}</Heading>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={Palette.ink3} />
          </Pressable>
        </View>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          <PickRow
            label="未分类"
            hint="不归入任何分类"
            icon="remove-circle-outline"
            active={selectedId === null}
            onPress={() => onPick(null)}
          />
          <Divider />
          {categories.map((c) => (
            <View key={c.id}>
              <PickRow
                label={c.name}
                hint={c.itemCount > 0 ? `${c.itemCount} 件` : undefined}
                active={selectedId === c.id}
                onPress={() => onPick(c.id)}
              />
              <Divider />
            </View>
          ))}
          {categories.length === 0 ? (
            <View style={styles.empty}>
              <Meta tone="ink3">分类还没初始化完成，请稍候重试</Meta>
            </View>
          ) : null}
        </ScrollView>
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
      onPress={onPress}
      android_ripple={{ color: Palette.ripple }}
      style={styles.pickRow}>
      {icon ? <Ionicons name={icon} size={16} color={Palette.ink3} /> : null}
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
    maxHeight: '72%',
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
  listContent: { paddingBottom: Space.lg },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingVertical: Space.md,
  },
  pickLabel: { flex: 1 },
  pickHint: { marginRight: Space.xs },
  empty: { paddingVertical: Space.xxl, alignItems: 'center' },
}));
