/**
 * 格物 · 物品列表行
 *
 * 一行承载四件事：有图没图、叫什么、在哪、值不值。
 * 日均成本只在这一行显示为次要信息，主位留给状态标签。
 */

import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Palette, Radius, Space } from '@/constants/theme';
import { describePurchase } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { stockLabel } from '@/lib/stock';
import type { ItemView, StockState } from '@/lib/types';
import { PlainTag, StatusTag, type PlainTagTone } from '../ui/feedback';
import { ItemText, Label, Meta } from '../ui/typography';
import { PhotoThumb } from './media';
import { makeStyles } from '@/lib/theme';

/**
 * 库存状态 → 胶囊配色。
 * 三档语义色锁死：橄榄=还有余量，琥珀=即将见底，砖红=用完了。
 * 与 StatusTones 是两套表，理由见 feedback.tsx 的 PlainTagTone。
 */
const STOCK_TONE: Record<StockState, PlainTagTone> = {
  none: 'neutral',
  ok: 'sage',
  low: 'amber',
  empty: 'clay',
};

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
  /**
   * 手动排序档下的上移 / 下移。
   * 传了才渲染控制钮：其余几档顺序由规则决定，摆一对按不动的箭头是纯噪音。
   */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /**
   * 点数量胶囊 → 唤起底部快捷面板。
   *
   * ★ 胶囊本身**不改数据**，它只是把面板叫出来 —— 这是本方案与「行内放 −1 圆钮」
   *   的根本区别：误触的代价是「多弹一个面板，关掉就完事」，不是「账上少了一件」。
   *   传了才渲染成可点；不传就是一个纯展示的标签。
   */
  onOpenStock?: (item: ItemView) => void;
  /**
   * 行尾快捷「补货 +」，**只在到期页的「该补货了」分组里传**。
   *
   * 为什么这里允许放一个可点控件：那一页的用途就是「照着买」，
   * 而且它只朝**安全方向**改数据 —— 多补一件最多是数多了，点一下就退回来；
   * 首页列表上的 −1 是反过来的（误触就少一件，还得去翻撤销）。两者不是一回事。
   */
  onQuickRestock?: (item: ItemView) => void;
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
  onMoveUp,
  onMoveDown,
  canMoveUp = true,
  canMoveDown = true,
  onOpenStock,
  onQuickRestock,
}: ItemRowProps) {
  const styles = useStyles();
  const reorderable = !!onMoveUp || !!onMoveDown;
  const subtitleParts: string[] = [];
  if (item.categoryName) subtitleParts.push(item.categoryName);
  subtitleParts.push(describePurchase(item.purchaseDate));

  const locationText = item.locationName
    ? item.cabinetName
      ? `${item.cabinetName} · ${item.locationName}`
      : item.locationName
    : null;

  /* 库存元素的三条渲染条件：
     ① 没启用库存（quantity 为 null）什么都不显示 —— 老数据是这一档，行为零变化；
     ② 多选模式下整个胶囊不渲染，那时行内只该有勾选框；
     ③ 调顺序时行尾整块让位给箭头，走的是另一条分支。 */
  const stockEnabled = item.quantity !== null && !selecting;
  const stockTag = stockEnabled ? (
    <PlainTag
      text={stockLabel(item.quantity)}
      tone={STOCK_TONE[item.stock]}
      numeric
      style={styles.tailTag}
    />
  ) : null;

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

      {/* 调顺序时整行让位给箭头：这一档是在「整理」而不是在「看」，价格留着只会挤窄品名。
          箭头竖排、总高与缩略图齐平，行高不会因为多了一对钮而变 */}
      {reorderable ? (
        <View style={styles.reorder}>
          <MoveButton
            icon="chevron-up"
            label={`${item.name} 上移`}
            disabled={!canMoveUp}
            onPress={onMoveUp}
          />
          <MoveButton
            icon="chevron-down"
            label={`${item.name} 下移`}
            disabled={!canMoveDown}
            onPress={onMoveDown}
          />
        </View>
      ) : (
        <View style={styles.tail}>
          {/* 数量胶囊排在价格之上：价格与日均成本一个像素都不动，
              行高也不会因为多了一行而变（缩略图 46 + 上下各 12 = 70，
              三行加起来 56，还在预算里）。 */}
          {onOpenStock && stockTag ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name}，${stockLabel(item.quantity)}，打开库存面板`}
              hitSlop={6}
              onPress={() => onOpenStock(item)}
              android_ripple={{ color: Palette.ripple, borderless: true }}
              style={({ pressed }) => [styles.tailTagBtn, pressed && styles.tailTagPressed]}>
              {stockTag}
            </Pressable>
          ) : (
            stockTag
          )}

          {/* 「补货 +」排在胶囊下面而不是把它顶掉：那一组里「用完了」和「剩 1」
              是两种紧急程度，正是用户决定先买哪个的依据，不能为了腾位置把它抹掉。
              多出来的一行只出现在到期页的那一组里（那一页每组至多几件），
              首页列表永远只有胶囊这一行，行高不变。 */}
          {onQuickRestock && stockEnabled ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name}，补一件`}
              hitSlop={6}
              onPress={() => onQuickRestock(item)}
              android_ripple={{ color: Palette.ripple, borderless: true }}
              style={({ pressed }) => [styles.restock, pressed && styles.tailTagPressed]}>
              <Label style={styles.restockText}>补货</Label>
              <Ionicons name="add" size={13} color={Palette.brand} />
            </Pressable>
          ) : null}

          {item.price != null ? (
            <ItemText style={styles.price}>{formatMoney(item.price)}</ItemText>
          ) : null}
          {item.dailyCost != null ? (
            <Meta tone="brand" style={styles.daily}>
              {item.dailyCost >= 0.01 ? `¥${item.dailyCost.toFixed(2)}/天` : '日均 <¥0.01'}
            </Meta>
          ) : null}
        </View>
      )}
    </Pressable>
  );
});

function MoveButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: 'chevron-up' | 'chevron-down';
  label: string;
  disabled?: boolean;
  onPress?: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      android_ripple={{ color: Palette.ripple, borderless: true }}
      style={({ pressed }) => [
        styles.moveBtn,
        pressed && !disabled && styles.moveBtnPressed,
        disabled && styles.moveBtnDisabled,
      ]}>
      <Ionicons name={icon} size={17} color={Palette.brand} />
    </Pressable>
  );
}

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

  /* 胶囊在 tail 里必须自己把 alignSelf 掰回右侧：
     PlainTag 自带 alignSelf: 'flex-start'，不覆盖的话它会贴到这一列的左边，
     而价格是右对齐的 —— 一左一右，看着像排版坏了（不报错）。 */
  tailTag: { alignSelf: 'flex-end' },
  tailTagBtn: { borderRadius: Radius.tag },
  tailTagPressed: { opacity: 0.6 },
  /* 「补货 +」与胶囊抢同一个位置，观感也保持一致 —— 同一列里出现两种形状会更乱 */
  restock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: Radius.tag,
    backgroundColor: Palette.brandBg,
  },
  restockText: { fontSize: 11, color: Palette.brand },

  /* 手动排序档的上下移。竖排两枚、总高 46 与缩略图齐平，
     行高不因此变化；24 宽也压得住，不至于把品名挤到只剩一个字 */
  reorder: { alignItems: 'center', gap: 2 },
  moveBtn: {
    width: 28,
    height: 22,
    borderRadius: Radius.tag,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.brandBg,
  },
  moveBtnPressed: { opacity: 0.6 },
  moveBtnDisabled: { opacity: 0.3 },
}));
