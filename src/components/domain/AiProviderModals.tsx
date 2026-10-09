/**
 * 格物 · AI 设置页的三个弹层
 *
 * ① `AiProviderModal` —— 选供应商
 * ② `AiEndpointModal` —— 自定义端点的地址
 * ③ `AiModelModal`    —— 改模型名（**对所有供应商开放**）
 *
 * ── 为什么模型名要人人可改，不只留给「自定义」 ────────────────
 * 官方下线模型名是常事：`deepseek-chat` / `deepseek-reasoner` 这两个名字
 * 用了整整一年，2026-07-24 被官方**直接下线**，请求当场失败
 * （不是废弃警告，是打过去就报错）。把名字写死在 App 里的做法，
 * 迟早变成一条「昨天还好好的」的报错，而那时未必有人来改。
 * 所以：**任何一家都能改**，清空即回到预置的默认名。
 *
 * ── 一条硬规则 ────────────────────────────────────────────────
 * 供应商表里 `visionModel === null` 表示**这家看不了图**（DeepSeek 就是）。
 * 选它的时候必须**当场说清楚**「识物用不了」，而不是等用户点下去才报错 ——
 * 那时候他手里正举着要拍的那件东西。
 */

import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import { AI_PROVIDERS, type AiProviderDef } from '@/lib/ai/config';
import { useAi } from '@/lib/store/ai';
import { makeStyles } from '@/lib/theme';
import { Button } from '../ui/controls';
import { SheetModal } from '../ui/sheet-modal';
import { Heading, Label, Meta } from '../ui/typography';

/* ============================================================ ① 选供应商 */

export interface AiProviderModalProps {
  visible: boolean;
  onClose: () => void;
}

export function AiProviderModal({ visible, onClose }: AiProviderModalProps) {
  const styles = useStyles();
  const { provider: current, setProvider } = useAi();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹层每次打开重置忙碌态，是本组件刻意的生命周期
    setPending(false);
  }, [visible]);

  const pick = async (p: AiProviderDef) => {
    if (p.key === current.key) {
      onClose();
      return;
    }
    setPending(true);
    try {
      /* ★ 切完不用在这里手动刷新界面 —— `setProvider` 会把新值写进 store 的 React 状态，
         整页（包括这一行、Key、模型名、隐私说明里那句「当前：X」）一起重渲染。
         早先用模块级变量 + 手动计数器，就出现过「切过去了名字还是旧的」。 */
      await setProvider(p.key);
      onClose();
    } finally {
      setPending(false);
    }
  };

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.head}>
        <Heading>选模型供应商</Heading>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
          <Ionicons name="close" size={20} color={Palette.ink3} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
        {AI_PROVIDERS.map((p) => {
          const active = p.key === current.key;
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
                {canSee ? '配置后可识图' : '看不了图 · 识物用不了'}
              </Meta>
            </Pressable>
          );
        })}

        <Meta tone="ink4" style={styles.footNote}>
          换供应商后要重新填一次它的 API Key —— 各家的 Key 不通用。已经填过的会各自留着，换回来不用再填。
        </Meta>
      </ScrollView>
    </SheetModal>
  );
}

/* ============================================================ ② 自定义端点 */

export interface AiEndpointModalProps {
  visible: boolean;
  onClose: () => void;
}

export function AiEndpointModal({ visible, onClose }: AiEndpointModalProps) {
  const styles = useStyles();
  const { endpoint, saveEndpoint } = useAi();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  /* 端点**不是秘密**，回填能让用户改一个字，而不是重新敲整条地址 */
  useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹层每次打开回填草稿，是本组件刻意的生命周期
    setDraft(endpoint);
    setSaving(false);
  }, [visible, endpoint]);

  const save = async () => {
    setSaving(true);
    try {
      await saveEndpoint(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const trimmed = draft.trim();
  const looksWrong = trimmed.length > 0 && !trimmed.startsWith('https://');

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.head}>
        <Heading>自定义端点</Heading>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
          <Ionicons name="close" size={20} color={Palette.ink3} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <Field
          label="接口地址"
          value={draft}
          onChange={setDraft}
          placeholder="https://…/v1/chat/completions"
          hint="要一路填到 /chat/completions —— 各家拼法不同，少填一段会得到一个看不懂的报错。"
        />

        {looksWrong ? (
          <View style={styles.warn}>
            <Ionicons name="alert-circle" size={14} color={Palette.clay} />
            <Meta color={Palette.clay} style={styles.warnText}>
              端点是明文 http 或者格式不对。密钥会随请求发出去，建议用 https。
            </Meta>
          </View>
        ) : null}

        <Meta tone="ink4" style={styles.hint}>
          模型名不在这里填 —— 回到「模型」那一段点「识图」「问答」两行各自填写，
          各家的默认名已经预置好了。
        </Meta>
      </View>

      <View style={styles.foot}>
        <Button label="保存" onPress={() => void save()} disabled={saving} loading={saving} />
      </View>
    </SheetModal>
  );
}

