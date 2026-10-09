/**
 * 格物 · 「这一页现在进不去」整页提示
 *
 * 用途有两个，都是**兜深链**：
 *   ① 支持者档未激活 —— `/ask` 从这一版起才补上（此前只有入口挡，页面裸奔）
 *   ② AI 总开关关着 —— `/ask`、`/voice` 都要挡
 *
 * 为什么必须补页面这一层：入口（麦克风 / 星标 / 识物按钮）挡得再严，
 * `gewu://ask`、`gewu://voice` 这类直接跳转照样能进来 —— 那就是一道暗门。
 * 这条口径是语音那一版定下来的（见 `voice.tsx` 的注释），
 * 这次把两个页面统一到同一个组件，省得下次再补第三个页面时又漏一处。
 *
 * 为什么不做成「能看不能按」：灰掉的主界面看起来像坏了，
 * 而用户此刻需要的是**知道怎么把它打开**。所以整页只留一句解释 + 一个出口。
 */

import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { IconButton } from '@/components/ui/controls';
import { Card, Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { Body, Label } from '@/components/ui/typography';
import { Palette, Space } from '@/constants/theme';
import { makeStyles } from '@/lib/theme';

export interface AiOffNoticeProps {
  title: string;
  /** 一句解释：既说清「为什么进不去」，也说清「关掉 / 免费档之后你还剩什么」 */
  body: string;
  actionLabel: string;
  onAction: () => void;
  onBack: () => void;
  /** 额外浮层（支持者门控浮层从这个插槽进来，两页共用一套写法） */
  footer?: ReactNode;
}

export function AiOffNotice({
  title,
  body,
  actionLabel,
  onAction,
  onBack,
  footer,
}: AiOffNoticeProps) {
  const styles = useStyles();

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={onBack} />
      </View>
      <PageHeader title={title} subtitle="这一页现在打不开" />
      <Gutter>
        <Card>
          <Body tone="ink2" style={styles.text}>
            {body}
          </Body>
          <Pressable accessibilityRole="button" onPress={onAction} style={styles.btn}>
            <Label color={Palette.brand}>{actionLabel}</Label>
          </Pressable>
        </Card>
      </Gutter>
      {footer}
    </Screen>
  );
}

const useStyles = makeStyles(() => ({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Space.xs,
    paddingTop: Space.xs,
  },
  text: { lineHeight: 21 },
  btn: { marginTop: Space.md },
}));
