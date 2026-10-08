/**
 * 格物 · 库存快捷面板
 *
 * 底部滑出的浮层，列表行尾那个只读胶囊点开就是它。
 *
 * ★ 为什么独立成组件、不塞进 ItemRow：
 *   它是**页面级浮层**（Modal 一开就接管整屏），而 ItemRow 会被列表虚拟化
 *   反复挂载 / 卸载 —— 把 Modal 挂在行里，滚动一下它就会被重建，
 *   面板会自己关掉或者闪一下。挂在页面根上就只有一个实例。
 *
 * ★ 为什么按完不自动关：
 *   连用两件是常见场景（拆两盒药、开两瓶酱油）。自动关会逼用户
 *   「点胶囊 → 点 −1 → 面板没了 → 再点胶囊 → 再点 −1」，把 2 步变成 4 步。
 *   这里的两个大按钮本身就是确认，按完数字当场变，不需要「关掉面板」来收尾。
 */

import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import { stockState, stockStateText } from '@/lib/stock';
import type { StockState } from '@/lib/types';
import { makeStyles } from '@/lib/theme';
import { Body, Label, Meta } from '../ui/typography';

/**
 * 三档语义色，与列表胶囊、详情页库存卡同一套。
 * 写成函数而不是模块级常量表：Palette 是渲染期解析的代理，
 * 模块加载期读出来的色值会被固化，换主题时这里不会跟着变（而且不报错）。
 */
function stateColor(state: StockState): string {
  if (state === 'empty') return Palette.clay;
  if (state === 'low') return Palette.amber;
  if (state === 'ok') return Palette.sage;
  return Palette.ink3;
}

export interface StockSheetTarget {
  id: string;
  name: string;
  /** 当前剩余件数；调用方保证只有启用了库存的物品才会打开面板 */
  quantity: number;
  /** 副标题里的过期信息，没有就不显示 */
  expireText?: string | null;
}

export function StockSheet({
  target,
  onClose,
  onStep,
  onSetEmpty,
  onEditQuantity,
  busy,
}: {
  target: StockSheetTarget | null;
  onClose: () => void;
  /** ±1；由调用方负责落库、刷新与弹撤销条 */
  onStep: (delta: number) => void;
  /** 「本次用完」：直接置 0，不逐件点 */
  onSetEmpty: () => void;
  /** 「改成别的数」：跳去详情页编辑，不走这个面板 */
  onEditQuantity: () => void;
  busy?: boolean;
}) {
  const styles = useStyles();
  const open = target != null;
  const quantity = target?.quantity ?? 0;
  const state = stockState(quantity);
  const fg = stateColor(state);
  const canTake = quantity > 0 && !busy;

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      // Android 实体返回键要能关掉它，否则会直接退出页面
      onRequestClose={onClose}>
      {/* 遮罩本身也是一整块按钮：点空白关面板是所有人的第一直觉 */}
      <Pressable accessibilityLabel="关闭库存面板" style={styles.scrim} onPress={onClose}>
        {/* 面板本体要吃掉点击，不然会穿透到遮罩上、点哪儿都关 */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />

          <View style={styles.head}>
            <Body style={styles.title} numberOfLines={1}>
              {target?.name ?? ''}
            </Body>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
              hitSlop={10}
              onPress={onClose}
              style={styles.close}>
              <Ionicons name="close" size={16} color={Palette.ink4} />
            </Pressable>
          </View>

          <View style={styles.numRow}>
            <View style={styles.numWrap}>
              <Label color={fg} style={styles.num}>
                {quantity}
              </Label>
              <Meta tone="ink4" style={styles.numUnit}>
                件
              </Meta>
            </View>
            <Meta color={fg} style={styles.stateText}>
              {stockStateText(quantity)}
            </Meta>
          </View>

          {target?.expireText ? (
            <Meta tone="ink3" style={styles.subline}>
              {target.expireText}
            </Meta>
          ) : null}

          <View style={styles.btns}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`用掉一件，${target?.name ?? ''}`}
              accessibilityState={{ disabled: !canTake }}
              disabled={!canTake}
              onPress={() => onStep(-1)}
              style={({ pressed }) => [
                styles.btn,
                styles.btnPrimary,
                pressed && canTake && styles.btnPressed,
                !canTake && styles.btnDisabled,
              ]}>
              <Label style={styles.btnPrimaryText}>用掉一件</Label>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`补一件，${target?.name ?? ''}`}
              disabled={!!busy}
              onPress={() => onStep(1)}
              style={({ pressed }) => [
                styles.btn,
                styles.btnPlain,
                pressed && !busy && styles.btnPressed,
                busy && styles.btnDisabled,
              ]}>
              <Label style={styles.btnPlainText}>补一件</Label>
            </Pressable>
          </View>

          {/* 两个低频出口摆成一行小字，不占视觉重量：
              「标记用完」直接置 0，「改成别的数」去详情页（那里能看到全部上下文）。
              「标记用完」这个说法与详情页库存卡上的那一个刻意保持一致 ——
              同一个动作在两个入口叫两个名字，用户会以为是两件事。 */}
          <View style={styles.links}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="标记用完"
              disabled={!canTake}
              hitSlop={8}
              onPress={onSetEmpty}>
              <Meta tone={canTake ? 'brand' : 'ink4'} style={styles.linkText}>
                标记用完
              </Meta>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="改成别的数"
              hitSlop={8}
              onPress={onEditQuantity}>
              <Meta tone="brand" style={styles.linkText}>
                改成别的数
              </Meta>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const useStyles = makeStyles((Palette) => ({
  scrim: { flex: 1, backgroundColor: Palette.scrim, justifyContent: 'flex-end' },

  sheet: {
    backgroundColor: Palette.surface,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    paddingHorizontal: GUTTER,
    paddingTop: Space.sm,
    paddingBottom: Space.xxl + Space.sm,
  },
  handle: {
    alignSelf: 'center',
    width: 34,
    height: 4,
    borderRadius: 2,
    backgroundColor: Palette.line3,
    marginBottom: Space.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Space.md },
  title: { flex: 1, fontSize: 15 },
  close: { padding: Space.xs },

  numRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Space.sm, marginTop: Space.sm },
  numWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  /* 大数字与详情页库存卡同一号字，两个入口看上去才是同一个东西 */
  num: { fontSize: 34, fontWeight: '600', lineHeight: 40, fontVariant: ['tabular-nums'] },
  numUnit: { marginBottom: 7 },
  stateText: { fontSize: 12.5, marginBottom: 7 },
  subline: { fontSize: 12.5, marginTop: Space.xxs },

  btns: { flexDirection: 'row', gap: Space.sm, marginTop: Space.lg },
  btn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Space.md,
    borderRadius: Radius.input,
  },
  btnPrimary: { backgroundColor: Palette.brand },
  btnPlain: {
    backgroundColor: Palette.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line2,
  },
  btnPressed: { opacity: 0.75 },
  btnDisabled: { opacity: 0.4 },
  /* ★ 实心品牌底上必须压 onAccent：深色主题下 brand 会变浅，压白字会糊成一团 */
  btnPrimaryText: { fontSize: 13, fontWeight: '600', color: Palette.onAccent },
  btnPlainText: { fontSize: 13, fontWeight: '600', color: Palette.ink2 },

  links: { flexDirection: 'row', justifyContent: 'center', gap: Space.xl, marginTop: Space.md },
  linkText: { fontSize: 11.5 },
}));