/* ============================================================ ③ 改模型名 */

export interface AiModelModalProps {
  /** 打开时聚焦哪一项；null＝不打开 */
  kind: 'vision' | 'chat' | null;
  onClose: () => void;
}

export function AiModelModal({ kind, onClose }: AiModelModalProps) {
  const styles = useStyles();
  const { provider, visionModel, chatModel, defaultVision, defaultChat, saveModel } = useAi();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const open = kind !== null;

  /* 每次打开都从「当前生效的名字」开始 —— 它是模型名不是密钥，回填才方便改一个字 */
  useEffect(() => {
    if (!kind) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹层每次打开回填草稿，是本组件刻意的生命周期
    setDraft(kind === 'vision' ? visionModel : chatModel);
    setSaving(false);
  }, [kind, visionModel, chatModel]);

  const save = async () => {
    if (!kind) return;
    setSaving(true);
    try {
      await saveModel(kind, draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const isVision = kind === 'vision';
  const fallback = isVision ? defaultVision : defaultChat;
  const cleared = isVision && draft.trim().length === 0;

  return (
    <SheetModal visible={open} onClose={onClose}>
      <View style={styles.head}>
        <Heading>{isVision ? '识图模型' : '问答模型'}</Heading>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
          <Ionicons name="close" size={20} color={Palette.ink3} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <Meta tone="ink3" style={styles.providerNote}>
          {`当前供应商：${provider.name}`}
        </Meta>

        <Field
          label="模型名（就是请求里 model 字段那个名字）"
          value={draft}
          onChange={setDraft}
          placeholder={fallback || (isVision ? '这家没有默认识图模型，留空即不用识物' : '填写服务商文档里的模型名')}
          hint={
            fallback
              ? `留空即用预置的 ${fallback}。服务商改了名字时，把它文档里的新名字填在这里。`
              : '这家没有预置值，必须自己填；留空表示不用这个能力。'
          }
        />

        {cleared ? (
          <View style={styles.warn}>
            <Ionicons name="information-circle" size={14} color={Palette.clay} />
            <Meta color={Palette.clay} style={styles.warnText}>
              留空保存后，「识物」入口会从录入页隐藏 —— 没有模型名就等于这家看不了图。
            </Meta>
          </View>
        ) : null}

        <Meta tone="ink4" style={styles.hint}>
          报「模型不存在 / model not found」时，多半是服务商改了名字：到它的文档里抄一个填进来就行。
        </Meta>
      </View>

      <View style={styles.foot}>
        <Button label="保存" onPress={() => void save()} disabled={saving} loading={saving} />
      </View>
    </SheetModal>
  );
}

/* ------------------------------------------------------------ 输入行 */

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  hint?: string;
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
      {hint ? (
        <Meta tone="ink4" style={styles.fieldHint}>
          {hint}
        </Meta>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------ 样式 */

/* 弹层的背板 / 圆角 / 把手（以及键盘避让）现在由 SheetModal 统一提供 */
const useStyles = makeStyles((Palette) => ({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingTop: Space.lg,
    paddingBottom: Space.md,
  },
  /* flexShrink：键盘弹起时 SheetModal 会把高度上限压小，列表要能跟着收 */
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollBody: { paddingHorizontal: GUTTER, paddingBottom: Space.md },

  option: {
    borderWidth: 0.5,
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
  providerNote: { marginBottom: Space.xs },
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
  fieldHint: { marginTop: Space.xs, lineHeight: 18 },
  warn: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.xs, marginTop: Space.md },
  warnText: { flex: 1, lineHeight: 19 },
  hint: { marginTop: Space.md, lineHeight: 19 },
  foot: { paddingHorizontal: GUTTER, paddingTop: Space.lg },
}));
