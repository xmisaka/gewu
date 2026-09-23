/**
 * 格物 · 封面查找
 *
 * 解决的问题：录入时给物品配图要靠拍照或自己上网找，这一步的摩擦比填表还大，
 * 结果是大多数物品最后都是首字方块。这里提供一个「搜一张示意封面」的出口。
 *
 * 三条设计原则：
 *   1. **手动触发**。不静默联网补图 —— 用户没要求就不该发请求，
 *      而且自动配错图比没有图更让人困惑。
 *   2. **示意而非实物**。搜「充电宝」给一张充电宝的通用商品图就够了，
 *      不追求同款同色，否则命中率会低到不可用。
 *   3. **选中即走同一条图片管道**。候选项下载后交给 ItemForm 交给 ingestMany，
 *      压缩、缩略图、落沙盒、进备份包全部自动复用，不需要任何特判。
 *
 * 搜索词策略是分层降级：名称直译 → 分类兜底词 → 名称原文。
 * 逐层退让而不是一次定死，是因为用户起的名字五花八门，任何单一策略都会漏。
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';

import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import {
  categoryFallbackQuery,
  hasApiKey,
  searchCovers,
  StockError,
  translateQuery,
  type CoverCandidate,
} from '@/lib/photos/stock';
import { Button } from '../ui/controls';
import { Heading, Meta } from '../ui/typography';
import { StockKeyModal } from './StockKeyModal';
import { makeStyles } from '@/lib/theme';

export interface CoverPickerModalProps {
  visible: boolean;
  /** 物品名称，作为默认检索词 */
  itemName: string;
  /** 物品分类名，词表命中不了时用它兜底 */
  categoryName: string | null;
  onClose: () => void;
  /** 用户选定了某张图；确认后才开始下载 */
  onConfirm: (candidate: CoverCandidate) => Promise<void>;
}

/** 一屏能看全的候选数；再多用户也不会翻 */
const PER_PAGE = 12;

