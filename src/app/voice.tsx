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
import { GUTTER, Palette, Space } from '@/constants/theme';
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

      const parsed = parseVoiceInput(outcome.text, {
        locations: toLocationHints(locationState.data),
        today: today(),
      });

      setTranscript(outcome.text);
      setName(parsed.name);
      setLocationId(parsed.locationId);
      setExpireDate(parsed.expireDate);
      setAuto({
        name: parsed.name.length > 0,
        location: parsed.locationId != null,
        expire: parsed.expireDate != null,
      });
      // 重说一遍等于换了个答案，上一轮模型补的东西不能再挂着
      setAiFilled(new Set());
      setPhase('result');
    } finally {
      busy.current = false;
    }
  }, [locationState.data, transcript]);

  /* ---------------------------------------------------------- AI 补全 */

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
   * 把录音转写交给模型再读一遍，补上本地规则没听出来的字段。
   *
   * ★ 只补**空着的**行，绝不覆盖已有值：
   *   规则听得出来的那些已经在界面上了，而另外两个来源都可能出错 ——
   *   让后来的那个把先前的改写掉，用户会觉得自己看到的东西在随机变。
   * ★ 位置不参与：模型不知道用户的柜子叫什么，补出来的必然是编的。
   * ★ 补上的行挂「AI」标而不是「待确认」，两者把握程度不同，必须分得开。
   */
  const aiFill = useCallback(async () => {
    if (filling) return;
    setFilling(true);
    setNotice(null);
    try {
      const raw = await askText(buildVoicePrompt(categoryState.data.map((c) => c.name)), transcript);
      record('chat');
      const parsed = parseExtract(raw, { today: today(), categories: categoryState.data.map((c) => c.name) });

      const gained: AiField[] = [];
      if (!name.trim() && parsed?.fields.name) {
        setName(parsed.fields.name);
        gained.push('name');
      }
      if (!expireDate && parsed?.fields.expireDate) {
        setExpireDate(parsed.fields.expireDate);
        gained.push('expire');
      }

      if (gained.length === 0) {
        setNotice('AI 也没能补出新的内容，手动填一下就行');
        return;
      }
      setAiFilled((prev) => new Set([...prev, ...gained]));
    } catch (err) {
      // 这里是用户主动点的按钮，失败了要说一声；静默会让人以为按了没反应
      setNotice(describeAiError(err));
    } finally {
      setFilling(false);
    }
  }, [filling, transcript, categoryState.data, name, expireDate, record]);

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

  /* 「让 AI 读一遍」只在两个条件下出现：
     ① 这一档能用 AI（免费档的语音是完整的，只是没有这一步 —— 不做灰按钮，
        语音本身不该因为 AI 而被加门槛）；
     ② 确实还有没听出来的行 —— 三行都填上了就没有可补的，多一个按钮只是噪音。 */
  const canAiFill = entitled && aiActive && (!name.trim() || !expireDate);

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
                  <Meta tone="ink4">听到的是</Meta>
                </View>
                <Body style={styles.said}>{transcript}</Body>
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

              {canAiFill ? (
                <Button
                  label={filling ? '正在让 AI 读…' : '让 AI 读一遍，补齐没听出来的'}
                  icon="sparkles-outline"
                  tone="secondary"
                  style={styles.aiFill}
                  onPress={() => void aiFill()}
                  loading={filling}
                  disabled={saving}
                />
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
  said: { lineHeight: 23 },

  fields: { marginTop: Space.md },
  /* AI 补全按钮与三行字段拉开一点：它是「对这份结果再加工一次」，
     不该看起来像是字段卡的一部分 */
  aiFill: { marginTop: Space.md },
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
