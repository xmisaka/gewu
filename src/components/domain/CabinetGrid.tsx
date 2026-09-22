/**
 * 格物 · 柜子网格
 *
 * 收纳柜的核心视图：一眼看到每个柜子装了多少、哪几格是满的。
 * 占用示意用方块矩阵而非进度条 —— 方块能传达「第几格」的位置感，
 * 进度条只传达比例。
 */

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { GUTTER, Palette, Radius, Shadow, Space } from '@/constants/theme';
import type { CabinetView } from '@/lib/types';
import { Label, Meta, Title } from '../ui/typography';
import { makeStyles } from '@/lib/theme';

/** 占用示意最多显示几格，超出以 +N 表示 */
const MAX_DOTS = 12;

export function CabinetGrid({
  cabinets,
  onOpen,
  onAdd,
}: {
  cabinets: CabinetView[];
  onOpen: (cabinet: CabinetView) => void;
  onAdd?: () => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.grid}>
      {cabinets.map((cabinet) => (
        <CabinetCard key={cabinet.id} cabinet={cabinet} onPress={() => onOpen(cabinet)} />
      ))}
      {onAdd ? <AddCabinetCard onPress={onAdd} /> : null}
    </View>
  );
}

function CabinetCard({ cabinet, onPress }: { cabinet: CabinetView; onPress: () => void }) {
  const styles = useStyles();
  const dots = cabinet.slots.slice(0, MAX_DOTS);
  const overflow = cabinet.slots.length - dots.length;

  return (
    <View style={styles.cell}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${cabinet.name}，${cabinet.totalCount} 件物品`}
        onPress={onPress}
        android_ripple={{ color: Palette.ripple }}
        style={({ pressed }) => [styles.cardInner, pressed && styles.pressed]}>
        <Title style={styles.cardTitle} numberOfLines={1}>
          {cabinet.name}
        </Title>

        {cabinet.slots.length === 0 ? (
          <Meta tone="ink4" style={styles.emptyHint}>
            还没有格位
          </Meta>
        ) : (
          <View style={styles.dotWrap}>
            {dots.map((s) => (
              <View
                key={s.slot.id}
                style={[styles.dot, s.itemCount > 0 ? styles.dotFilled : styles.dotEmpty]}
              />
            ))}
            {overflow > 0 ? (
              <Label tone="ink3" style={styles.overflow}>
                +{overflow}
              </Label>
            ) : null}
          </View>
        )}

        <View style={styles.cardFoot}>
          <Label tone={cabinet.totalCount > 0 ? 'brand' : 'ink4'}>{cabinet.totalCount} 件</Label>
          <Meta tone="ink4">
            {cabinet.occupiedSlots}/{cabinet.slots.length} 格在用
          </Meta>
        </View>
      </Pressable>
    </View>
  );
}

function AddCabinetCard({ onPress }: { onPress: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.cell}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="新建柜子"
        onPress={onPress}
        style={({ pressed }) => [styles.cardInner, styles.addCard, pressed && styles.pressed]}>
        <Ionicons name="add" size={20} color={Palette.ink3} />
        <Label tone="ink3">新建柜子</Label>
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((Palette) => ({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: GUTTER - Space.xs,
    paddingTop: Space.xs,
  },
  cell: { width: '50%', paddingHorizontal: Space.xs, marginBottom: Space.sm + 2 },
  cardInner: {
    backgroundColor: Palette.surface,
    borderRadius: Radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line2,
    padding: Space.md,
    ...Shadow.card,
  },
  pressed: { opacity: 0.8 },
  cardTitle: { fontSize: 16, marginBottom: Space.sm },
  emptyHint: { marginBottom: Space.md, minHeight: 22 },
  dotWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginBottom: Space.md, minHeight: 22 },
  dot: { width: 7, height: 22, borderRadius: 2 },
  dotFilled: { backgroundColor: Palette.brand },
  dotEmpty: { backgroundColor: Palette.line },
  overflow: { fontSize: 11, alignSelf: 'center', marginLeft: 2 },
  cardFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
    paddingTop: Space.sm,
  },
  addCard: {
    minHeight: 108,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
    borderStyle: 'dashed',
    borderColor: Palette.line,
    backgroundColor: 'transparent',
    shadowOpacity: 0,
    elevation: 0,
  },
}));
