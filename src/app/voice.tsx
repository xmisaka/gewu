/**
 * 格物 · 语音录入（设计稿 05 屏）
 *
 * 一句话 → 一张填好的录入表单。说的是「客厅有一台电脑，价格5000元」，
 * 拿到的是 名称 电脑 / 位置 客厅 / 价格 5000，**然后停下来等你确认**。
 *
 * ── 三条不变量 ────────────────────────────────────────────────
 *
 * 1. **绝不直接入库**。识别有误差，所以结果一律先落到表单里，由用户点保存才写库。
 *    这也是 05 屏那条脚注的原意。
 *
 * 2. **不申请录音权限**。识别走系统对话框（见 lib/ai/asr.ts），
 *    录音发生在识别器 App 里，格物的权限清单一个字节都不变。
 *
 * 3. **解析可以不准，界面必须诚实**。识别出来、模型补出来的行全部挂「AI」标，
 *    用户一动它就摘标；AI 那一步成没成、补了几项，都照实说，不糊一句
 *    「已让 AI 读过」了事。
 *
 * ── 2026-10-09：这个页面被重写过一次 ─────────────────────────
 *
 * **原来这里自己搭了一套 6 行字段 UI，现在改成复用 `ItemForm`。**
 *
 * 理由：识物走的一直是「回填 ItemForm」，语音却是自己一套 —— 同一件事两套实现，
 * 于是「支持解析哪些属性」这个问题要在两边各答一遍，加一个字段要改三处
 * （表单、语音、识物）。真机上撞到的「价格 / 购买日期 / 库存根本没有」就是这么来的。
 *
 * 现在这一页只管**语音独有的那部分**：可编辑的转写文字 → 拿去解析 → 交给表单。
 * 字段怎么排、怎么校验、怎么存，全归 ItemForm —— 以后加字段自动跟上。
 *
 * ── 2026-10-09（二）：语音改为支持者功能 ──────────────────────
 *
 * 两处入口（录入页右上角、首页搜索框右侧）与这一页**各挡一次**：
 * 入口挡是为了让免费档点一下就看到「这是什么、少了什么」，
 * 页面挡是兜住深链 —— 只有入口那一处，`gewu://voice` 就是一道暗门。
 *
 * ★ 原先的决策是「语音不门控」，理由是不联网、不要 Key、不申请权限，
 *   锁它等于给「记东西」本身加门槛。技术上那条理由仍然成立（这条链路
 *   确实零成本），改的是产品定位：语音与识物、问答同属「智能录入」，一档解锁。
 *   要回退只需去掉这三个地方的门控，其余不用动。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SupporterGateSheet } from '@/components/domain/SupporterGateSheet';
import { ItemForm, type FormPayload, type ItemSeed } from '@/components/domain/ItemForm';
import { Button, IconButton } from '@/components/ui/controls';
import { Card, Gutter, PageHeader, Screen, ScreenScroll } from '@/components/ui/layout';
import { Body, Label, Meta, Title } from '@/components/ui/typography';
import { GUTTER, Palette, Space, Type } from '@/constants/theme';
import { ASR_AVAILABLE, asrMessage, listenOnce } from '@/lib/ai/asr';
import { askText, describeAiError } from '@/lib/ai/client';
import { buildVoicePrompt, parseExtract } from '@/lib/ai/extract';
import { parseVoiceInput, toLocationHints } from '@/lib/ai/voice-parse';
import { today } from '@/lib/date';
import { listCategories } from '@/lib/db/categories';
import { createItem } from '@/lib/db/items';
import { listCabinetViews, listLocations } from '@/lib/db/locations';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAi } from '@/lib/store/ai';
import { useAppState } from '@/lib/store/app-state';
import { useEntitlement } from '@/lib/store/entitlement';
import { makeStyles, useTheme } from '@/lib/theme';

type Phase = 'idle' | 'listening' | 'result';

/** AI 那一步的状态。见 aiRoundLabel 的注释 */
type AiRound =
  | { kind: 'off' }
  | { kind: 'running' }
  | { kind: 'ok'; gained: number }
  | { kind: 'failed'; reason: string };

