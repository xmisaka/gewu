/**
 * 格物 · AI 的 API Key 弹层
 *
 * 交互照抄 `StockKeyModal`（封面图源）—— 那一套「掩码回显 + 存之前先真跑一次」
 * 已经在真实使用里验证过，没必要重新发明。差别只有两处：
 *
 *   1. 文案改成智谱；注册门槛那句话要写在最显眼处（「手机号注册即可，免费模型不用充值」），
 *      因为 AI 与图库不一样 —— 用户会本能地以为「接大模型 = 要花钱」。
 *   2. 自检发的是一次真实补全请求，所以顺带说明「会消耗一次调用」。
 *      一次调用的成本是 0，但把话说清楚比省略更好。
 */

import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import { describeAiError, pingAi } from '@/lib/ai/client';
import { activeProvider, maskKey } from '@/lib/ai/config';
import { useAi } from '@/lib/store/ai';
import { makeStyles } from '@/lib/theme';
import { Button } from '../ui/controls';
import { SheetModal } from '../ui/sheet-modal';
import { Body, Heading, Label, Meta } from '../ui/typography';

export interface AiKeyModalProps {
  visible: boolean;
  onClose: () => void;
  /** 保存成功（含自检通过）后通知外层刷新展示 */
  onSaved?: () => void;
}

export function AiKeyModal({ visible, onClose, onSaved }: AiKeyModalProps) {
  const styles = useStyles();
  /* endpoint 也要读：自定义那家没填地址时，测试连接的按钮要挡住 ——
     让它点下去只会换来一个「异常状态（400）」，那句话没告诉用户缺什么 */
  const { keyMask, saveKey, endpoint: activeEndpoint } = useAi();
  /* 挂在当前选中的供应商上 —— 换了供应商，这一屏的文案与存储槽位都要跟着换 */
  const provider = activeProvider();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  /* 每次打开都从空开始，而不是回填已存的 Key：
     Key 不回显全文（掩码只够「确认我填过」），把掩码塞进输入框会让用户
     以为那就是真值，一按保存就把真 Key 换成了掩码。 */
  useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹层每次打开都把草稿重置，是本组件刻意的生命周期
    setDraft('');
    setMessage(null);
    setChecking(false);
  }, [visible]);

  const save = async () => {
    setSaving(true);
    try {
      await saveKey(draft);
      onSaved?.();
      setMessage({ tone: 'ok', text: draft.trim() ? '已保存' : '已清除，AI 链路关闭' });
      setDraft('');
    } finally {
      setSaving(false);
    }
  };

  /** 存之前先真跑一次，把「Key 对不对」当场告诉用户 */
  const test = async () => {
    setChecking(true);
    setMessage(null);
    try {
      await saveKey(draft);
      await pingAi();
      setMessage({ tone: 'ok', text: '连接正常，模型已经能应答了' });
      onSaved?.();
    } catch (err) {
      setMessage({ tone: 'bad', text: describeAiError(err) });
    } finally {
      setChecking(false);
    }
  };

  const busy = saving || checking;

  /*
   * ★ 端点还没填完时不让测 —— 否则用户会拿到一个 400，
   *   而那句话既没说清缺什么、也没告诉他去哪儿补。
   *   这个判据只在「自定义」那家有意义：其余各家的地址是预置的。
   */
  const missingEndpoint = provider.key === 'custom' && activeEndpoint.trim().length === 0;
  const canTest = Boolean(draft.trim()) && !missingEndpoint;

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.head}>
        <Heading>AI 的 API Key</Heading>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
          <Ionicons name="close" size={20} color={Palette.ink3} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <Body tone="ink2" style={styles.desc}>
          {`识物与问一问用的是${provider.name}的模型，需要你自己的 API Key。`}
        </Body>
        <Meta color={Palette.brand} style={styles.emphasis}>
          {provider.signupNote}
        </Meta>

        <Label tone="ink3" style={styles.fieldLabel}>
          API Key
        </Label>
        <View style={styles.input}>
          <TextInput
            value={draft}
            onChangeText={(next) => {
              setDraft(next);
              if (message) setMessage(null);
            }}
            placeholder={`粘贴 ${provider.name} 的 API Key`}
            placeholderTextColor={Palette.ink4}
            style={styles.inputField}
            autoCapitalize="none"
            autoCorrect={false}
            allowFontScaling={false}
          />
          {draft.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="清空输入"
              hitSlop={8}
              onPress={() => setDraft('')}>
              <Ionicons name="close-circle" size={16} color={Palette.ink4} />
            </Pressable>
          ) : null}
        </View>

        {keyMask ? (
          <Meta tone="ink4" style={styles.current}>
            当前生效：{maskKey(keyMask)}
          </Meta>
        ) : (
          <Meta tone="ink4" style={styles.current}>
            还没配置
          </Meta>
        )}

        {message ? (
          <View style={styles.message}>
            <Ionicons
              name={message.tone === 'ok' ? 'checkmark-circle' : 'alert-circle'}
              size={14}
              color={message.tone === 'ok' ? Palette.sage : Palette.clay}
            />
            <Meta
              color={message.tone === 'ok' ? Palette.sage : Palette.clay}
              style={styles.messageText}>
              {message.text}
            </Meta>
          </View>
        ) : null}

        {/* 缺前置条件时说清缺什么 —— 直接让他去测，只会换来一个「异常状态（400）」 */}
        {missingEndpoint ? (
          <View style={styles.message}>
            <Ionicons name="alert-circle" size={14} color={Palette.clay} />
            <Meta color={Palette.clay} style={styles.messageText}>
              还没填接口地址。先回到上一屏把「接口地址」补上，再回来测。
            </Meta>
          </View>
        ) : null}

        <Meta tone="ink4" style={styles.warn}>
          Key 存在本机数据库里，只在识物与提问的那一刻用它调一次模型。原图、物品数据都不会离开这台手机。
        </Meta>
      </View>

      <View style={styles.foot}>
        <Button
          label={checking ? '测试中…' : '测试连接'}
          tone="secondary"
          block={false}
          icon="pulse-outline"
          onPress={() => void test()}
          disabled={busy || !canTest}
          loading={checking}
        />
        <Button label="保存" block={false} onPress={() => void save()} disabled={busy} loading={saving} />
      </View>
    </SheetModal>
  );
}

/* 弹层的背板 / 圆角 / 把手现在由 SheetModal 统一提供，这里只管内容 */
const useStyles = makeStyles((Palette) => ({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingTop: Space.lg,
    paddingBottom: Space.md,
  },
  body: { paddingHorizontal: GUTTER },
  desc: { lineHeight: 21 },
  emphasis: { marginTop: Space.xs },
  fieldLabel: { marginTop: Space.lg },
  input: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    height: 40,
    marginTop: Space.sm,
    paddingHorizontal: Space.md,
    backgroundColor: Palette.inset,
    borderRadius: Radius.input,
  },
  inputField: {
    flex: 1,
    padding: 0,
    ...(Type.body as object),
    fontSize: 13.5,
    color: Palette.ink,
  },
  current: { marginTop: Space.sm },
  message: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, marginTop: Space.md },
  messageText: { flex: 1, lineHeight: 19 },
  warn: { marginTop: Space.md, lineHeight: 19 },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: GUTTER,
    paddingTop: Space.xl,
  },
}));
