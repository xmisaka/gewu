/**
 * 格物 · 支持者权益说明页
 *
 * 一页两态，看进门时的档位：
 *   未激活 → 权益说明（价值主张 / 免费档 vs 支持者档 / 三项详解）
 *   已激活 → 我的权益（当前档位 / 已解锁三项 / 去哪看码）
 *
 * ★ 为什么这一页要单独存在，而不是塞进 `supporter.tsx`：
 *   那一页管的是**码**（粘贴、校验、凭证），这一页管的是**权益**（值不值）。
 *   权益原先只在三个地方零散出现，且**全是「你被挡住」的语境** —— 门控浮层、
 *   激活页「还没买」段、我的页一行入口。要看全貌得先撞三次墙，撞完还是拼不齐。
 *   所以这一页的第一顺位不是「多讲一点」，而是**给权益一个正向的、完整的、
 *   能反复回看的地方**。三处入口都汇聚到这里。
 *
 * ★ 它必须是 root Stack 路由（`app/_layout.tsx` 里注册），不能放进 `(tabs)`：
 *   tab 不压栈，从门控浮层或「我的」页 push 进来会变成切 tab，
 *   安卓返回键会落到第一格（物品页）而不是来处。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AddWechatSheet } from '@/components/domain/AddWechatSheet';
import { Button, IconButton } from '@/components/ui/controls';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, Heading, Label, Meta, Title } from '@/components/ui/typography';
import { GUTTER, LIGHT_THEME_KEYS, Palette, Radius, Space, THEMES } from '@/constants/theme';
import { AFDIAN_ITEM_URL } from '@/constants/site';
import {
  FREE_BASELINE,
  isThemeLocked,
  SUPPORTER_FEATURES,
  type SupporterFeature,
} from '@/lib/entitlement';
import { formatDateCN } from '@/lib/date';
import { useEntitlement } from '@/lib/store/entitlement';
import { makeStyles } from '@/lib/theme';

/**
 * 三项权益的展示顺序。
 *
 * 皮肤在前是刻意的：它是一眼看懂的（六个色块摆在那儿），
 * 先给一个「我立刻能感受到」的东西，后面两项才有耐心读。
 * AI 居中，因为它是最值钱也最需要解释的一项 —— 夹在中间正好。
 *
 * ★ 这个列表必须与 `SUPPORTER_FEATURES` 的键集合完全一致，
 *   以后加了第四项权益而这里忘了加，界面上就会**静默**少一项。
 *   由 `tests/pro-page.test.mjs` 钉住。
 */
const FEATURE_ORDER: readonly SupporterFeature[] = ['theme', 'ai', 'stats'];

/** 已解锁清单右侧的一句短提示。只在这张清单里用，不搬去别处 */
const UNLOCKED_HINT: Record<SupporterFeature, string> = {
  theme: '六套浅色',
  ai: '识物 / 批量 / 问答 / 语音',
  stats: '五项指标',
};

/**
 * 权益对比表里「AI 功能」那一行的四个子项。
 *
 * ★ 与 `SUPPORTER_FEATURES.ai.proSide`（三项详解卡里那行）讲的是同一件事 ——
 *   两处都在列举 AI 到底有哪几个入口，改一处必须同时看另一处，
 *   否则对比表里少一个「批量识图」而明细卡里有，而且不报错。
 */
const AI_ENTRY_HINT = '识物 · 批量识图 · 问答 · 语音';