export function CoverPickerModal({
  visible,
  itemName,
  categoryName,
  onClose,
  onConfirm,
}: CoverPickerModalProps) {
  const styles = useStyles();
  const [keyword, setKeyword] = useState('');
  const [candidates, setCandidates] = useState<CoverCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 是否退到了分类兜底词，用于给用户一句解释 */
  const [usedFallback, setUsedFallback] = useState(false);
  /**
   * Key 状态单独存一份 state 而不是每次 render 调 hasApiKey()。
   * 因为运行时 Key 是模块级变量，从设置面板里存完不会触发本组件重渲染 ——
   * 存成 state 才能让「去配置」的引导在保存后真的消失。
   */
  const [keyReady, setKeyReady] = useState(hasApiKey());
  const [keyOpen, setKeyOpen] = useState(false);

  /** 请求序号：翻页/改词时旧响应必须作废，否则会覆盖新结果 */
  const seqRef = useRef(0);

  const translation = useMemo(() => translateQuery(itemName), [itemName]);
  const fallback = useMemo(() => categoryFallbackQuery(categoryName), [categoryName]);

  const runSearch = useCallback(
    async (raw: string, opts?: { preferFallback?: boolean }) => {
      const q = raw.trim();
      if (!hasApiKey()) {
        setKeyReady(false);
        setError(null);
        setCandidates([]);
        return;
      }
      if (!q) {
        setCandidates([]);
        setError(null);
        return;
      }

      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      setUsedFallback(!!opts?.preferFallback);

      try {
        let list = await searchCovers(q, { perPage: PER_PAGE });

        // 直译命中不了就退一层：用分类的通用词再搜一次
        if (list.length === 0 && opts?.preferFallback === false && fallback && fallback !== q) {
          list = await searchCovers(fallback, { perPage: PER_PAGE });
          if (seq === seqRef.current) setUsedFallback(list.length > 0);
        }

        if (seq !== seqRef.current) return;
        setCandidates(list);
        if (list.length === 0) setError('没搜到合适的图，换个词试试');
      } catch (err) {
        if (seq !== seqRef.current) return;
        setCandidates([]);
        setError(
          err instanceof StockError
            ? err.message
            : err instanceof Error
              ? err.message
              : '搜索失败，稍后重试',
        );
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [fallback],
  );

  // 每次打开重置：优先用名称直译，没有就先用原名，失败会自动退到分类词
  useEffect(() => {
    if (!visible) return;
      const ready = hasApiKey();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹层每次打开把内部草稿拉回初始值，是本组件刻意的生命周期
      setKeyReady(ready);
    setPicking(null);
    const initial = translation ?? itemName.trim();
    setKeyword(initial);
    if (!ready) {
      // Key 没配就别发请求了，界面会给出就地配置的入口
      setCandidates([]);
      setError(null);
      return;
    }
    void runSearch(initial, { preferFallback: false });
  }, [visible, translation, itemName, runSearch]);

  // 外层关掉时，内层的 Key 面板也要跟着收起来 —— 否则下次再打开「找封面」，
  // 会先看到一个上一次没关掉的设置弹窗浮在上面
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 同步内层面板的开合，不是可推导的状态
    if (!visible) setKeyOpen(false);
  }, [visible]);

  const confirm = async (candidate: CoverCandidate) => {
    if (picking != null) return;
    setPicking(candidate.id);
    try {
      await onConfirm(candidate);
    } finally {
      setPicking(null);
    }
  };

  return (
    <>
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={onClose}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.head}>
            <Heading>找一张封面</Heading>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
              onPress={onClose}
              hitSlop={10}>
              <Ionicons name="close" size={20} color={Palette.ink3} />
            </Pressable>
          </View>

          <Meta tone="ink4" style={styles.intro}>
            给「{itemName || '这件物品'}」配一张示意图，不必是同款
          </Meta>

          {/* 搜索栏：允许用户自己改词，改完按回车重搜。
              没配 Key 时藏起来 —— 一个搜了没反应的输入框只会让人以为是坏了 */}
          {keyReady ? (
            <View style={styles.search}>
              <Ionicons name="search" size={15} color={Palette.ink3} />
              <TextInput
                value={keyword}
                onChangeText={setKeyword}
                onSubmitEditing={() => void runSearch(keyword)}
                placeholder="输入关键词，如 headphones"
                placeholderTextColor={Palette.ink4}
                style={styles.searchInput}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
                allowFontScaling={false}
              />
              {loading ? (
                <ActivityIndicator size="small" color={Palette.brand} />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="搜索"
                  hitSlop={8}
                  onPress={() => void runSearch(keyword)}>
                  <Ionicons name="arrow-forward-circle" size={19} color={Palette.brand} />
                </Pressable>
              )}
            </View>
          ) : null}

          {usedFallback && categoryName ? (
            <Meta tone="ink4" style={styles.note}>
              没搜到这个名称，改用「{categoryName}」的通用图
            </Meta>
          ) : null}

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.grid}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            {!keyReady ? (
              <View style={styles.state}>
                <Ionicons name="key-outline" size={26} color={Palette.ink4} />
                <Meta tone="ink3" style={styles.stateText}>
                  自动找封面用的是 Pexels 免费图库，需要一个 API Key 才能搜图。
                </Meta>
                <Button
                  label="填 API Key"
                  tone="secondary"
                  block={false}
                  icon="settings-outline"
                  onPress={() => setKeyOpen(true)}
                />
              </View>
            ) : loading && candidates.length === 0 ? (
              <View style={styles.state}>
                <ActivityIndicator color={Palette.brand} />
                <Meta tone="ink3" style={styles.stateText}>
                  正在找图…
                </Meta>
              </View>
            ) : error ? (
              <View style={styles.state}>
                <Ionicons name="cloud-offline-outline" size={26} color={Palette.ink4} />
                <Meta tone="ink3" style={styles.stateText}>
                  {error}
                </Meta>
              </View>
            ) : (
              candidates.map((c) => (
                <CoverTile
                  key={c.id}
                  candidate={c}
                  busy={picking === c.id}
                  disabled={picking != null}
                  onPress={() => void confirm(c)}
                />
              ))
            )}
          </ScrollView>

          <View style={styles.foot}>
            <Meta tone="ink4" style={styles.footNote}>
              图片来自 Pexels，免费商用
            </Meta>
            <Button label="取消" tone="ghost" block={false} onPress={onClose} />
          </View>
        </View>
      </Modal>

      {/* 就地补 Key，不用退出去翻设置页 —— 用户此刻的意图就是「我要一张封面」，
         把他推去另一个 Tab 再让他自己找回来，这一步流失得毫无必要 */}
      <StockKeyModal
        visible={keyOpen}
        onClose={() => setKeyOpen(false)}
        onSaved={() => {
          const ready = hasApiKey();
          setKeyReady(ready);
          if (ready) void runSearch(keyword, { preferFallback: false });
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------ 候选图 */

function CoverTile({
  candidate,
  busy,
  disabled,
  onPress,
}: {
  candidate: CoverCandidate;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`选择这张封面，摄影 ${candidate.photographer}`}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={styles.tile}>
      <Image
        source={{ uri: candidate.thumbUri }}
        style={styles.tileImage}
        contentFit="cover"
        transition={140}
        cachePolicy="memory-disk"
      />
      {busy ? (
        <View style={styles.tileBusy}>
          <ActivityIndicator size="small" color={Palette.pure} />
        </View>
      ) : null}
    </Pressable>
  );
}

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
    paddingBottom: Space.xs,
  },
  intro: { paddingHorizontal: GUTTER, paddingBottom: Space.md },
  note: { paddingHorizontal: GUTTER, paddingTop: Space.sm },

  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    height: 38,
    marginHorizontal: GUTTER,
    paddingHorizontal: Space.md,
    backgroundColor: Palette.inset,
    borderRadius: Radius.input,
  },
  searchInput: {
    flex: 1,
    padding: 0,
    ...(Type.body as object),
    fontSize: 14,
    color: Palette.ink,
  },

  body: { marginTop: Space.md },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.sm,
    paddingHorizontal: GUTTER,
    paddingBottom: Space.lg,
  },
  tile: {
    // 三列：减去左右边距与两个间隙后三等分
    width: `${(100 - 6) / 3}%`,
    aspectRatio: 1,
    borderRadius: Radius.input,
    overflow: 'hidden',
    backgroundColor: Palette.inset,
  },
  tileImage: { width: '100%', height: '100%' },
  tileBusy: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Palette.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },

  state: { width: '100%', alignItems: 'center', paddingVertical: Space.xxxl, gap: Space.md },
  stateText: { textAlign: 'center', lineHeight: 21, paddingHorizontal: Space.lg },

  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingTop: Space.md,
  },
  footNote: { fontSize: 12, flex: 1 },
}));
