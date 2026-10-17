/**
 * 格物 · 生成财产清册（配置 + 生成 + 两个出口）
 *
 * 为什么是弹层而不是新页面：
 *   `(tabs)` 里的页面不压栈 —— 从「我的」push 到一个新页，安卓返回会落到第一格。
 *   这个流程是「进来选一下、办完回原页」，所以走 `SheetModal`，不 `router.push`。
 *   里面也没有输入框，不需要跟键盘抢空间。
 *
 * 为什么生成前先给一屏体检：
 *   一本册子印出来才发现「一半东西没记价格」，那才是真麻烦。
 *   这一屏在生成**之前**把件数、合计、缺口摆出来，用户可以先回去补价格。
 *
 * ★★★ 一次生成产出**两个文件**，界面上必须一眼看得出来。
 *   曾经的写法是入口标「PDF」、按钮写「生成 PDF」，生成完却把 PDF 和 HTML 一起给了，
 *   用户以为还有一个「HTML 版」没生成；真机又因为改名路径写错而「生成成功、发送失败」，
 *   屏幕上只剩一句 Java 异常。现在的规矩：
 *     ① 入口、按钮、结果三处说的必须是**同一件事**（两个文件）；
 *     ② 结果里把两个文件**分别列出来**，各带自己的大小与「发送」；
 *     ③ 任何失败只出现一句人话，且**贴着按钮那一栏**显示 —— 不再塞进滚动的正文里
 *        （正文滚上去以后报错就看不见了，人只会觉得「点了没反应」）。
 *
 * ★ 2026-10-18：付费墙从**入口**挪到了**生成这一下**。
 *   入口先拦的写法是「我刚点开，就被一张卖会员的纸糊住」，用户连这东西长什么样都没看见；
 *   现在是先让他看三种版式、看体检数字（件数与合计），点「生成清册」才校验并弹门控 ——
 *   他知道支持者档卖的是什么，掏钱的判断才有依据。
 *   ★ 校验写在 `runGenerate` 里，不写按钮的 onPress 上：所有生成出口（含以后的）都过这一处。
 */

import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import { listTrash } from '@/lib/db/items';
import {
  generateInventory,
  loadInventory,
  logFailure,
  shareInventoryHtml,
  shareInventoryPdf,
  type InventoryResult,
} from '@/lib/inventory/export';
import type { InventoryModel } from '@/lib/inventory/model';
import { buildDetailUnits, paginateDetails, totalPagesOf } from '@/lib/inventory/paginate';
import {
  INVENTORY_STYLE_ORDER,
  INVENTORY_STYLES,
  extraPageCount,
  pageMetrics,
  type InventoryStyleKey,
} from '@/lib/inventory/styles';
import { formatBytes, formatMoney } from '@/lib/format';
import { useAppState } from '@/lib/store/app-state';
import { useEntitlement } from '@/lib/store/entitlement';
import { makeStyles } from '@/lib/theme';
import { SheetModal } from '../ui/sheet-modal';
import { Body, Heading, Label, Meta } from '../ui/typography';
import { Divider } from '../ui/layout';

/** 样式缩略图里「纸」的颜色：刻意写死，因为它画的是纸，不是界面 */
const PAPER_TONE: Record<InventoryStyleKey, { bg: string; line: string; band?: string }> = {
  // theme-color-ok —— 这三行画的是「纸」，不是界面，所以不走 theme.ts
  dossier: { bg: '#FFFFFF', line: '#C9BEB0' }, // theme-color-ok
  ledger: { bg: '#FBF6EE', line: '#DCC9AE' }, // theme-color-ok
  binder: { bg: '#FFFFFF', line: '#C6CDD4', band: '#EDF1F5' }, // theme-color-ok
};

/** 失败发生在哪一步 —— 决定界面上「再点一下」指的是哪个按钮 */
type FailureStep = 'generate' | 'pdf' | 'html';

export interface InventorySheetProps {
  visible: boolean;
  onClose: () => void;
  /**
   * 未激活时点了「生成清册」→ 交给外层弹门控浮层。
   *
   * ★ 为什么由外层弹：门控浮层是个 `Modal`，这个弹层也是 `Modal`，
   *   安卓上两层叠着不可靠（第二个可能根本不出现，而且不报错）。
   *   外层收到这个回调会**先关掉本弹层、再弹门控**，与皮肤选择器被挡下时同一套做法。
   */
  onGate: () => void;
}

