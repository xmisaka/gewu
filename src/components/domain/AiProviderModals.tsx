/**
 * 格物 · AI 供应商相关的两个弹层
 *
 * ① `AiProviderModal` —— 选供应商
 * ② `AiEndpointModal` —— 自定义端点的三个字段
 *
 * ── 为什么把「自定义」当成一等公民 ──────────────────────────────
 * 模型名变得比 App 的版本还快：`deepseek-chat` / `deepseek-reasoner` 用了整整一年，
 * 2026-07-24 被官方直接下线，请求当场失败。把模型名写死在 App 里的做法，
 * 早晚会变成一条「昨天还好好的」的报错。
 * 所以这里给一个能填**任意 OpenAI 兼容端点**的口子：中转站、自建服务、
 * 国外模型、乃至某家明天改名成什么，用户自己能改，不必等我发版。
 *
 * ── 一条硬规则 ────────────────────────────────────────────────
 * 供应商表里 `visionModel === null` 表示**这家看不了图**（DeepSeek 就是）。
 * 选它的时候必须**当场说清楚**「识物用不了」，而不是等用户点下去才报错 ——
 * 那时候他手里正举着要拍的那件东西。
 */

import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, TextInput, View } from 'react-native';

import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import {
  AI_PROVIDERS,
  type AiProviderDef,
  customEndpointSettings,
  saveAiProvider,
  saveCustomEndpoint,
} from '@/lib/ai/config';
import { makeStyles } from '@/lib/theme';
import { Button } from '../ui/controls';
import { Body, Heading, Label, Meta } from '../ui/typography';

/* ============================================================ ① 选供应商 */

export interface AiProviderModalProps {
  visible: boolean;
  currentKey: string;
  onClose: () => void;
}