export default function VoiceScreen() {
  const router = useRouter();
  const styles = useStyles();
  const { tokens } = useTheme();
  const { bump } = useAppState();
  const insets = useSafeAreaInsets();

  const { entitled } = useEntitlement();
  const { active: aiActive, record } = useAi();

  const [phase, setPhase] = useState<Phase>('idle');
  /** 可编辑的转写文字。★ 它是这一页的主输入 —— 改完按「重新识别」重跑 */
  const [transcript, setTranscript] = useState('');
  /**
   * 交给表单的初稿。**null ＝ 还没准备好**（AI 正在跑，或压根还没开始）。
   *
   * `formKey` 与 seed 配套：每次有新初稿就把它 +1，让 ItemForm 以新值重挂。
   * 这是让「重新识别」生效的最省事做法 —— 否则表单自己攥着 draft，
   * 外面换了 prefill 它也不知道（它的 draft 只在首次挂载时从 prefill 取一次）。
   */
  const [seed, setSeed] = useState<ItemSeed | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [aiRound, setAiRound] = useState<AiRound>({ kind: 'off' });
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * 防连点。expo-intent-launcher 原生侧同一时刻只允许一个待决请求，
   * 第二次调用不是排队而是当场失败 —— 用户会看到「识别没反应」。
   * 用 ref 而不是 state：state 的更新要等下一帧，挡不住同一帧里的第二次点击。
   */
  const busy = useRef(false);

  const locationState = useAsyncData(() => listLocations(), [], []);
  const cabinetState = useAsyncData(() => listCabinetViews(), [], []);
  const categoryState = useAsyncData(() => listCategories(), [], []);

  /** 这一档会不会让模型参与 */
  const aiOn = entitled && aiActive;
  const aiBusy = aiRound.kind === 'running';

  /**
   * 从一段文字里抽出一份初稿。
   *
   * 分两步，顺序是刻意的：
   *   ① **本地规则**（纯函数、零延迟、不联网）—— 立即给出一版；
   *   ② **模型**（可选）—— 只补本地没填上的字段。
   *
   * ★ AI 参与时**先不把第 ① 步的结果交出去**，等第 ② 步有结果了再一次性给表单。
   *   否则表单会挂载两次，第二次把用户在这几秒里做的修改冲掉。
   *   代价是「AI 那几秒看不到字段」—— 但转写文字当场就在，用户不会觉得卡住。
   */
  const runParse = useCallback(
    async (text: string) => {
      const parsed = parseVoiceInput(text, {
        locations: toLocationHints(locationState.data),
        today: today(),
      });

      const localSeed: ItemSeed = {
        name: parsed.name,
        /* 分类留空交给 ItemForm 的猜词 —— 语音说「客厅有台电脑」通常没提分类，
           而那一层猜词本来就在表单里（`prefillMode="voice"` 允许它生效） */
        categoryId: null,
        locationId: parsed.locationId,
        purchaseDate: parsed.purchaseDate,
        price: parsed.price,
        expireDate: parsed.expireDate,
        brand: null,
        model: null,
        quantity: parsed.quantity,
        tags: [],
        note: null,
        sortOrder: null,
      };

      /* AI 没参与：本机结果就是最终结果，直接交出去 */
      if (!aiOn) {
        setAiRound({ kind: 'off' });
        setSeed(localSeed);
        setFormKey((k) => k + 1);
        return;
      }

      /* ---- 模型 ---- */
      setAiRound({ kind: 'running' });
      try {
        const raw = await askText(buildVoicePrompt(categoryState.data.map((c) => c.name)), text);
        record('chat');
        const f = parseExtract(raw, {
          today: today(),
          categories: categoryState.data.map((c) => c.name),
        })?.fields;

        /* 只补**空的**行 —— 本机规则听出来的那些是它自己的判断，不让模型改写 */
        let gained = 0;
        const keep = <T,>(current: T | null, next: T | null | undefined): T | null => {
          if (current != null) return current;
          if (next == null) return null;
          gained += 1;
          return next;
        };

        const merged: ItemSeed = {
          name: localSeed.name.trim() ? localSeed.name : keep(null, f?.name) ?? '',
          categoryId: f?.categoryName
            ? (categoryState.data.find((c) => c.name === f.categoryName)?.id ?? null)
            : null,
          locationId: localSeed.locationId,
          purchaseDate: keep(localSeed.purchaseDate, f?.purchaseDate),
          price: keep(localSeed.price, f?.price),
          expireDate: keep(localSeed.expireDate, f?.expireDate),
          brand: keep(null, f?.brand),
          model: keep(null, f?.model),
          quantity: keep(localSeed.quantity, f?.quantity),
          tags: f?.tags ?? [],
          note: keep(null, f?.note),
          sortOrder: null,
        };

        setAiRound({ kind: 'ok', gained });
        setSeed(merged);
        setFormKey((k) => k + 1);
      } catch (err) {
        /* ★ 失败**不静默**：用户刚说完话，什么都没发生等于「没反应」。
           照实说一句、给一句该怎么做；本机的结果照常交出去，
           「AI 挂了这功能还在」这条不变量不破。 */
        setAiRound({ kind: 'failed', reason: describeAiError(err) });
        setSeed(localSeed);
        setFormKey((k) => k + 1);
      }
    },
    [aiOn, locationState.data, categoryState.data, record],
  );

  const startListen = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setNotice(null);
    setSeed(null);
    setPhase('listening');
    try {
      const outcome = await listenOnce();

      if (outcome.kind !== 'ok') {
        /* 取消不是错误 —— 用户在系统界面上主动退出来了，
           悄悄回到原来那一屏就好，弹一句「失败了」反而像出了故障。 */
        if (outcome.kind !== 'canceled') setNotice(asrMessage(outcome));
        setPhase(transcript ? 'result' : 'idle');
        return;
      }

      setTranscript(outcome.text);
      setPhase('result');
      await runParse(outcome.text);
    } finally {
      busy.current = false;
    }
  }, [runParse, transcript]);

  /** 改完转写文字后重跑一次，不必重录 */
  const reparse = useCallback(async () => {
    if (busy.current || !transcript.trim()) return;
    busy.current = true;
    setNotice(null);
    setSeed(null);
    try {
      await runParse(transcript);
    } finally {
      busy.current = false;
    }
  }, [runParse, transcript]);

  const save = useCallback(
    async (payload: FormPayload) => {
      if (saving) return;
      setSaving(true);
      try {
        /* 语音这条路径没有照片：表单的照片区已隐去，newPhotos 必然为空 */
        await createItem(payload.draft);
        bump();
        router.replace('/');
      } finally {
        setSaving(false);
      }
    },
    [saving, bump, router],
  );

  /* 未激活：整页只留一句解释与一个出口（与 AI 助手设置页同一口径，不做成
     「能看不能按」—— 灰按钮看起来像坏了，而用户需要的是知道怎么解锁）。
     两处入口已经挡过一次，这里是**深链兜底** —— 少了它，
     `gewu://voice` 这类直接跳转就是一道暗门。 */
  if (!entitled) {
    return (
      <Screen>
        <View style={styles.topBar}>
          <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
        </View>
        <PageHeader title="语音录入" subtitle="语音录入属于支持者功能" />
        <Gutter>
          <Card>
            <Body tone="ink2" style={styles.lockedText}>
              语音录入需要支持者档。免费档的录入、到期、库存、照片与备份全部照旧，一个不少。
            </Body>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/supporter')}
              style={styles.lockedBtn}>
              <Label color={Palette.brand}>去激活 / 了解支持者档</Label>
            </Pressable>
          </Card>
        </Gutter>
        <SupporterGateSheet visible feature="ai" onClose={() => router.back()} />
      </Screen>
    );
  }

  const showResult = phase === 'result';

  return (
    <Screen>
      <PageHeader
        title="语音录入"
        subtitle={showResult ? '确认一下再保存' : '说一句话就能录入'}
        right={<IconButton icon="close" accessibilityLabel="关闭" onPress={() => router.back()} />}
      />

      {showResult ? (
        (() => {
          /* 转写卡走 ItemForm 的 header 插槽 —— 它必须和字段一起滚，
             外面再套一层滚动容器会让两个垂直 ScrollView 抢手势。见 ItemForm 的注释。 */
          const transcriptBlock = (
            <Gutter>
              <Card>
                <View style={styles.saidHead}>
                  <Ionicons name="mic" size={13} color={tokens.ink4} />
                  <Meta tone="ink4">听到的是（可以直接改）</Meta>
                </View>
                {/* ★ 转写可编辑 —— 听错一个字不必重说整句。
                    「重说」要重走一遍系统识别框，还不一定比上次准。 */}
                <TextInput
                  value={transcript}
                  onChangeText={setTranscript}
                  multiline
                  style={[styles.saidInput, { color: tokens.ink }]}
                  placeholder="识别到的文字"
                  placeholderTextColor={tokens.ink4}
                  selectionColor={tokens.brand}
                  accessibilityLabel="语音识别到的文字"
                />

                <View style={styles.saidActions}>
                  <Button
                    label="重说"
                    icon="mic-outline"
                    tone="secondary"
                    block={false}
                    style={styles.saidAction}
                    onPress={() => void startListen()}
                    disabled={saving}
                  />
                  <Button
                    label="重新识别"
                    icon="refresh-outline"
                    tone="secondary"
                    block={false}
                    style={styles.saidAction}
                    onPress={() => void reparse()}
                    disabled={saving || !transcript.trim() || aiBusy}
                    loading={aiBusy}
                  />
                </View>
              </Card>

              {/* 照实说 AI 那一步的结果 —— 上一版无论成败都写「已让 AI 读过一遍」，
                  失败时那是假话，用户据此以为「这么简单都识别不了」，
                  而真相可能是「模型根本没连上」。 */}
              <Meta
                tone="ink4"
                color={aiRound.kind === 'failed' ? tokens.clay : undefined}
                style={styles.aiNote}>
                {aiRoundLabel(aiRound)}
              </Meta>

              {notice ? (
                <Meta color={tokens.clay} style={styles.notice}>
                  {notice}
                </Meta>
              ) : null}
            </Gutter>
          );

          /* AI 还在跑时先不渲染表单 —— 否则它一会儿会被重挂一次，
             用户在这几秒里改的东西就没了。见 runParse 的注释。 */
          return seed ? (
            <ItemForm
              key={formKey}
              header={transcriptBlock}
              prefill={seed}
              prefillMode="voice"
              hidePhotos
              categories={categoryState.data}
              cabinets={cabinetState.data}
              submitLabel="确认并保存"
              onSubmit={(payload) => save(payload)}
              submitting={saving}
            />
          ) : (
            <ScreenScroll bottomInset={Space.md + insets.bottom}>
              {transcriptBlock}
              <Gutter>
                <Card style={styles.preparing}>
                  <Body tone="ink3">正在把这句话整理成字段…</Body>
                </Card>
              </Gutter>
            </ScreenScroll>
          );
        })()
      ) : (
        <View style={styles.center}>
          <Wave active={phase === 'listening'} />

          <Title style={styles.lead}>
            {phase === 'listening' ? '正在听…' : '说一句话就能录入'}
          </Title>
          <Body tone="ink3" style={styles.sample}>
            像这样：「客厅有一台电脑，价格5000元」
          </Body>

          <Button
            label={ASR_AVAILABLE ? '开始说话' : '这台设备用不了'}
            icon="mic-outline"
            size="lg"
            block={false}
            style={styles.micBtn}
            onPress={() => void startListen()}
            disabled={!ASR_AVAILABLE || phase === 'listening'}
            loading={phase === 'listening'}
          />

          {notice ? (
            <Meta color={tokens.clay} style={styles.notice}>
              {notice}
            </Meta>
          ) : null}
        </View>
      )}
    </Screen>
  );
}

