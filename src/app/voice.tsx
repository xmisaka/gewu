/**
 * 格物 · 语音录入（设计稿 05 屏）
 *
 * 一句话 → 三个字段。说的是「厨房橱柜二放了一包牛肉面，保质期到年底」，
 * 拿到的是 名称 牛肉面 / 位置 厨房·橱柜2 / 到期 12-31，**然后停下来等你确认**。
 *
 * ── 三条不变量 ────────────────────────────────────────────────
 *
 * 1. **绝不直接入库**。识别有误差，所以结果一律先落到「待确认」的三行里，
 *    由用户点「确认并保存」才写库。这也是 05 屏那条脚注的原意。
 *
 * 2. **不申请录音权限**。识别走系统对话框（见 lib/ai/asr.ts），
 *    录音发生在识别器 App 里，格物的权限清单一个字节都不变。
 *
 * 3. **解析可以不准，界面必须诚实**。没听懂的行写「未识别」并留出改的入口，
 *    不拿一个猜出来的值冒充听懂了 —— 猜错的东西用户不一定发现，
 *    而「未识别」他一定会看见。
 *
 * ── 2026-10-09：把「转写文字」变成第一等公民 ────────────────────
 *
 * 原来的流程是**一条道走到黑**：语音 → 本地规则 → 三行，中间那句转写只用来读，
 * 用户看着「橱柜二」被听成「橱柜二二」也只能重说整句。
 * 而「重说」代价很高 —— 要重走一遍系统识别框，还不一定比上次准。
 *
 * 现在改成：
 *   语音 → **可编辑的转写** → 本地规则先给初值 → 有 AI 就**自动**再读一遍 →
 *   三行；改完文字按「重新识别」重跑，不必重录。
 *
 * 两处刻意的取舍：
 *   - **本地规则先跑**，不让模型等在前面。它是纯函数、零延迟、不联网，
 *     用户从系统识别框回来那一瞬间就该看到东西；模型那一步是「再来一轮更好」。
 *   - **自动跑模型，但只补空着的行**。用户没点按钮却看到字段自己变了，
 *     会怀疑「我刚填的怎么没了」—— 已有的值一律不动。
 *     想按新文字重算，就按「重新识别」：那是用户明确要求的，允许覆盖。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
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

import { DatePickerModal } from '@/components/domain/DatePickerModal';
import { LocationPickerModal } from '@/components/domain/LocationPickerModal';
import { PlainTag } from '@/components/ui/feedback';
import { Button, IconButton } from '@/components/ui/controls';
import { Card, Gutter, PageHeader, Screen, ScreenScroll } from '@/components/ui/layout';
import { Body, Meta, Title } from '@/components/ui/typography';
import { GUTTER, Palette, Space, Type } from '@/constants/theme';
import { ASR_AVAILABLE, asrMessage, listenOnce } from '@/lib/ai/asr';
import { askText, describeAiError } from '@/lib/ai/client';
import { buildVoicePrompt, parseExtract } from '@/lib/ai/extract';
import { parseVoiceInput, toLocationHints } from '@/lib/ai/voice-parse';
import { formatDateCN, today } from '@/lib/date';
import { listCategories } from '@/lib/db/categories';
import { createItem } from '@/lib/db/items';
import { listCabinetViews, listLocations } from '@/lib/db/locations';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { guessCategory } from '@/lib/suggest';
import { useAi } from '@/lib/store/ai';
import { useAppState } from '@/lib/store/app-state';
import { useEntitlement } from '@/lib/store/entitlement';
import { makeStyles, useTheme } from '@/lib/theme';

type Phase = 'idle' | 'listening' | 'result';

/** 哪几行是解析填进去的 —— 只有它们配得上「待确认」这个标 */
interface AutoFilled {
  name: boolean;
  location: boolean;
  expire: boolean;
}

const NOTHING_AUTO: AutoFilled = { name: false, location: false, expire: false };

/**
 * 行尾那个小标的两种含义。
 *   pending —— 本地规则听出来的，等用户确认
 *   ai      —— 模型补出来的，把握更不确定，要和规则填的分得开
 */
type RowTag = 'pending' | 'ai';

/** 模型能补的两行。位置补不了（模型不知道你的柜子长什么样），分类不显示在这一屏 */
type AiField = 'name' | 'expire';

