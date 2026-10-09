/**
 * 格物 · 问一问（设计稿 02 / 03 屏）
 *
 * 从 01 屏搜索框右侧的星标进来（不用底部第 6 个标签 —— 底部五格是「找东西」的骨架）。
 *
 * ── 这一页最重要的那条设计约束 ──────────────────────────────────
 * **答案必须落到具体物品卡片上，不接受纯文字答案。**
 * 纯文字答案有两个问题：一是它就成了通用聊天机器人，二是用户没法核实真假。
 * 所以结构上分成两层：下面那几张卡片由本机检索直接给出（事实层，模型碰不到），
 * 上面那句话才是模型写的（措辞层）。模型胡说的话，卡片一眼就能对不上。
 *
 * ── 三条降级路径（都不会打断使用）──────────────────────────────
 *   没配 Key    → 照样回答，用本机检索那句事实（文案会提示配 Key 后更自然）
 *   模型超时    → 静默退回本机事实，不弹任何错误
 *   库里是空的  → 说「先记几件东西再来问」，并给一个去录入的出口
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from '@/components/ui/controls';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, Label, Meta, Title } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import { buildAnswerPrompt, FOLLOW_UP_QUESTIONS, parseAnswer, SUGGESTED_QUESTIONS } from '@/lib/ai/answer';
import { AiError, askText, describeAiError } from '@/lib/ai/client';
import { place, retrieve, toSnapshot, type AiItemSnapshot, type Retrieval } from '@/lib/ai/retrieve';
import { today } from '@/lib/date';
import { listItems } from '@/lib/db/items';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAi } from '@/lib/store/ai';
import { useAppState } from '@/lib/store/app-state';
import { makeStyles } from '@/lib/theme';

export default function AskScreen() {
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { dataVersion } = useAppState();
  const { active, record } = useAi();

  const itemsState = useAsyncData(() => listItems({ sort: 'recent' }), [dataVersion], []);
  const snapshot = useMemo<AiItemSnapshot[]>(() => itemsState.data.map(toSnapshot), [itemsState.data]);

  const [draft, setDraft] = useState('');
  const [asked, setAsked] = useState('');
  /** 模型写的那句话。拿不到就是 null，界面退回 retrieval.fact */
  const [lead, setLead] = useState<string | null>(null);
  const [result, setResult] = useState<Retrieval | null>(null);
  const [busy, setBusy] = useState(false);
  /** 只有「没配 Key」才提示 —— 那是用户能处理的事；网络失败一律静默 */
  const [keyHint, setKeyHint] = useState<string | null>(null);

  /** 防连点：模型一次要等好几秒，连点会排出一串相同的请求 */
  const busyRef = useRef(false);

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setKeyHint(null);
      setDraft('');
      setAsked(question);
      setLead(null);

      /* 事实层：不管 AI 开没开、通不通，这一步都会跑完 —— 它不依赖网络，
         所以「AI 挂了」最差也只是回到本机检索的答案，而不是没有答案。 */
      const r = retrieve(question, snapshot, today());
      setResult(r);

      if (!active) {
        setBusy(false);
        busyRef.current = false;
        return;
      }

      try {
        const prompt = buildAnswerPrompt(question, r, snapshot.length);
        const text = await askText(prompt.system, prompt.user);
        record('chat');
        setLead(parseAnswer(text) ?? r.fact);
      } catch (err) {
        // 静默退回本机事实；只有「没配 Key」值得说一句，因为那是他能去修的
        setLead(r.fact);
        if (err instanceof AiError && err.kind === 'no-key') setKeyHint(describeAiError(err));
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [active, record, snapshot],
  );

  const total = snapshot.length;
  const answer = result ? (lead ?? result.fact) : null;
  /** 模型给的答案确实被用上了（而不是退回本机事实） */
  const polished = lead != null && result != null && lead !== result.fact;

  /**
   * 模型那一句还在路上。
   *
   * ★★ 这一条是照真机反馈加的：「先显示一条简短的答案，然后又显示一条大模型的答案」。
   *   实际发生的是**同一处文字被换掉** —— 本机那句先顶上，模型回来后被替换，
   *   而中间没有任何标记。用户读着一句话、它突然变了样，只会觉得「怎么冒出两条」。
   *
   *   所以这里刻意**不**在等待期间显示本机那句：宁可让那一格空着说「正在读」，
   *   也不要先给一个会被推翻的答案。物品卡片照旧立刻出来（那是本机检索的，
   *   不会变），用户从点下去到看见东西的延迟没有任何增加。
   *
   *   而「AI 挂了也有答案」这条不变量没有丢：失败时 `lead` 会被赋成本机那句，
   *   `aiWorking` 也就变成 false，答案照常显示出来。
   */
  const aiWorking = busy && active && lead == null;

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
      </View>

      {/* 这一行不能省：它同时是隐私声明与能力说明 —— 「只依据你的 N 件」把
          「它不会拿别人的数据回答你」和「它也答不了库外的问题」一次说清 */}
      <PageHeader
        title="问一问"
        subtitle={total > 0 ? `只依据你的 ${total} 件物品回答，数据不出手机` : '库里还没有东西'}
      />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {asked === '' ? (
          <Gutter>
            <Title style={styles.hero}>想找什么，直接问我</Title>
            <View style={styles.suggestions}>
              {SUGGESTED_QUESTIONS.map((q) => (
                <Pressable
                  key={q}
                  accessibilityRole="button"
                  accessibilityLabel={q}
                  onPress={() => void ask(q)}
                  style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}>
                  <Body tone="ink2" style={styles.suggestionText}>
                    {q}
                  </Body>
                  <Ionicons name="chevron-forward" size={14} color={Palette.ink4} />
                </Pressable>
              ))}
            </View>

            <Meta tone="ink4" style={styles.heroNote}>
              {active
                ? '回答只由你库里的记录决定。模型负责把话说顺，事实全部来自本机查询。'
                : '现在用的是本机检索，回答会比较朴实；到「我的 → AI 助手」配一个免费 Key 之后会更自然。'}
            </Meta>
          </Gutter>
        ) : (
          <>
            <Gutter>
              <View style={styles.askBubble}>
                <Body color={Palette.onAccent}>{asked}</Body>
              </View>
            </Gutter>

            {result ? (
              <SectionCard
                title={
                  aiWorking
                    ? '正在整理…'
                    : busy
                      ? '正在看你的库…'
                      : polished
                        ? '回答'
                        : '来自你的库'
                }>
                <Gutter>
                  {/* 答案位只有一个：要么「AI 正在读」，要么最终那句。
                     见上面 aiWorking 的注释 —— 同一位文字被换掉会读成两条答案 */}
                  {aiWorking ? (
                    <Card style={styles.answerCard}>
                      <Body tone="ink3" style={styles.answerText}>
                        AI 正在读你的库，把这几条整理成一句话…
                      </Body>
                    </Card>
                  ) : answer ? (
                    <Card style={styles.answerCard}>
                      <Body style={styles.answerText}>{answer}</Body>
                    </Card>
                  ) : null}

                  {total === 0 ? (
                    <Card style={styles.emptyCard}>
                      <Body tone="ink2" style={styles.emptyText}>
                        库里还是空的。先记几件东西，问一问才有得答。
                      </Body>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => router.push('/compose')}
                        style={styles.emptyBtn}>
                        <Label color={Palette.brand}>去录入第一件</Label>
                      </Pressable>
                    </Card>
                  ) : result.items.length > 0 ? (
                    <Card padded={false} style={styles.itemsCard}>
                      {result.items.map((item, index) => (
                        <ItemLine
                          key={item.id}
                          item={item}
                          last={index === result.items.length - 1}
                          onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
                        />
                      ))}
                    </Card>
                  ) : null}

                  {result.items.length > 0 ? (
                    <Meta tone="ink4" style={styles.footNote}>
                      {result.total > result.items.length
                        ? `以上 ${result.items.length} 条来自你的库（共 ${result.total} 条命中）· 点开可看详情`
                        : `以上 ${result.items.length} 条来自你的库 · 点开可看详情`}
                    </Meta>
                  ) : null}

                  {keyHint ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => router.push('/ai')}
                      style={styles.keyHint}>
                      <Ionicons name="key-outline" size={13} color={Palette.brand} />
                      <Label tone="brand">{keyHint}</Label>
                    </Pressable>
                  ) : null}
                </Gutter>
              </SectionCard>
            ) : null}

            {!busy ? (
              <Gutter>
                <View style={styles.followUps}>
                  {FOLLOW_UP_QUESTIONS.map((q) => (
                    <Pressable
                      key={q}
                      accessibilityRole="button"
                      accessibilityLabel={`接着问：${q}`}
                      onPress={() => void ask(q)}
                      style={({ pressed }) => [styles.followChip, pressed && styles.pressed]}>
                      <Label tone="ink2">{q}</Label>
                    </Pressable>
                  ))}
                </View>
              </Gutter>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* 输入条贴在屏底，自己补一条安全区 —— Screen 的 SafeAreaView 只吃上左右三边 */}
      <View style={[styles.inputBar, { paddingBottom: Space.sm + insets.bottom }]}>
        <View style={styles.input}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={asked === '' ? '聊聊家里的东西…' : '接着问…'}
            placeholderTextColor={Palette.ink4}
            style={styles.inputField}
            returnKeyType="send"
            autoCorrect={false}
            allowFontScaling={false}
            onSubmitEditing={() => void ask(draft)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="提问"
            hitSlop={8}
            disabled={!draft.trim() || busy}
            onPress={() => void ask(draft)}>
            <Ionicons
              name="arrow-up-circle"
              size={26}
              color={draft.trim() && !busy ? Palette.brand : Palette.ink4}
            />
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}

/* ------------------------------------------------------------ 物品行 */

/** 答案里的物品：名字 + 剩余天数 + 位置。与列表行不同的地方是它**不可多选、不带库存** */
function ItemLine({
  item,
  last,
  onPress,
}: {
  item: AiItemSnapshot;
  last: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const days = item.daysToExpiry;
  /* 语义色锁死：已过期砖红、将到期琥珀、其余次要灰。与首页图例同一套口径 */
  const tone = days == null ? Palette.ink4 : days < 0 ? Palette.clay : days <= 30 ? Palette.amber : Palette.ink3;
  const label =
    days == null
      ? '未记到期'
      : days < 0
        ? `已过期 ${Math.abs(days)} 天`
        : days === 0
          ? '今天到期'
          : `还剩 ${days} 天`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.name}，${label}`}
      onPress={onPress}
      style={({ pressed }) => [styles.itemRow, !last && styles.itemBorder, pressed && styles.pressed]}>
      <View style={styles.itemMain}>
        <Body numberOfLines={1} style={styles.itemName}>
          {item.name}
        </Body>
        <View style={styles.itemMeta}>
          <Label color={tone}>{label}</Label>
          <Meta tone="ink4" numberOfLines={1} style={styles.itemPlace}>
            {place(item)}
          </Meta>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={15} color={Palette.ink4} />
    </Pressable>
  );
}

const useStyles = makeStyles((Palette) => ({
  flex: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.xs, paddingTop: Space.xs },
  scroll: { paddingBottom: Space.xxl },

  hero: { marginTop: Space.md },
  suggestions: { marginTop: Space.lg, gap: Space.sm },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.sm,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
    backgroundColor: Palette.surface,
    borderRadius: Radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line2,
  },
  suggestionText: { flex: 1, lineHeight: 21 },
  heroNote: { marginTop: Space.lg, lineHeight: 20 },
  pressed: { opacity: 0.72 },

  askBubble: {
    alignSelf: 'flex-end',
    maxWidth: '100%',
    marginTop: Space.sm,
    paddingVertical: Space.sm,
    paddingHorizontal: Space.md,
    borderRadius: Radius.card,
    backgroundColor: Palette.brand,
  },

  answerCard: { marginTop: 0, padding: Space.md },
  answerText: { lineHeight: 23 },

  itemsCard: { marginTop: Space.md },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.sm,
    paddingVertical: 11,
    paddingHorizontal: Space.lg,
  },
  itemBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Palette.line3 },
  itemMain: { flex: 1, minWidth: 0 },
  itemName: { fontWeight: '500' },
  itemMeta: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, marginTop: 3 },
  itemPlace: { flexShrink: 1 },

  footNote: { marginTop: Space.sm, lineHeight: 19 },
  keyHint: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, marginTop: Space.md },
  emptyCard: { marginTop: Space.md, padding: Space.md },
  emptyText: { lineHeight: 21 },
  emptyBtn: { marginTop: Space.md },

  followUps: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, marginTop: Space.xl },
  followChip: {
    paddingHorizontal: Space.md,
    paddingVertical: 6,
    borderRadius: Radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line,
    backgroundColor: Palette.surface,
  },

  inputBar: {
    paddingHorizontal: GUTTER,
    paddingTop: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
    backgroundColor: Palette.canvas,
  },
  input: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: 42,
    paddingHorizontal: Space.md,
    backgroundColor: Palette.inset,
    borderRadius: Radius.input,
  },
  inputField: { flex: 1, padding: 0, fontSize: 14, color: Palette.ink },
}));
