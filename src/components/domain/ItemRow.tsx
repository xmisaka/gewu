/**
 * 格物 · 物品列表行
 *
 * 一行承载四件事：有图没图、叫什么、在哪、值不值。
 * 日均成本只在这一行显示为次要信息，主位留给状态标签。
 */

import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Palette, Space } from '@/constants/theme';
import { describePurchase } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import type { ItemView } from '@/lib/types';
import { PlainTag, StatusTag } from '../ui/feedback';
import { ItemText, Meta } from '../ui/typography';
import { PhotoThumb } from './media';
import { makeStyles } from '@/lib/theme';

export interface ItemRowProps {
  item: ItemView;
  onPress?: (item: ItemView) => void;
  /** 长按进入多选 */
  onLongPress?: (item: ItemView) => void;
  selected?: boolean;
  /** 多选模式 */
  selecting?: boolean;
  /**
   * 是否显示手动排序值。
   * 只在列表按「手动排序」排列时打开 —— 平时把它挂出来是纯噪音，
   * 但那档下面必须看得见数字，否则用户不知道自己要改什么。
   */
  showSortOrder?: boolean;
}

function expiryTextOf(item: ItemView): string {
  if (item.daysToExpiry == null) return '';
  if (item.daysToExpiry < 0) return `过期 ${Math.abs(item.daysToExpiry)} 天`;
  if (item.daysToExpiry === 0) return '今天到期';
  return `${item.daysToExpiry} 天后到期`;
}

export const ItemRow = memo(function ItemRow({
  item,
  onPress,
  onLongPress,
  selected,
  selecting,
  showSortOrder,
}: ItemRowProps) {
  const styles = useStyles();
  const subtitleParts: string[] = [];
  if (item.categoryName) subtitleParts.push(item.categoryName);
  subtitleParts.push(describePurchase(item.purchaseDate));

  const locationText = item.locationName
    ? item.cabinetName
      ? `${item.cabinetName} · ${item.locationName}`
      : item.locationName
    : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.name}，${item.categoryName ?? '未分类'}`}
      onPress={() => onPress?.(item)}
      onLongPress={() => onLongPress?.(item)}
      android_ripple={{ color: Palette.ripple }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      {selecting ? (
        <View style={[styles.check, selected && styles.checkOn]}>
          {selected ? <Ionicons name="checkmark" size={13} color={Palette.onAccent} /> : null}
        </View>
      ) : null}

      <PhotoThumb thumb={item.coverThumb} name={item.name} size={46} />

      <View style={styles.body}>
        <ItemText numberOfLines={1}>{item.name}</ItemText>

        <View style={styles.metaLine}>
          <Meta tone="ink3" numberOfLines={1} style={styles.metaText}>
            {subtitleParts.join(' · ')}
          </Meta>
        </View>

        <View style={styles.tagLine}>
          {showSortOrder ? (
            item.sortOrder != null ? (
              <PlainTag text={`排序 ${item.sortOrder}`} icon="reorder-four-outline" tone="brand" />
            ) : (
              <PlainTag text="未排序" icon="reorder-four-outline" />
            )
          ) : null}
          {locationText ? <PlainTag text={locationText} icon="location-outline" /> : null}
          {item.expiry !== 'none' ? (
            <StatusTag state={item.expiry} text={expiryTextOf(item)} compact />
          ) : null}
          {item.photoCount > 1 ? (
            <PlainTag text={`${item.photoCount} 张`} icon="images-outline" />
          ) : null}
        </View>
      </View>

      <View style={styles.tail}>
        {item.price != null ? (
          <ItemText style={styles.price}>{formatMoney(item.price)}</ItemText>
        ) : null}
        {item.dailyCost != null ? (
          <Meta tone="brand" style={styles.daily}>
            {item.dailyCost >= 0.01 ? `¥${item.dailyCost.toFixed(2)}/天` : '日均 <¥0.01'}
          </Meta>
        ) : null}
      </View>
    </Pressable>
  );
});

const useStyles = makeStyles((Palette) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    /* 左右留白交给外层卡片的外边距，这里只负责卡片内的呼吸区 ——
       所以用 Space.lg 而不是 GUTTER，否则两层边距一叠加内容会缩得太狠 */
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    backgroundColor: Palette.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.line3,
  },
  rowPressed: { backgroundColor: Palette.surface2 },
  check: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.ink4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: Palette.brand, borderColor: Palette.brand },
  body: { flex: 1, gap: 3 },
  metaLine: { flexDirection: 'row', alignItems: 'center' },
  metaText: { flex: 1 },
  tagLine: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, flexWrap: 'wrap' },
  tail: { alignItems: 'flex-end', gap: 2, minWidth: 62 },
  price: { fontSize: 15 },
  daily: { fontSize: 11.5, fontVariant: ['tabular-nums'] },
}));