export default function VoiceScreen() {
  const router = useRouter();
  const styles = useStyles();
  const { tokens } = useTheme();
  const { bump } = useAppState();
  /* 底部按钮条贴在屏底，`Screen` 的 SafeAreaView 只吃上左右三边，
     所以这里自己补一条 —— 少了它，手势条会压住「确认并保存」 */
  const insets = useSafeAreaInsets();

  const { entitled } = useEntitlement();
  const { active: aiActive, record } = useAi();

  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState('');
  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [expireDate, setExpireDate] = useState<string | null>(null);
  const [auto, setAuto] = useState<AutoFilled>(NOTHING_AUTO);
  /** 模型补过的行。用户一动它就把标摘掉，理由见 ItemForm.clearAi */
  const [aiFilled, setAiFilled] = useState<Set<AiField>>(new Set());
  const [filling, setFilling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [locOpen, setLocOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
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

  /* 位置显示成「厨房 · 橱柜2」，与设计稿一致；格位取父级柜子名 */
  const locationLabel = useMemo(() => {
    if (!locationId) return null;
    const loc = locationState.data.find((l) => l.id === locationId);
    if (!loc) return null;
    if (!loc.parentId) return loc.name;
    const parent = locationState.data.find((l) => l.id === loc.parentId);
    return parent ? `${parent.name} · ${loc.name}` : loc.name;
  }, [locationId, locationState.data]);

  /**
   * 用户手动改过某一行 → 摘掉那一行的「AI」标。
   * 与录入表单的 clearAi 是同一条理由：一个永远挂着的标会失去意义。
   */
  const clearAi = useCallback((key: AiField) => {
    setAiFilled((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  /**
   * 从一段文字里把三行抽出来。
   *
   * 分两步，顺序是刻意的：
   *   ① **本地规则**（纯函数、零延迟、不联网）—— 立即给出一版结果，
   *      用户从系统识别框回来就该看到东西，不该对着空白等网络。
   *   ② **模型**（可选，只在支持者档且开关开着时）—— 只补本地没填上的行。
   *
   * `overwrite` 决定第 ① 步要不要覆盖已经显示的值：
   *   - 自动那一轮传 false —— 用户可能刚手改过，不能被悄悄改回去；
   *   - 用户按「重新识别」传 true —— 那是他明确要求的重算。
   */
  const runParse = useCallback(
    async (text: string, opts: { overwrite: boolean; announce: boolean }) => {
      const parsed = parseVoiceInput(text, {
        locations: toLocationHints(locationState.data),
        today: today(),
      });

      /* 本轮本地规则给出的值；下一段要用它判断「哪些还是空的」 */
      let nextName = parsed.name;
      let nextExpire = parsed.expireDate;
      const nextAuto: AutoFilled = {
        name: parsed.name.length > 0,
        location: parsed.locationId != null,
        expire: parsed.expireDate != null,
      };

      setAuto(nextAuto);
      // 重新解析等于换了答案，上一轮的「AI」标不能再挂着
      setAiFilled(new Set());

      if (opts.overwrite) {
        setName(parsed.name);
        setLocationId(parsed.locationId);
        setExpireDate(parsed.expireDate);
      } else {
        /* 不覆盖：只在原来空着的位置补上 —— 位置同理 */
        setName((prev) => (prev.trim() ? prev : parsed.name));
        setLocationId((prev) => prev ?? parsed.locationId);
        setExpireDate((prev) => prev ?? parsed.expireDate);
        nextName = name.trim() || parsed.name;
        nextExpire = expireDate ?? parsed.expireDate;
      }

      if (!entitled || !aiActive) return;

      /* ---- 第 ② 步：模型 ---- */
      setFilling(true);
      try {
        const raw = await askText(buildVoicePrompt(categoryState.data.map((c) => c.name)), text);
        record('chat');
        const extracted = parseExtract(raw, {
          today: today(),
          categories: categoryState.data.map((c) => c.name),
        });

        const gained: AiField[] = [];
        if (!nextName.trim() && extracted?.fields.name) {
          setName(extracted.fields.name);
          gained.push('name');
        }
        if (!nextExpire && extracted?.fields.expireDate) {
          setExpireDate(extracted.fields.expireDate);
          gained.push('expire');
        }
        if (gained.length > 0) setAiFilled((prev) => new Set([...prev, ...gained]));
      } catch (err) {
        /* ★ 两种情形的处理**必须分开**：
           - 自动那一轮静默：用户没按任何按钮，弹一句「AI 失败了」只会让他
             以为整个语音录入坏了 —— 而本机规则的结果此刻已经在屏幕上。
           - 用户手按「重新识别」时要说一声：那是他主动发起的，
             什么都不发生等于「按了没反应」，与录入页那条教训同源。 */
        if (opts.announce) setNotice(describeAiError(err));
      } finally {
        setFilling(false);
      }
    },
    [
      locationState.data,
      categoryState.data,
      entitled,
      aiActive,
      record,
      name,
      expireDate,
      setAuto,
    ],
  );

  const startListen = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setNotice(null);
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
      /* 这一次是全新的文字，允许覆盖 */
      await runParse(outcome.text, { overwrite: true, announce: false });
    } finally {
      busy.current = false;
    }
  }, [runParse, transcript]);

  /**
   * 用户改完转写文字后按的「重新识别」。
   *
   * 与自动那一轮的差别只有一处：**允许覆盖**。
   * 他既然改了文字又点了这个按钮，就是想按新文字重算一遍 ——
   * 这时候还守着「只补空行」，他会觉得按钮没反应。
   */
  const reparse = useCallback(async () => {
    if (busy.current || !transcript.trim()) return;
    busy.current = true;
    setNotice(null);
    try {
      await runParse(transcript, { overwrite: true, announce: true });
    } finally {
      busy.current = false;
    }
  }, [runParse, transcript]);

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      /* 分类仍然猜一次 —— 与手动录入走同一套补偿机制，
         否则语音录进去的东西会成批落在「未分类」里。
         这里**只沿用「按名称猜」，不套用分类的默认保质期**：
         用户没说过期日，界面也没显示过它，替他写一个就等于
         凭空多出一条他没确认过的信息。 */
      const guessed = guessCategory(trimmed);
      const category = guessed ? categoryState.data.find((c) => c.name === guessed) : undefined;

      await createItem({
        name: trimmed,
        categoryId: category?.id ?? null,
        locationId,
        // 与录入表单的默认值一致：没说的购买日期按今天算，
        // 这样持有天数与日均成本不会因为漏填而缺席
        purchaseDate: today(),
        price: null,
        expireDate,
        brand: null,
        model: null,
        quantity: null,
        tags: [],
        note: null,
        sortOrder: null,
      });

      bump();
      router.replace('/');
    } finally {
      setSaving(false);
    }
  }, [name, saving, categoryState.data, locationId, expireDate, bump, router]);

  const showResult = phase === 'result' && transcript.length > 0;

  /* 这一档能不能让模型参与。免费档的语音是完整的（本机规则照常跑），
     只是没有「模型再读一遍」这一步 —— 不做灰按钮，语音不该因为 AI 被加门槛。 */
  const aiOn = entitled && aiActive;

  /* 模型正在读。要显示出来 —— 否则用户看不出「到底走没走大模型」，
     而这正是上一版被抱怨的地方。 */
  const aiBusy = aiOn && filling;

  return (
    <Screen>
      <PageHeader
        title="语音录入"
        subtitle={showResult ? '确认一下再保存' : '说一句话就能录入'}
        right={<IconButton icon="close" accessibilityLabel="关闭" onPress={() => router.back()} />}
      />

      {showResult ? (
        <>
          <ScreenScroll bottomInset={Space.md}>
            <Gutter>
              <Card>
                <View style={styles.saidHead}>
                  <Ionicons name="mic" size={13} color={tokens.ink4} />
                  <Meta tone="ink4">听到的是（可以直接改）</Meta>
                </View>
                {/* ★ 转写变成可编辑 —— 听错一个字不必重说整句。
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
                <Button
                  label={aiBusy ? '正在让 AI 读…' : '按这段文字重新识别'}
                  icon={aiOn ? 'sparkles-outline' : 'refresh-outline'}
                  tone="secondary"
                  style={styles.reparse}
                  onPress={() => void reparse()}
                  loading={aiBusy}
                  disabled={saving || !transcript.trim()}
                />
              </Card>

              <Card padded={false} style={styles.fields}>
                <FieldRow label="名称" tag={aiFilled.has('name') ? 'ai' : auto.name ? 'pending' : undefined}>
                  <TextInput
                    value={name}
                    onChangeText={(t) => {
                      setName(t);
                      clearAi('name');
                    }}
                    style={[styles.input, { color: tokens.ink }]}
                    placeholder="比如：牛肉面"
                    placeholderTextColor={tokens.ink4}
                    selectionColor={tokens.brand}
                    returnKeyType="done"
                    accessibilityLabel="物品名称"
                  />
                </FieldRow>

                <FieldRow label="位置" tag={auto.location ? 'pending' : undefined} onPress={() => setLocOpen(true)} last={false}>
                  <Value text={locationLabel} />
                </FieldRow>

                <FieldRow
                  label="到期"
                  tag={aiFilled.has('expire') ? 'ai' : auto.expire ? 'pending' : undefined}
                  onPress={() => setDateOpen(true)}
                  last>
                  <Value text={expireDate ? formatDateCN(expireDate) : null} />
                </FieldRow>
              </Card>

              {/* 模型参与时明说一句 —— 用户抱怨过「好像没走大模型」，
                  而它其实一直在跑，只是没有任何痕迹 */}
              {aiOn ? (
                <Meta tone="ink4" style={styles.aiNote}>
                  {aiBusy
                    ? 'AI 正在按这句话补齐没听出来的字段…'
                    : '已让 AI 读过一遍，它只补空着的行 —— 你填过的不会被改掉。'}
                </Meta>
              ) : null}

              {notice ? (
                <Meta color={tokens.clay} style={styles.resultNotice}>
                  {notice}
                </Meta>
              ) : null}

              <Meta tone="ink4" style={styles.tip}>
                听错了？点任意一行都能改，也可以按「重说」重录一遍。
              </Meta>
            </Gutter>
          </ScreenScroll>

          <Gutter>
            <View style={[styles.actions, { paddingBottom: Space.lg + insets.bottom }]}>
              <Button
                label="重说"
                tone="secondary"
                block={false}
                style={styles.actionMinor}
                onPress={() => void startListen()}
                disabled={saving}
              />
              <Button
                label="确认并保存"
                block={false}
                style={styles.actionMajor}
                onPress={() => void save()}
                disabled={!name.trim()}
                loading={saving}
              />
            </View>
          </Gutter>
        </>
      ) : (
        <View style={styles.center}>
          <Wave active={phase === 'listening'} />

          <Title style={styles.lead}>
            {phase === 'listening' ? '正在听…' : '说一句话就能录入'}
          </Title>
          <Body tone="ink3" style={styles.sample}>
            像这样：「厨房橱柜二放了一包牛肉面，保质期到年底」
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

          <Meta tone="ink4" style={styles.privacy}>
            用手机自带的语音识别，格物不录音、不上传。识别完还会让你确认一遍才入库。
          </Meta>

          {notice ? (
            <Button
              label="改用手动录入"
              tone="ghost"
              block={false}
              style={styles.manualBtn}
              onPress={() => router.replace('/compose')}
            />
          ) : null}
        </View>
      )}

      <LocationPickerModal
        visible={locOpen}
        cabinets={cabinetState.data}
        selectedId={locationId}
        onClose={() => setLocOpen(false)}
        onPick={setLocationId}
      />
      <DatePickerModal
        visible={dateOpen}
        value={expireDate}
        clearable
        title="选择到期时间"
        onClose={() => setDateOpen(false)}
        onPick={(d) => {
          setExpireDate(d);
          clearAi('expire');
        }}
      />
    </Screen>
  );
}