export function AiProviderModal({ visible, currentKey, onClose }: AiProviderModalProps) {
  const styles = useStyles();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹层每次打开重置忙碌态，是本组件刻意的生命周期
    setPending(false);
  }, [visible]);

  const pick = async (p: AiProviderDef) => {
    if (p.key === currentKey) {
      onClose();
      return;
    }
    setPending(true);
    try {
      await saveAiProvider(p.key);
      onClose();
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Heading>选模型供应商</Heading>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={Palette.ink3} />
          </Pressable>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
          {AI_PROVIDERS.map((p) => {
            const active = p.key === currentKey;
            const canSee = p.visionModel !== null;
            return (
              <Pressable
                key={p.key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                disabled={pending}
                onPress={() => void pick(p)}
                android_ripple={{ color: Palette.ripple }}
                style={[styles.option, active && styles.optionActive]}>
                <View style={styles.optionHead}>
                  <Label tone={active ? 'brand' : 'ink'}>{p.name}</Label>
                  {active ? <Ionicons name="checkmark-circle" size={16} color={Palette.brand} /> : null}
                </View>
                <Meta tone="ink4" style={styles.optionNote}>
                  {p.signupNote}
                </Meta>
                <Meta tone={canSee ? 'ink4' : 'clay'} style={styles.optionNote}>
                  {canSee ? '支持识图' : '看不了图 · 识物用不了'}
                </Meta>
              </Pressable>
            );
          })}

          <Meta tone="ink4" style={styles.footNote}>
            换供应商后要重新填一次它的 API Key —— 各家的 Key 不通用。已经填过的会各自留着，换回来不用再填。
          </Meta>
        </ScrollView>
      </View>
    </Modal>
  );
}

/* ============================================================ ② 自定义端点 */

export interface AiEndpointModalProps {
  visible: boolean;
  onClose: () => void;
}

export function AiEndpointModal({ visible, onClose }: AiEndpointModalProps) {
  const styles = useStyles();
  const [endpoint, setEndpoint] = useState('');
  const [chat, setChat] = useState('');
  const [vision, setVision] = useState('');
  const [saving, setSaving] = useState(false);

  /* 打开时回填已存的值 —— 与 Key 不同，端点与模型名**不是秘密**，
     回填能让用户改一个字而不是重新敲一遍整条地址 */
  useEffect(() => {
    if (!visible) return;
    const s = customEndpointSettings();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹层每次打开回填草稿，是本组件刻意的生命周期
    setEndpoint(s.endpoint);
    setChat(s.chat);
    setVision(s.vision);
    setSaving(false);
  }, [visible]);

  const save = async () => {
    setSaving(true);
    try {
      await saveCustomEndpoint({
        endpoint: endpoint.trim(),
        chat: chat.trim(),
        vision: vision.trim(),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const ready = endpoint.trim().length > 0 && chat.trim().length > 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Heading>自定义端点</Heading>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={Palette.ink3} />
          </Pressable>
        </View>

        <View style={styles.body}>
          <Field
            label="接口地址"
            value={endpoint}
            onChange={setEndpoint}
            placeholder="https://…/v1/chat/completions"
          />
          <Field
            label="问答模型名"
            value={chat}
            onChange={setChat}
            placeholder="填服务商文档里的 model 名"
          />
          <Field
            label="识图模型名（留空＝不用识物）"
            value={vision}
            onChange={setVision}
            placeholder="没有就留空"
          />

          <Meta tone="ink4" style={styles.hint}>
            只支持 OpenAI 兼容的 /chat/completions 格式 —— 这也是目前绝大多数服务商提供的格式。
            填好后到上面那行填这一家的 API Key。
          </Meta>
        </View>

        <View style={styles.foot}>
          <Button label="保存" onPress={() => void save()} disabled={!ready || saving} loading={saving} />
        </View>
      </View>
    </Modal>
  );
}

/* ------------------------------------------------------------ 输入行 */

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  const styles = useStyles();
  return (
    <>
      <Label tone="ink3" style={styles.fieldLabel}>
        {label}
      </Label>
      <View style={styles.input}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={Palette.ink4}
          style={styles.inputField}
          autoCapitalize="none"
          autoCorrect={false}
          allowFontScaling={false}
        />
        {value.length > 0 ? (
          <Pressable accessibilityRole="button" accessibilityLabel="清空输入" hitSlop={8} onPress={() => onChange('')}>
            <Ionicons name="close-circle" size={16} color={Palette.ink4} />
          </Pressable>
        ) : null}
      </View>
    </>
  );
}

/* ------------------------------------------------------------ 样式 */

const useStyles = makeStyles((Palette) => ({
  backdrop: { flex: 1, backgroundColor: Palette.scrim },
  sheet: {
    backgroundColor: Palette.surface,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    paddingBottom: Space.xxl,
    maxHeight: '82%',
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
  scroll: { flexGrow: 0 },
  scrollBody: { paddingHorizontal: GUTTER, paddingBottom: Space.md },

  option: {
    borderWidth: StyleSheetHairline,
    borderColor: Palette.line2,
    borderRadius: Radius.input,
    paddingHorizontal: Space.md,
    paddingVertical: Space.md,
    marginBottom: Space.sm,
    backgroundColor: Palette.surface,
  },
  optionActive: { borderColor: Palette.brand, backgroundColor: Palette.brandBg },
  optionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  optionNote: { marginTop: 3, lineHeight: 18 },
  footNote: { marginTop: Space.sm, lineHeight: 19 },

  body: { paddingHorizontal: GUTTER },
  fieldLabel: { marginTop: Space.md },
  input: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    height: 40,
    marginTop: Space.xs,
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
  hint: { marginTop: Space.md, lineHeight: 19 },
  foot: { paddingHorizontal: GUTTER, paddingTop: Space.lg },
}));

/** 与 StyleSheet.hairlineWidth 同值；这里不引 StyleSheet 只是为了少一个 import */
const StyleSheetHairline = 0.5;
