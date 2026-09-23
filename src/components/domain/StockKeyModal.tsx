/**
 * 格物 · 封面图源设置
 *
 * 为什么要做成界面可填而不是写死在代码里：
 * 自用构建把 Key 编译进包当然最省事，但换一次 Key 就要重新打包安装，
 * 在这个 App 里不值得。存进 meta 表（已有的键值表，不额外加依赖）
 * 就能随时换，写死的常量退化成「首次安装的默认值」。
 *
 * 界面上只回显掩码，不回显全文 —— 设置页被旁人瞥一眼不至于泄 Key。
 */

import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Modal, Pressable, TextInput, View } from 'react-native';

import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import { currentApiKey, hasApiKey, saveApiKey, searchCovers } from '@/lib/photos/stock';
import { Button } from '../ui/controls';
import { Body, Heading, Label, Meta } from '../ui/typography';
import { makeStyles } from '@/lib/theme';

export interface StockKeyModalProps {
  visible: boolean;
  onClose: () => void;
  /** 保存成功后通知外层刷新展示 */
  onSaved?: () => void;
}

/** 掩码：只露前 6 位，其余打点 */
function mask(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return key[0] + '••••';
  return `${key.slice(0, 6)}••••••${key.slice(-4)}`;
}

export function StockKeyModal({ visible, onClose, onSaved }: StockKeyModalProps) {
  const styles = useStyles();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  // 每次打开都从已存的值重新开始，避免残留上次没提交的草稿
  useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹层每次打开都把草稿重置为已存的值，是本组件刻意的生命周期
    setDraft(currentApiKey());
    setMessage(null);
    setChecking(false);
  }, [visible]);

  const save = async () => {
    setSaving(true);
    try {
      await saveApiKey(draft);
      onSaved?.();
      setMessage({ tone: 'ok', text: '已保存' });
    } finally {
      setSaving(false);
    }
  };

  /** 存之前先真搜一次，把「Key 对不对」当场告诉用户，别留到录入时才发现 */
  const test = async () => {
    setChecking(true);
    setMessage(null);
    try {
      await saveApiKey(draft);
      const list = await searchCovers('headphones', { perPage: 1 });
      setMessage(
        list.length > 0
          ? { tone: 'ok', text: '连接正常，能搜到图了' }
          : { tone: 'bad', text: '连上了但没返回结果，换网络再试' },
      );
      onSaved?.();
    } catch (err) {
      setMessage({
        tone: 'bad',
        text: err instanceof Error ? err.message : '连接失败',
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Heading>封面图源</Heading>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onClose}
            hitSlop={10}>
            <Ionicons name="close" size={20} color={Palette.ink3} />
          </Pressable>
        </View>

        <View style={styles.body}>
          <Body tone="ink2" style={styles.desc}>
            自动找封面用的是 Pexels 免费图库，需要一个 API Key。
            到 pexels.com/api 注册后复制过来即可，免费额度足够自用。
          </Body>

          <Label tone="ink3" style={styles.fieldLabel}>
            API Key
          </Label>
          <View style={styles.input}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="粘贴 Pexels 的 API Key"
              placeholderTextColor={Palette.ink4}
              style={styles.inputField}
              autoCapitalize="none"
              autoCorrect={false}
              allowFontScaling={false}
              secureTextEntry={false}
            />
            {draft.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="清空"
                hitSlop={8}
                onPress={() => setDraft('')}>
                <Ionicons name="close-circle" size={16} color={Palette.ink4} />
              </Pressable>
            ) : null}
          </View>

          {draft && draft === currentApiKey() ? (
            <Meta tone="ink4" style={styles.current}>
              当前生效：{mask(draft)}
            </Meta>
          ) : null}

          {/* 留空 ≠ 关闭功能：清掉这里只会回退到内置的默认 Key。
              不写清楚的话，用户以为关掉了，实际还在用，是种误导 */}
          {!draft.trim() ? (
            <Meta tone="ink4" style={styles.current}>
              留空会回退到应用内置的默认 Key
            </Meta>
          ) : null}

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

          <Meta tone="ink4" style={styles.warn}>
            Key 会存在本机数据库里，不会上传到任何地方。只在点「找封面」时联网。
          </Meta>
        </View>

        <View style={styles.foot}>
          <Button
            label={checking ? '测试中…' : '测试连接'}
            tone="secondary"
            block={false}
            icon="pulse-outline"
            onPress={() => void test()}
            disabled={saving || checking || !draft.trim()}
            loading={checking}
          />
          <Button
            label="保存"
            block={false}
            onPress={() => void save()}
            disabled={checking}
            loading={saving}
          />
        </View>
      </View>
    </Modal>
  );
}

/** 给「我的」页用的状态行文案 */
export function stockKeyStatus(): string {
  if (!hasApiKey()) return '未配置，点这里填 Pexels Key';
  return `已配置 ${mask(currentApiKey())}`;
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
  body: { paddingHorizontal: GUTTER },
  desc: { lineHeight: 21 },
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
