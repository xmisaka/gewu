/**
 * 格物 · 做成海报
 *
 * 一个页面，两种产出：进来就是一张已经渲染好的默认模板，横滑换皮、点题语就地改，
 * 右上没有「下一步」—— 只有一个「分享」。
 *
 * ── 为什么不是「先选模板 → 再预览」两步 ───────────────────────
 *   ① 多一步就会少一半人。分享是冲动动作，「先选再做」会把这股劲消耗掉。
 *   ② 模板名对用户是无意义的词，必须看到自己的东西排在里面的样子才有判断。
 *   ③ 实时切换才有比较的快感，这件事本身就是情绪价值的一部分。
 *
 * ── 所见即所发 ───────────────────────────────────────────────
 * 抓图的对象就是屏幕上这个 View（`shotRef`），不做后台静默生成。
 * 技术上它必须挂在树上才能抓；产品上它天然构成「你看到的就是对方看到的」——
 * 隐私上没有比这更便宜的保证。
 *
 * ★★ ref 挂在**没有 transform 的那一层**上。缩放放在外层 wrapper：
 *   view-shot 抓的是 view 的布局尺寸，父级的 scale 不该进画面，
 *   但把 scale 写在同一个 view 上会让不同 ROM 的合成结果不一致。
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Poster } from '@/components/share/Poster';
import { Button, Chip, IconButton } from '@/components/ui/controls';
import { SheetModal } from '@/components/ui/sheet-modal';
import { Screen } from '@/components/ui/layout';
import { Body, Label, Meta, Title } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import { capturePoster, sharePosterFile } from '@/lib/share/capture';
import { loadPosterModel, type PosterSource } from '@/lib/share/load';
import { POSTER_SIZE, photoCountOf, type PosterModel } from '@/lib/share/model';
import { QUOTE_GROUPS, quotesOf } from '@/lib/share/quotes';
import { skinOf, skinsFor, type PosterSkinKey } from '@/lib/share/templates';
import { makeStyles } from '@/lib/theme';

/** 题语输入上限。海报上只有两行位置，再长就会被裁 */
const QUOTE_MAX = 22;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function PosterScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { ids, mode } = useLocalSearchParams<{ ids?: string; mode?: string }>();

  const source: PosterSource = useMemo(() => {
    if (mode === 'stat') return { kind: 'stat' };
    const list = typeof ids === 'string' ? ids.split(',').filter(Boolean) : [];
    return { kind: 'ids', ids: list };
  }, [ids, mode]);

  const [model, setModel] = useState<PosterModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skinKey, setSkinKey] = useState<PosterSkinKey>('sujian');
  /**
   * 题语有两个状态：`touched=false` 时跟着模型给的默认句走，
   * `touched=true` 时用用户自己那份（可以是空串 —— 空就是不显示）。
   * ★ 不能只用 `quote || model.quote` 兜底：那样「清空」会被默认句悄悄填回去，
   *   用户按了「就这样」，海报上还挂着一句话。
   */
  const [quote, setQuote] = useState('');
  const [quoteTouched, setQuoteTouched] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  const shotRef = useRef<View>(null);
  /** 已经报到的照片数。切换模板会重挂图片，所以要跟着 skinKey 归零 */
  const settledRef = useRef(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const built = await loadPosterModel(source);
        if (!alive) return;
        setModel(built);
        setQuote(built.quote);
        setQuoteTouched(false);
        // 默认取第一套「这个内容能用的」模板：素笺不需要照片，永远排在最前
        setSkinKey(skinsFor(built.kind, !!built.photoThumb)[0].key);
      } catch {
        if (alive) setError('这些物品没读到，返回再试一次。');
      }
    })();
    return () => {
      alive = false;
    };
  }, [source]);

  /* 换模板会重挂照片（有的模板不显示照片），计数要跟着归零。
     ★ 必须和 setSkinKey 在同一次事件里做：放在 useEffect 里会晚一帧，
       照片可能先 loadEnd 再归零，于是「等待」永远等不到，抓出一张空框。 */
  const chooseSkin = useCallback((key: PosterSkinKey) => {
    settledRef.current = 0;
    setSkinKey(key);
  }, []);

  const skin = skinOf(skinKey);
  const available = useMemo(
    () => (model ? skinsFor(model.kind, !!model.photoThumb) : []),
    [model],
  );

  /* 舞台按可用空间等比缩放。缩放放在 wrapper 上，ref 那一层保持 360 × 450 原样 */
  const scale = useMemo(() => {
    if (stage.width <= 0 || stage.height <= 0) return 0;
    return Math.min(
      (stage.width - Space.lg) / POSTER_SIZE.width,
      (stage.height - Space.lg) / POSTER_SIZE.height,
    );
  }, [stage]);

  const onPhotoSettled = useCallback(() => {
    settledRef.current += 1;
  }, []);

  const onShare = useCallback(async () => {
    if (!model || busy || !shotRef.current) return;
    setBusy(true);
    try {
      /* 照片是异步加载的。抓图早于图到位，发出去就是一张空框海报 ——
         最多等 1.2 秒；仍没到位也照抓，那种情况照片位是首字块，不是破图。 */
      const need = photoCountOf(model);
      for (let i = 0; i < 12 && settledRef.current < need; i += 1) await sleep(100);

      const uri = await capturePoster(shotRef);
      const ok = await sharePosterFile(uri);
      if (!ok) Alert.alert('这台设备没有分享面板', '图已经生成好了，可以先截图留存。');
    } catch {
      Alert.alert('这张图没生成出来', '再点一次试试。');
    } finally {
      setBusy(false);
    }
  }, [model, busy]);

  const openQuote = useCallback(() => {
    setDraft(quoteTouched ? quote : (model?.quote ?? ''));
    setQuoteOpen(true);
  }, [quote, quoteTouched, model]);

  const applyQuote = useCallback(() => {
    setQuote(draft.trim().slice(0, QUOTE_MAX));
    setQuoteTouched(true);
    setQuoteOpen(false);
  }, [draft]);

  const shownQuote = quoteTouched ? quote : (model?.quote ?? '');
  const renderModel: PosterModel | null = model ? { ...model, quote: shownQuote } : null;

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
        <Title style={styles.topTitle}>做成海报</Title>
      </View>

      {error ? (
        <View style={styles.center}>
          <Body tone="ink3">{error}</Body>
          <View style={styles.errorBtn}>
            <Button label="返回" tone="secondary" block={false} onPress={() => router.back()} />
          </View>
        </View>
      ) : !renderModel ? (
        <View style={styles.center}>
          <ActivityIndicator color={Palette.brand} />
        </View>
      ) : (
        <>
          <View
            style={styles.stage}
            onLayout={(e) => setStage({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
            {scale > 0 ? (
              <View
                style={{
                  width: POSTER_SIZE.width * scale,
                  height: POSTER_SIZE.height * scale,
                }}>
                <View style={{ transform: [{ scale }], transformOrigin: 'top left' }}>
                  <View
                    ref={shotRef}
                    collapsable={false}
                    style={{ width: POSTER_SIZE.width, height: POSTER_SIZE.height }}>
                    <Poster model={renderModel} skin={skin} onPhotoSettled={onPhotoSettled} />
                  </View>
                </View>
              </View>
            ) : null}
          </View>

          <Meta tone="ink4" style={styles.tip}>
            下面是模板，点题语可以改
          </Meta>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.strip}>
            {available.map((s) => {
              const active = s.key === skinKey;
              return (
                <Pressable
                  key={s.key}
                  accessibilityRole="button"
                  accessibilityLabel={`模板 ${s.name}`}
                  accessibilityState={{ selected: active }}
                  onPress={() => chooseSkin(s.key)}
                  style={styles.tItem}>
                  <View
                    style={[
                      styles.tSwatch,
                      { backgroundColor: s.paper, borderColor: active ? Palette.brand : Palette.line },
                    ]}>
                    <View style={[styles.tLine, { backgroundColor: s.ink }]} />
                    <View style={[styles.tBlock, { backgroundColor: s.accent }]} />
                  </View>
                  <Meta tone={active ? 'brand' : 'ink3'} style={styles.tName}>
                    {s.name}
                  </Meta>
                </Pressable>
              );
            })}
          </ScrollView>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="改题语"
            onPress={openQuote}
            style={styles.quoteRow}>
            <Label tone="ink4">题语</Label>
            <Body tone="ink" numberOfLines={1} style={styles.quoteText}>
              {shownQuote || '无题语'}
            </Body>
            <Meta tone="brand">改</Meta>
          </Pressable>

          <View style={styles.footer}>
            <Button
              label="分享这张海报"
              icon="share-outline"
              onPress={() => void onShare()}
              loading={busy}
            />
          </View>
        </>
      )}

      <SheetModal visible={quoteOpen} onClose={() => setQuoteOpen(false)}>
        <View style={styles.panel}>
          <Title style={styles.panelTitle}>换一句</Title>
          <Meta tone="ink3" style={styles.panelHint}>
            留空就不显示。海报上只有两行位置。
          </Meta>

          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="写一句自己的"
            placeholderTextColor={Palette.ink4}
            maxLength={QUOTE_MAX}
            multiline
            style={styles.input}
          />

          <ScrollView style={styles.panelScroll} keyboardShouldPersistTaps="handled">
            {QUOTE_GROUPS.map((group) => (
              <View key={group} style={styles.group}>
                <Label tone="ink4" style={styles.groupLabel}>
                  {group}
                </Label>
                <View style={styles.chips}>
                  {quotesOf(group).map((q) => (
                    <Chip
                      key={q.text}
                      label={q.text}
                      selected={draft === q.text}
                      onPress={() => setDraft(q.text)}
                    />
                  ))}
                </View>
              </View>
            ))}
          </ScrollView>

          <View style={styles.panelFoot}>
            <Button label="就这样" onPress={applyQuote} />
          </View>
        </View>
      </SheetModal>
    </Screen>
  );
}

