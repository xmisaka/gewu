/**
 * 格物 · 自定义「提前几天提醒」
 *
 * 为什么单开一个弹层，而不是把输入框直接摆在设置行里：
 * 「提前几天」那一行已经摆了四个快捷档，再挤一个输入框进去，在 320dp 屏或
 * 系统放大字体下会**顶出卡片**，而 Card 是 `overflow:'hidden'` ——
 * 挤出去**不报错**，只是那一截看不见。弹层没有这个问题。
 *
 * ★ 走 `SheetModal` 而不是裸 `Modal`：Android 上 RN 的 Modal 是一个独立 Dialog，
 *   不继承 Activity 的 `adjustResize`，键盘会直接盖住输入框（见 ui/sheet-modal.tsx）。
 *
 * ★ 这里**不做静默收敛**：填了「abc」或「999」就当场说明并挡住按钮，
 *   而不是悄悄给他按成 3 天或 365 天 —— 用户正盯着这个框，此时说清楚成本最低。
 *   （真正落库前还会再过一遍 `clampLeadDays`，那是兜底，不是给用户看的。）
 */

import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/controls';
import { Gutter } from '@/components/ui/layout';
import { Body, Heading, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import {
  MAX_LEAD_DAYS,
  MIN_LEAD_DAYS,
  clampLeadDays,
  isValidLeadDays,
  type LeadDays,
} from '@/lib/notify/plan';
import { makeStyles } from '@/lib/theme';
import { SheetModal } from '../ui/sheet-modal';

export interface LeadDaysSheetProps {
  visible: boolean;
  value: LeadDays;
  onClose: () => void;
  onApply: (days: LeadDays) => void;
}

export function LeadDaysSheet({ visible, value, onClose, onApply }: LeadDaysSheetProps) {
  const styles = useStyles();
  /**
   * 用户敲进去的东西；`null` ＝ 还没动过手，显示当下的值。
   *
   * ★ 刻意**不用 effect 在打开时把值灌进 state**（那样会触发
   *   「在 effect 里同步 setState」这条 lint，而且是典型的会级联渲染的写法）。
   *   这里 `draft ?? 当下的值` 一行就够了：关掉时把它清回 null，
   *   下次打开自然又跟着 `value` 走，不会留一个上次的残影。
   */
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);

  const parsed = Number(text.trim());
  const ok = text.trim() !== '' && isValidLeadDays(parsed);
  /* 预览按**收敛后**的值说：填 5 就说「到期前 5 天」。过不了校验才改口说范围 */
  const preview = ok
    ? clampLeadDays(parsed) <= 0
      ? '将在到期当天提醒'
      : `将在到期前 ${clampLeadDays(parsed)} 天提醒`
    : `请填 ${MIN_LEAD_DAYS} ~ ${MAX_LEAD_DAYS} 之间的整数`;

  const close = () => {
    setDraft(null);
    onClose();
  };

  return (
    <SheetModal visible={visible} onClose={close}>
      <View style={styles.head}>
        <Heading>提前几天提醒</Heading>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={close} hitSlop={10}>
          <Ionicons name="close" size={20} color={Palette.ink3} />
        </Pressable>
      </View>

      <Gutter>
        <Body tone="ink2" style={styles.lead}>
          填一个整数：0 就是到期当天，30 就是提前一个月。
        </Body>

        <View style={styles.field}>
          <TextInput
            value={text}
            onChangeText={setDraft}
            placeholder="例如 10"
            placeholderTextColor={Palette.ink4}
            style={styles.input}
            keyboardType="number-pad"
            maxLength={3}
            autoFocus
            accessibilityLabel="提前天数"
          />
          <Meta tone="ink3">天</Meta>
        </View>

        <Meta tone={ok ? 'ink3' : 'clay'} style={styles.preview}>
          {preview}
        </Meta>
      </Gutter>

      <View style={styles.foot}>
        <Button
          label="用这个天数"
          disabled={!ok}
          onPress={() => {
            onApply(clampLeadDays(parsed));
            close();
          }}
        />
        <Button label="取消" tone="secondary" style={styles.cancel} onPress={close} />
      </View>
    </SheetModal>
  );
}

const useStyles = makeStyles((Palette) => ({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingTop: Space.lg,
    paddingBottom: Space.md,
  },
  lead: { lineHeight: 21 },

  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    marginTop: Space.md,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line,
    backgroundColor: Palette.inset,
  },
  input: {
    flex: 1,
    padding: 0,
    ...(Type.body as object),
    color: Palette.ink,
  },
  preview: { marginTop: Space.sm, lineHeight: 19 },

  foot: { paddingHorizontal: GUTTER, paddingTop: Space.xl },
  cancel: { marginTop: Space.sm },
}));