/**
 * AI 那一步的结果，说人话。
 *
 * ★ 每一条都必须是**真发生过的事**。上一版无论成败都写「已让 AI 读过一遍」，
 *   失败时那就是假话 —— 用户据此认为「模型连这么简单都识别不了」，
 *   而真相可能是「模型根本没连上」。
 */
function aiRoundLabel(round: AiRound): string {
  switch (round.kind) {
    case 'running':
      return 'AI 正在按这句话补齐没听出来的字段…';
    case 'ok':
      return round.gained > 0
        ? `AI 补上了 ${round.gained} 个字段（带「AI」标的那几行可以核对一下）。`
        : 'AI 读过了，没有能补的字段 —— 下面就是本机规则的结果，可以直接改。';
    case 'failed':
      return `AI 这一步没成功：${round.reason}。下面只是本机规则的结果，可能不完整。`;
    default:
      /* 未参与：可能是免费档、开关没开、或没配 Key。
         不说「AI 用不了」—— 那听起来像坏了，而语音本身是完整的。 */
      return '没让 AI 参与（需要支持者档 + 打开总开关）。下面是本机规则的结果，可以直接改。';
  }
}

/* ------------------------------------------------------------ 声波 */

function Bar({
  active,
  index,
  progress,
}: {
  active: boolean;
  index: number;
  progress: SharedValue<number>;
}) {
  const styles = useStyles();
  const style = useAnimatedStyle(() => {
    if (!active) return { height: 8 };
    /* 每根柱子错开一点相位，看起来才像声波而不是整齐地一起跳 */
    const phase = (progress.value + index * 0.13) % 1;
    const wave = Math.abs(Math.sin(phase * Math.PI));
    return { height: 8 + wave * 26 };
  });
  return <Animated.View style={[styles.bar, style]} />;
}