export default function ProScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { entitled, entitlement } = useEntitlement();

  const [wechatOpen, setWechatOpen] = useState(false);

  /** 去爱发电下单（购买主路径）。打开失败不弹错误 —— 下面并列的「加我微信」就是备用。 */
  const openAfdian = () => {
    void Linking.openURL(AFDIAN_ITEM_URL).catch(() => undefined);
  };

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
      </View>

      <PageHeader
        title={entitled ? '我的权益' : '支持者权益'}
        subtitle={
          entitled
            ? '已解锁的三项，以及换机时怎么办'
            : '免费档有什么、支持者档多什么，一页看完'
        }
      />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {entitled ? <UnlockedView issuedOn={entitlement.issuedOn} /> : <PitchView />}
      </ScrollView>

      <View style={styles.foot}>
        {entitled ? (
          <Button label="返回" tone="secondary" onPress={() => router.back()} />
        ) : (
          <>
            {/* ★ 2026-10-15：主按钮改回爱发电商品页（创作者认证通过、下单自动发码）。
                ★ 微信**并列**成次按钮，是备用 —— 爱发电打不开、或想直接找我的人走它。
                  两者不是二选一：主路径是一次能自助完成的下单，备路径是人工兜底。 */}
            <Button label="去爱发电支持 · ¥36" onPress={openAfdian} />
            <Button
              label="加我微信"
              tone="secondary"
              style={styles.secondary}
              onPress={() => setWechatOpen(true)}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="我已有激活码"
              onPress={() => router.push('/supporter')}
              style={styles.later}>
              <Meta tone="ink3">我已有激活码</Meta>
            </Pressable>
          </>
        )}
      </View>

      <AddWechatSheet visible={wechatOpen} onClose={() => setWechatOpen(false)} />
    </Screen>
  );
}

/* ------------------------------------------------------------ 未激活：权益说明 */