const useStyles = makeStyles((Palette) => ({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: GUTTER - Space.sm,
    paddingVertical: Space.sm,
    gap: Space.xs,
  },
  topTitle: { fontSize: 17, letterSpacing: 0.5 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.md },
  errorBtn: { marginTop: Space.sm },

  /* 舞台：底色比画布深一档，让纸边看得出来 */
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.inset,
    marginHorizontal: GUTTER,
    borderRadius: Radius.card,
    overflow: 'hidden',
  },
  tip: { fontSize: 11, textAlign: 'center', paddingTop: Space.sm },

  strip: { gap: Space.md, paddingHorizontal: GUTTER, paddingTop: Space.sm, paddingBottom: Space.xs },
  tItem: { alignItems: 'center', gap: 5 },
  tSwatch: {
    width: 44,
    height: 56,
    borderRadius: 5,
    borderWidth: 1.5,
    padding: 6,
    justifyContent: 'flex-end',
    gap: 4,
  },
  tLine: { height: 2, width: '55%', borderRadius: 1 },
  tBlock: { height: 10, width: '72%', borderRadius: 1.5, opacity: 0.85 },
  tName: { fontSize: 10.5 },

  quoteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    marginHorizontal: GUTTER,
    marginTop: Space.sm,
    paddingVertical: Space.sm,
    paddingHorizontal: Space.md,
    borderRadius: Radius.card,
    backgroundColor: Palette.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line,
  },
  quoteText: { flex: 1, fontSize: 13 },

  footer: { paddingHorizontal: GUTTER, paddingTop: Space.sm, paddingBottom: Space.lg },

  panel: { paddingHorizontal: GUTTER, paddingTop: Space.md },
  panelTitle: { fontSize: 18 },
  panelHint: { marginTop: 4, fontSize: 12 },
  input: {
    marginTop: Space.md,
    minHeight: 64,
    borderRadius: Radius.card,
    backgroundColor: Palette.inset,
    paddingHorizontal: Space.md,
    paddingTop: Space.sm,
    paddingBottom: Space.sm,
    color: Palette.ink,
    fontSize: 14,
    lineHeight: 22,
  },
  panelScroll: { marginTop: Space.md, maxHeight: 260 },
  group: { marginBottom: Space.md },
  groupLabel: { letterSpacing: 1.2, marginBottom: Space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  panelFoot: { paddingTop: Space.sm, paddingBottom: Space.sm },
}));