function Wave({ active }: { active: boolean }) {
  const styles = useStyles();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (active) {
      progress.value = 0;
      progress.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.linear }), -1, false);
    } else {
      cancelAnimation(progress);
      progress.value = 0;
    }
    return () => cancelAnimation(progress);
  }, [active, progress]);

  const bars = useMemo(() => Array.from({ length: 5 }, (_, i) => i), []);

  return (
    <View style={styles.wave}>
      {bars.map((i) => (
        <Bar key={i} active={active} index={i} progress={progress} />
      ))}
    </View>
  );
}

/* ------------------------------------------------------------ 样式 */

const useStyles = makeStyles((Palette) => ({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: GUTTER,
    paddingBottom: 32,
  },

  wave: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, height: 40 },
  bar: { width: 4, borderRadius: 2, backgroundColor: Palette.brand },

  lead: { marginTop: Space.lg, textAlign: 'center' },
  sample: { marginTop: Space.sm, textAlign: 'center', lineHeight: 21 },
  micBtn: { marginTop: Space.xl },
  notice: { marginTop: Space.md, textAlign: 'center', lineHeight: 19 },

  saidHead: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, marginBottom: Space.xs },
  /* 可编辑的转写。用输入框而不是文本 —— 听错一个字不该逼用户重说整句。
     padding 归零是为了让它看起来仍像正文，不像一个突兀的表单框。 */
  saidInput: {
    padding: 0,
    lineHeight: 23,
    ...(Type.body as object),
    minHeight: 46,
    textAlignVertical: 'top',
  },
  saidActions: { flexDirection: 'row', gap: Space.sm, marginTop: Space.md },
  saidAction: { flex: 1 },
  aiNote: { marginTop: Space.sm, lineHeight: 19 },
  preparing: { marginTop: Space.md, padding: Space.md },

  /* 未激活时的锁定态。与 ai.tsx 同一套写法，不另立样式 */
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.xs, paddingTop: Space.xs },
  lockedText: { lineHeight: 21 },
  lockedBtn: { marginTop: Space.md },
}));