export function InventorySheet({ visible, onClose, onGate }: InventorySheetProps) {
  const styles = useStyles();
  const { entitled } = useEntitlement();
  const { dataVersion } = useAppState();
  const [styleKey, setStyleKey] = useState<InventoryStyleKey>('dossier');
  const [model, setModel] = useState<InventoryModel | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  const [busy, setBusy] = useState<null | FailureStep>(null);
  const [result, setResult] = useState<InventoryResult | null>(null);
  const [error, setError] = useState<null | { text: string; step: FailureStep }>(null);

  /* 载入中 = 还没拿到过数据。刻意**不写** `setLoading(true)`：
     在 effect 里同步 setState 会触发级联渲染（react-hooks 直接报错），
     而这件事本来就能从状态派生出来。
     重开弹层时沿用上一次的 model（先显示旧数字，再被新结果替换）——
     比每次开都白一屏要稳。 */
  const loading = visible && model === null && error === null;

  /* 每次打开都重取：这一页可能是在用户补了几件东西之后打开的。
     数据变了（dataVersion）也要重取，否则体检行里的件数是旧的。 */
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void (async () => {
      try {
        const [next, trash] = await Promise.all([loadInventory(), listTrash()]);
        if (!alive) return;
        setModel(next);
        setTrashCount(trash.length);
      } catch (err: unknown) {
        logFailure('取数', err);
        if (alive) {
          setError({ text: '没能读出物品清单。稍后再打开一次。', step: 'generate' });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible, dataVersion]);

  /* 预计页数：只跑分页，不生成 HTML —— 弹层里每点一次样式就重渲整本册子太浪费 */
  const pages = useMemo(() => {
    if (!model || model.totals.count === 0) return 0;
    const style = INVENTORY_STYLES[styleKey];
    const metrics = pageMetrics(style);
    const detail = paginateDetails(buildDetailUnits(model), metrics.rowsPerPage).length;
    return totalPagesOf(detail, extraPageCount(style));
  }, [model, styleKey]);

  const empty = model != null && model.totals.count === 0;
  const blocked = loading || model == null || empty || busy != null;

  /* 生成失败 → error 里留下 step='generate'，下面那颗按钮本身就是重试入口；
     发送失败 → 两个文件还在，再点同一个「发送」即可。所以不需要单独的「重试」按钮，
     只要求报错**一直在视野里**。 */
  const runGenerate = async () => {
    if (!model || blocked) return;
    /* ★★ 付费墙在这里，不在入口：拦早了对方连版式和体检数字都没看见。
       校验放在本函数而不是按钮的 onPress 上 —— 以后再加生成出口也不会漏。 */
    if (!entitled) {
      onGate();
      return;
    }
    setBusy('generate');
    setError(null);
    try {
      setResult(await generateInventory(model, styleKey));
    } catch (err) {
      logFailure('生成', err);
      setError({ text: messageOf(err, '生成失败。稍后再试一次。'), step: 'generate' });
    } finally {
      setBusy(null);
    }
  };

  const runSharePdf = async () => {
    if (!result || busy) return;
    setBusy('pdf');
    setError(null);
    try {
      await shareInventoryPdf(result);
    } catch (err) {
      logFailure('发送 PDF', err);
      setError({ text: messageOf(err, '没能把 PDF 交出去。'), step: 'pdf' });
    } finally {
      setBusy(null);
    }
  };

  const runShareHtml = async () => {
    if (!result || busy) return;
    setBusy('html');
    setError(null);
    try {
      await shareInventoryHtml(result);
    } catch (err) {
      logFailure('发送 HTML', err);
      setError({ text: messageOf(err, '没能把 HTML 交出去。'), step: 'html' });
    } finally {
      setBusy(null);
    }
  };

  /* 换了样式，上一次的结果就不作数了。
     不清的话：卡片点了没反应，底下还摆着旧版式的「已生成」和两个发送按钮 ——
     用户会以为新样式也生成好了。 */
  const pickStyle = (key: InventoryStyleKey) => {
    if (key === styleKey) return;
    setStyleKey(key);
    setResult(null);
    setError(null);
  };

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Heading>家庭财产清册</Heading>
          <Meta tone="ink3">选一种版式。同一份数据，最终给到 PDF 与 HTML 两个文件。</Meta>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭"
          onPress={() => {
            // 结果在**关闭时**清掉，不在打开时清：打开时清会触发 effect 里的级联渲染
            setResult(null);
            setError(null);
            onClose();
          }}
          hitSlop={10}>
          <Ionicons name="close" size={20} color={Palette.ink3} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {INVENTORY_STYLE_ORDER.map((key, index) => {
          const style = INVENTORY_STYLES[key];
          const active = key === styleKey;
          return (
            <View key={key}>
              {index > 0 ? <Divider /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${style.name}：${style.tagline}`}
                onPress={() => pickStyle(key)}
                android_ripple={{ color: Palette.ripple }}
                style={[styles.styleRow, active && styles.styleRowActive]}>
                <StyleThumb kind={key} active={active} />
                <View style={styles.styleText}>
                  <Body style={active && styles.styleNameActive}>{style.name}</Body>
                  <Meta tone="ink3">{style.tagline}</Meta>
                </View>
                {active ? <Ionicons name="checkmark" size={18} color={Palette.brand} /> : null}
              </Pressable>
            </View>
          );
        })}

        <View style={styles.audit}>
          {loading || model == null ? (
            <Meta tone="ink3">正在数一遍库里的东西…</Meta>
          ) : empty ? (
            <Meta tone="ink3">还没有物品。先录几件，再来生成清册。</Meta>
          ) : (
            <>
              <Body style={styles.auditMain}>
                {`${model.totals.count} 件 · 购置价合计 ${formatMoney(model.totals.value)}`}
              </Body>
              {model.totals.unpriced > 0 ? (
                <Meta color={Palette.amber} style={styles.auditWarn}>
                  {`${model.totals.pricedCount} 件记了价格，另 ${model.totals.unpriced} 件未记，不进合计`}
                </Meta>
              ) : (
                <Meta tone="ink3">{`${model.totals.pricedCount} 件全部记了价格`}</Meta>
              )}
              <Meta tone="ink3" style={styles.auditFoot}>
                {trashCount > 0
                  ? `金额是购置价，不是现值。回收站 ${trashCount} 件不计入。`
                  : '金额是购置价，不是现值，也不替代保险公司的核定。'}
              </Meta>
            </>
          )}
        </View>
      </ScrollView>

      <View style={styles.foot}>
        {/* ★ 报错固定贴在这一栏最上面：正文滚上去以后，报错看不见就等于没报 */}
        {error ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle" size={16} color={Palette.clay} />
            <Body color={Palette.clay} style={styles.errText}>
              {error.text}
            </Body>
          </View>
        ) : null}

        {result ? (
          <>
            <View style={styles.doneRow}>
              <Ionicons name="checkmark-circle" size={18} color={Palette.brand} />
              <Body style={styles.doneText}>
                {`已生成 · ${result.pages} 页 · ${clock(result.generatedAt)}`}
              </Body>
            </View>

            <View style={styles.fileList}>
              <FileLine
                tag="PDF"
                desc={`定版 · ${formatBytes(result.bytes)}`}
                hint="发给谁都长一个样"
                busy={busy === 'pdf'}
                disabled={busy != null}
                onSend={runSharePdf}
              />
              <Divider />
              <FileLine
                tag="HTML"
                desc={`原稿 · ${formatBytes(result.htmlBytes)}`}
                hint="可在电脑浏览器里重新打印"
                busy={busy === 'html'}
                disabled={busy != null}
                onSend={runShareHtml}
              />
            </View>

            <Meta tone="ink3" style={styles.hint}>
              两个文件内容一样。打印时选 A4、页边距「无」，页数才对得上。
            </Meta>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="重新生成一份"
              onPress={() => {
                setResult(null);
                setError(null);
              }}
              hitSlop={8}>
              <Meta tone="ink3" style={styles.again}>
                重新生成一份
              </Meta>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                empty ? '还没有物品，无法生成' : `生成清册，预计 ${pages} 页，同时产出 PDF 与 HTML`
              }
              accessibilityState={{ disabled: blocked }}
              onPress={blocked ? undefined : runGenerate}
              android_ripple={{ color: Palette.rippleOnAccent }}
              style={({ pressed }) => [
                styles.btnPrimary,
                styles.btnFull,
                pressed && styles.btnPressed,
                blocked && styles.btnDisabled,
              ]}>
              <Label color={blocked ? Palette.ink4 : Palette.onAccent}>
                {busy === 'generate'
                  ? '正在排版…'
                  : loading || model == null
                    ? '正在数一遍…'
                    : empty
                      ? '还没有物品'
                      : `生成清册 · 预计 ${pages} 页`}
              </Label>
            </Pressable>
            <Meta tone="ink3" style={styles.hint}>
              一次生成两个文件：PDF 定版，HTML 是原稿。
            </Meta>
          </>
        )}
      </View>
    </SheetModal>
  );
}

/** 一行「产出的文件」：格式、大小、用途、发送。比两颗并排的按钮更能说明「这是两个文件」 */
function FileLine({
  tag,
  desc,
  hint,
  busy,
  disabled,
  onSend,
}: {
  tag: string;
  desc: string;
  hint: string;
  busy: boolean;
  disabled: boolean;
  onSend: () => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.fileRow}>
      <View style={styles.fileTag}>
        <Meta color={Palette.brandDeep} style={styles.fileTagText}>
          {tag}
        </Meta>
      </View>
      <View style={styles.fileText}>
        <Body style={styles.fileTitle}>{desc}</Body>
        <Meta tone="ink3">{hint}</Meta>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`发送 ${tag}`}
        accessibilityState={{ disabled }}
        onPress={disabled ? undefined : onSend}
        android_ripple={{ color: Palette.rippleOnAccent }}
        style={({ pressed }) => [
          styles.sendBtn,
          pressed && styles.btnPressed,
          disabled && !busy && styles.sendBtnDisabled,
          busy && styles.btnBusy,
        ]}>
        <Label color={disabled && !busy ? Palette.ink4 : Palette.onAccent}>
          {busy ? '打开中…' : '发送'}
        </Label>
      </Pressable>
    </View>
  );
}

/** 一枚「纸」的缩略图：画的不是界面，是打印出来会长的样子 */
function StyleThumb({ kind, active }: { kind: InventoryStyleKey; active: boolean }) {
  const styles = useStyles();
  const tone = PAPER_TONE[kind];
  const lines = kind === 'ledger' ? [1, 0, 0, 1, 0, 0] : [1, 0, 0, 0, 0, 0];
  return (
    <View
      style={[
        styles.thumb,
        { backgroundColor: tone.bg, borderColor: active ? Palette.brand : Palette.line },
      ]}>
      {kind === 'binder' ? (
        <View style={[styles.thumbBand, { backgroundColor: tone.band ?? tone.line }]} />
      ) : null}
      {lines.map((strong, i) => (
        <View
          key={i}
          style={[
            styles.thumbLine,
            {
              backgroundColor: tone.line,
              width: i === 1 ? '64%' : '100%',
              height: strong ? 2 : 1,
            },
          ]}
        />
      ))}
    </View>
  );
}

/** 失败一律是 `InventoryFailure`，`message` 已经是一句人话；兜底只防「根本不是 Error」 */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function clock(at: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${p(at.getHours())}:${p(at.getMinutes())}`;
}

const useStyles = makeStyles((palette) => ({
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Space.md,
    paddingHorizontal: GUTTER,
    paddingTop: Space.lg,
    paddingBottom: Space.md,
  },
  headText: { gap: 2, flex: 1 },
  body: { paddingHorizontal: GUTTER, paddingBottom: Space.md },
  styleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingVertical: Space.sm,
    paddingHorizontal: Space.xs,
    borderRadius: Radius.card,
  },
  styleRowActive: { backgroundColor: palette.brandBg },
  styleText: { flex: 1, gap: 1 },
  styleNameActive: { color: palette.brandDeep, fontWeight: '600' },
  thumb: {
    width: 34,
    height: 46,
    borderRadius: 2,
    borderWidth: 1,
    padding: 4,
    gap: 3,
    overflow: 'hidden',
  },
  thumbBand: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 7 },
  thumbLine: { borderRadius: 1 },
  audit: {
    marginTop: Space.md,
    padding: Space.md,
    borderRadius: Radius.card,
    backgroundColor: palette.inset,
    gap: 3,
  },
  auditMain: { fontWeight: '600' },
  auditWarn: { color: palette.amber },
  auditFoot: { marginTop: 2 },
  foot: {
    paddingHorizontal: GUTTER,
    paddingTop: Space.sm,
    borderTopWidth: 1,
    borderTopColor: palette.line3,
    gap: Space.sm,
  },
  errBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.xs,
    padding: Space.sm,
    borderRadius: Radius.card,
    backgroundColor: palette.inset,
  },
  errText: { flex: 1, lineHeight: 19 },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  doneText: { fontWeight: '600' },
  fileList: {
    borderWidth: 1,
    borderColor: palette.line3,
    borderRadius: Radius.card,
    overflow: 'hidden',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingVertical: Space.sm,
    paddingHorizontal: Space.sm,
  },
  fileTag: {
    minWidth: 38,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 3,
    paddingHorizontal: 5,
    borderRadius: 4,
    backgroundColor: palette.brandBg,
  },
  fileTagText: { fontWeight: '600', letterSpacing: 0.4 },
  fileText: { flex: 1, gap: 1 },
  fileTitle: { fontWeight: '600' },
  sendBtn: {
    minWidth: 58,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.brand,
    borderRadius: Radius.card,
    paddingVertical: 7,
    paddingHorizontal: Space.sm,
  },
  sendBtnDisabled: { backgroundColor: palette.line2 },
  hint: { lineHeight: 16 },
  btnPrimary: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.brand,
    borderRadius: Radius.card,
    paddingVertical: Space.md,
  },
  btnFull: { flex: 0 },
  btnPressed: { opacity: 0.86 },
  btnBusy: { opacity: 0.7 },
  btnDisabled: { backgroundColor: palette.line2 },
  again: { textAlign: 'center', paddingTop: 2 },
}));