/* ------------------------------------------------------------ 字段行 */

function FieldRow({
  label,
  tag,
  onPress,
  last,
  children,
}: {
  label: string;
  /** 这一行的值是谁填的 → 决定行尾挂什么标；没填出来就不挂 */
  tag?: RowTag;
  onPress?: () => void;
  last?: boolean;
  children: ReactNode;
}) {
  const styles = useStyles();
  const inner = (
    <>
      <Meta tone="ink3" style={styles.rowLabel}>
        {label}
      </Meta>
      <View style={styles.rowValue}>{children}</View>
      {tag ? (
        <PlainTag text={tag === 'ai' ? 'AI' : '待确认'} tone={tag === 'ai' ? 'brand' : 'neutral'} />
      ) : null}
      {onPress ? <Ionicons name="chevron-forward" size={13} color={Palette.ink4} /> : null}
    </>
  );

  if (!onPress) return <View style={[styles.row, last && styles.rowLast]}>{inner}</View>;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}，点击修改`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, last && styles.rowLast, pressed && styles.rowPressed]}>
      {inner}
    </Pressable>
  );
}

/** 行里的值。null = 解析没听懂，如实写「未识别」 */
function Value({ text }: { text: string | null }) {
  const styles = useStyles();
  return (
    <Body numberOfLines={1} tone={text ? 'ink' : 'ink4'} style={styles.valueText}>
      {text ?? '未识别'}
    </Body>
  );
}

/* ------------------------------------------------------------ 波形 */

/** 设计稿里那 14 根条的高度，原样搬过来 */
const BAR_HEIGHTS = [9, 17, 28, 14, 24, 34, 19, 29, 12, 22, 32, 16, 26, 11];

/**
 * 待机波形。
 *
 * ★ 它是**装饰**，不是音量表 —— 走系统识别对话框时，录音发生在另一个进程里，
 *   我们拿不到任何音频数据。所以只做一条匀速呼吸的错相动画，
 *   不做「跟着说话起伏」的假象：那会让人以为它真在听。
 */
function Wave({ active }: { active: boolean }) {
  const styles = useStyles();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!active) {
      cancelAnimation(progress);
      progress.value = 0;
      return;
    }
    progress.value = 0;
    progress.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(progress);
  }, [active, progress]);

  return (
    <View style={styles.wave}>
      {BAR_HEIGHTS.map((h, i) => (
        <Bar key={i} index={i} height={h} progress={progress} active={active} />
      ))}
    </View>
  );
}

function Bar({
  index,
  height,
  progress,
  active,
}: {
  index: number;
  height: number;
  progress: SharedValue<number>;
  active: boolean;
}) {
  const styles = useStyles();
  const anim = useAnimatedStyle(() => {
    if (!active) return { opacity: 0.35, transform: [{ scaleY: 0.5 }] };
    // 每根条错开相位，看起来才像流动而不是整块呼吸
    const wave = 0.45 + 0.55 * Math.abs(Math.sin((progress.value + index * 0.07) * Math.PI));
    return { opacity: 0.5 + 0.5 * wave, transform: [{ scaleY: wave }] };
  }, [active]);
  return <Animated.View style={[styles.waveBar, { height }, anim]} />;
}

const useStyles = makeStyles((Palette) => ({
  /* 待机态：整块居中，底部留出安全距离 */
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: GUTTER, paddingBottom: Space.xxxl },

  wave: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, height: 38 },
  waveBar: { width: 3, borderRadius: 2, backgroundColor: Palette.brand },

  lead: { marginTop: Space.xl, textAlign: 'center' },
  sample: { marginTop: Space.sm, textAlign: 'center', lineHeight: 22 },
  micBtn: { marginTop: Space.xxl },
  notice: { marginTop: Space.lg, textAlign: 'center' },
  privacy: { marginTop: Space.lg, textAlign: 'center', lineHeight: 19, paddingHorizontal: Space.lg },
  manualBtn: { marginTop: Space.md },

  /* 结果态 */
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
  reparse: { marginTop: Space.md },

  fields: { marginTop: Space.md },
  aiNote: { marginTop: Space.sm, lineHeight: 19 },
  resultNotice: { marginTop: Space.sm, lineHeight: 19 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.line3,
    minHeight: 44,
  },
  rowLast: { borderBottomWidth: 0 },
  rowPressed: { backgroundColor: Palette.inset },
  rowLabel: { width: 46 },
  rowValue: { flex: 1, minWidth: 0 },
  valueText: { fontWeight: '500' },
  /* 名称是唯一可内联编辑的行，样式要跟另外两行长得一样，
     不然一眼就看出「这一行能改、那两行不能」，反而更乱 */
  input: { fontSize: 14, lineHeight: 22, padding: 0, margin: 0 },

  tip: { marginTop: Space.sm, lineHeight: 19 },

  /* 底部按钮条。paddingBottom 的额外安全区在组件里叠加（见 insets） */
  actions: { flexDirection: 'row', gap: Space.sm },
  actionMinor: { flex: 1 },
  actionMajor: { flex: 1.7 },
}));
