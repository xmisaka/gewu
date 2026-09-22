/**
 * 格物 · 位置选择器
 *
 * 两级结构：柜子 → 格位。允许只选到柜子层级 ——
 * 强迫用户必须先建格位才能存东西，会让「位置」这个字段被放弃使用。
 */

import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import type { CabinetView } from '@/lib/types';
import { Button } from '../ui/controls';
import { Divider } from '../ui/layout';
import { Body, Heading, Label, Meta } from '../ui/typography';
import { makeStyles } from '@/lib/theme';

export interface LocationPickerModalProps {
  visible: boolean;
  cabinets: CabinetView[];
  /** 当前选中项 */
  selectedId: string | null;
  onClose: () => void;
  onPick: (locationId: string | null) => void;
  onManage?: () => void;
}

export function LocationPickerModal({
  visible,
  cabinets,
  selectedId,
  onClose,
  onPick,
  onManage,
}: LocationPickerModalProps) {
  const styles = useStyles();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Heading>选择位置</Heading>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={Palette.ink3} />
          </Pressable>
        </View>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          <PickRow
            label="不指定位置"
            icon="remove-circle-outline"
            active={selectedId === null}
            onPress={() => {
              onPick(null);
              onClose();
            }}
          />
          <Divider />

          {cabinets.map((cabinet) => (
            <View key={cabinet.id}>
              <PickRow
                label={cabinet.name}
                hint={`${cabinet.totalCount} 件`}
                icon="file-tray-stacked-outline"
                active={selectedId === cabinet.id}
                onPress={() => {
                  onPick(cabinet.id);
                  onClose();
                }}
              />

              {cabinet.slots.map((s) => (
                <PickRow
                  key={s.slot.id}
                  label={s.slot.name}
                  hint={s.itemCount > 0 ? `${s.itemCount} 件` : undefined}
                  indent
                  active={selectedId === s.slot.id}
                  onPress={() => {
                    onPick(s.slot.id);
                    onClose();
                  }}
                />
              ))}
              <Divider />
            </View>
          ))}

          {cabinets.length === 0 ? (
            <View style={styles.empty}>
              <Meta tone="ink3">还没有柜子。先建一个，再往里加格位。</Meta>
            </View>
          ) : null}
        </ScrollView>

        {onManage ? (
          <View style={styles.foot}>
            <Button label="管理柜子与格位" tone="secondary" icon="grid-outline" onPress={onManage} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function PickRow({
  label,
  hint,
  icon,
  active,
  indent,
  onPress,
}: {
  label: string;
  hint?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  active?: boolean;
  indent?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      android_ripple={{ color: Palette.ripple }}
      style={[styles.pickRow, indent && styles.pickRowIndent]}>
      {icon ? (
        <Ionicons name={icon} size={16} color={Palette.ink3} />
      ) : (
        <View style={styles.bullet} />
      )}
      <Body style={styles.pickLabel} tone={indent ? 'ink2' : 'ink'}>
        {label}
      </Body>
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
    maxHeight: '78%',
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
  pickRowIndent: { paddingLeft: Space.xl },
  bullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: Palette.line },
  pickLabel: { flex: 1 },
  pickHint: { marginRight: Space.xs },
  empty: { paddingVertical: Space.xxl, alignItems: 'center' },
  foot: { paddingHorizontal: GUTTER, paddingTop: Space.md },
}));