function PitchView() {
  const styles = useStyles();

  return (
    <>
      {/* 段 1 · 价值主张 */}
      <Gutter>
        <Card tone="brandBg" style={styles.pitch}>
          <Title style={styles.pitchTitle}>换颜色 · 少打字 · 看懂家底</Title>
          <Meta tone="ink2" style={styles.pitchLine}>
            ¥36 一次买断 · 永久有效 · 不限设备 · 不订阅不续费
          </Meta>
        </Card>
      </Gutter>

      {/* 段 2 · 两栏对比。免费档放左边且正面列出 —— 它是完整版，不是试用版 */}
      <SectionCard title="免费档 vs 支持者档">
        <Gutter>
          <View style={styles.compare}>
            <View style={styles.col}>
              <Label tone="ink2" style={styles.colName}>
                免费档
              </Label>
              {FREE_BASELINE.map((line) => (
                <View key={line} style={styles.colRow}>
                  <Ionicons name="checkmark" size={12} color={Palette.sage} />
                  <Meta tone="ink2" style={styles.colText}>
                    {line}
                  </Meta>
                </View>
              ))}
            </View>

            <View style={[styles.col, styles.colPro]}>
              <Label color={Palette.brand} style={styles.colName}>
                支持者档 ¥36
              </Label>
              <View style={styles.colRow}>
                <Ionicons name="checkmark" size={12} color={Palette.sage} />
                <Meta style={styles.colText}>以上全部照旧</Meta>
              </View>
              {FEATURE_ORDER.map((key) => (
                <View key={key} style={styles.colRow}>
                  <Ionicons name="add" size={12} color={Palette.brand} />
                  <View style={styles.colStack}>
                    <Meta color={Palette.brand}>{SUPPORTER_FEATURES[key].name}</Meta>
                    {/* ★ AI 那一行把四个入口摊开写在对比表里：只写「AI 功能」四个字，
                        用户看不出「批量识图」也在里面 —— 对比表是决策的地方，
                        这里少一项，就等于那一项不存在 */}
                    {key === 'ai' ? (
                      <Meta tone="ink4" style={styles.colSub}>
                        {AI_ENTRY_HINT}
                      </Meta>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </View>

          <Meta tone="ink4" style={styles.compareNote}>
            免费档功能一个不少 —— 收纳、到期提醒、库存、照片、备份恢复全部照旧。
          </Meta>
        </Gutter>
      </SectionCard>

      {/* 段 3 · 三项详解。每项统一结构：它是什么 → 免费档什么体验 → 支持者档多什么 */}
      <SectionCard title="支持者档多出这三样">
        <Gutter>
          <View style={styles.features}>
            {FEATURE_ORDER.map((key, index) => {
              const copy = SUPPORTER_FEATURES[key];
              return (
                <Card key={key} style={styles.feature}>
                  <View style={styles.featureHead}>
                    <View style={styles.featureIdx}>
                      <Label color={Palette.brand} style={styles.featureIdxText}>
                        {index + 1}
                      </Label>
                    </View>
                    <Heading style={styles.featureName}>{copy.name}</Heading>
                  </View>

                  <Body tone="ink2" style={styles.featureTagline}>
                    {copy.tagline}
                  </Body>

                  {key === 'theme' ? <ThemeSwatches /> : null}

                  {/* ★ AI 这一张必须把「Key 是你自己的、不按量收费」与
                      「支持者档包含 AI」**同屏**写出来。分开写，用户只会看到前一句，
                      然后把后一句读成「我付了钱还得自己掏 API 费」 */}
                  {key === 'ai' ? (
                    <Meta tone="ink4" style={styles.featureNote}>
                      Key 由你自己申请，调用量记在你自己的账号上 —— 格物不代出 Key，也不按量收费。
                    </Meta>
                  ) : null}

                  <View style={styles.sides}>
                    <View style={styles.side}>
                      <Meta tone="ink4" style={styles.sideKey}>
                        免费档
                      </Meta>
                      <Meta tone="ink2" style={styles.sideVal}>
                        {copy.freeSide}
                      </Meta>
                    </View>
                    <View style={styles.side}>
                      <Meta tone="ink4" style={styles.sideKey}>
                        支持者档
                      </Meta>
                      <Meta color={Palette.brand} style={styles.sideVal}>
                        {copy.proSide}
                      </Meta>
                    </View>
                  </View>
                </Card>
              );
            })}
          </View>
        </Gutter>
      </SectionCard>
    </>
  );
}

/**
 * 六套浅色的色卡。
 *
 * ★ 色块取的是 `THEMES[key].tokens.brand` —— **每套主题自己的**品牌色，
 *   不是当前主题的。这里要的正是「把这六种颜色并排摆出来」，写死色值也一样能看，
 *   但那样改一次主题色这里就静默错位，且不报错。
 */
function ThemeSwatches() {
  const styles = useStyles();

  return (
    <View style={styles.swatches}>
      {LIGHT_THEME_KEYS.map((key) => {
        const def = THEMES[key];
        /* 这一栏是给「还没买的人」看的，所以一律以免费档视角判断谁带锁标：
           已激活的人走的是 UnlockedView，根本到不了这里 */
        const locked = isThemeLocked(key, false);
        return (
          <View key={key} style={styles.swatch}>
            <View style={[styles.swatchChip, { backgroundColor: def.tokens.brand }]} />
            <Meta tone={locked ? 'ink3' : 'ink2'} style={styles.swatchName}>
              {def.name}
            </Meta>
            {locked ? (
              <Meta tone="ink4" style={styles.swatchLock}>
                支持者
              </Meta>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------ 已激活：我的权益 */

function UnlockedView({ issuedOn }: { issuedOn: string | null }) {
  const styles = useStyles();
  const router = useRouter();

  return (
    <>
      <SectionCard title="当前档位">
        <Gutter>
          <Card padded={false}>
            <View style={styles.row}>
              <Meta tone="ink3" style={styles.rowKey}>
                档位
              </Meta>
              <Body style={styles.rowValue}>支持者 · 一次买断</Body>
              <Meta color={Palette.sage}>在用</Meta>
            </View>
            <View style={styles.row}>
              <Meta tone="ink3" style={styles.rowKey}>
                有效期
              </Meta>
              <Body style={styles.rowValue}>永久</Body>
              <Meta tone="ink4">不订阅、不续费</Meta>
            </View>
            <View style={[styles.row, styles.rowLast]}>
              <Meta tone="ink3" style={styles.rowKey}>
                设备
              </Meta>
              <Body style={styles.rowValue}>不限台数</Body>
              <Meta tone="ink4">码里不含设备信息</Meta>
            </View>
          </Card>
        </Gutter>
      </SectionCard>

      <SectionCard title="已解锁">
        <Gutter>
          <Card padded={false}>
            {FEATURE_ORDER.map((key, index) => (
              <View
                key={key}
                style={[styles.row, index === FEATURE_ORDER.length - 1 && styles.rowLast]}>
                <View style={styles.checkMark}>
                  <Ionicons name="checkmark" size={11} color={Palette.sage} />
                </View>
                <Body style={styles.rowValue}>{SUPPORTER_FEATURES[key].name}</Body>
                <Meta tone="ink4">{UNLOCKED_HINT[key]}</Meta>
              </View>
            ))}
          </Card>
        </Gutter>
      </SectionCard>

      <Gutter>
        <Meta tone="ink4" style={styles.tailNote}>
          {issuedOn
            ? `换机时把这串码再粘一次即可，不需要联网登记。「支持者状态」页里有完整激活码，签发于 ${formatDateCN(issuedOn)}。`
            : '换机时把这串码再粘一次即可，不需要联网登记。「支持者状态」页里有完整激活码与找回办法。'}
        </Meta>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="去支持者状态页"
          onPress={() => router.push('/supporter')}
          style={styles.tailLink}>
          <Meta color={Palette.brand}>去支持者状态页 →</Meta>
        </Pressable>
      </Gutter>
    </>
  );
}

/* ------------------------------------------------------------ 样式 */

const useStyles = makeStyles((Palette) => ({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Space.xs,
    paddingTop: Space.xs,
  },
  scroll: { paddingBottom: Space.xxl },

  /* 价值主张 */
  pitch: { padding: Space.lg },
  pitchTitle: { fontSize: 20 },
  pitchLine: { marginTop: Space.xs, lineHeight: 20 },

  /* 两栏对比 */
  compare: { flexDirection: 'row', gap: Space.sm },
  col: {
    flex: 1,
    minWidth: 0,
    padding: Space.md,
    borderRadius: Radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line2,
    backgroundColor: Palette.surface,
    gap: 7,
  },
  /* 支持者那栏用品牌描边：整页只此一处强调，多了就不叫强调了 */
  colPro: { borderColor: Palette.brand, borderWidth: 1 },
  colName: { fontSize: 12.5, fontWeight: '600', marginBottom: 2 },
  colRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5 },
  colText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17 },
  /* 对比表里「一行带子项」的容器（目前只有 AI 那一行）：标题 + 一行更小的注解 */
  colStack: { flex: 1, minWidth: 0 },
  colSub: { marginTop: 1, fontSize: 11, lineHeight: 15 },
  compareNote: { marginTop: Space.md, lineHeight: 19 },

  /* 三项详解 */
  features: { gap: Space.sm },
  feature: { padding: Space.lg },
  featureHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  featureIdx: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Palette.brandBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureIdxText: { fontSize: 11, lineHeight: 15, fontWeight: '600' },
  featureName: { fontSize: 15 },
  featureTagline: { marginTop: Space.xs, lineHeight: 20 },
  featureNote: { marginTop: Space.sm, lineHeight: 18 },

  sides: {
    marginTop: Space.md,
    paddingTop: Space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
    gap: 6,
  },
  side: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  sideKey: { width: 52, flexShrink: 0, fontSize: 11.5 },
  sideVal: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 18 },

  /* 色卡 */
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: Space.sm,
    marginTop: Space.md,
  },
  swatch: { width: '31%' },
  swatchChip: { height: 34, borderRadius: Radius.tag + 2 },
  swatchName: { marginTop: 5, fontSize: 11.5 },
  swatchLock: { fontSize: 10.5, marginTop: 1 },

  /* 已激活 */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.line3,
  },
  rowLast: { borderBottomWidth: 0 },
  rowKey: { width: 52, flexShrink: 0 },
  rowValue: { flex: 1, minWidth: 0 },
  checkMark: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Palette.sageBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tailNote: { marginTop: Space.md, lineHeight: 20 },
  tailLink: { marginTop: Space.md, paddingVertical: Space.xs },

  /* 底栏 */
  storeNote: { lineHeight: 20, textAlign: 'center' },
  secondary: { marginTop: Space.sm },
  later: { alignSelf: 'center', marginTop: Space.md, padding: Space.xs },
  foot: {
    paddingHorizontal: GUTTER,
    paddingTop: Space.md,
    paddingBottom: Space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
    backgroundColor: Palette.canvas,
  },
}));
