/**
 * 格物 · 标签选择器
 *
 * 「标签不是一等实体」的落地形态：候选列表是**算出来的** —— 把库里所有物品的
 * tags 拆开、去重、计数、按频次排（见 lib/tags.ts），没有任何标签表。选完写回调用方，
 * 由调用方决定这份结果是落到「这件物品的标签」还是「列表的筛选条件」上。
 *
 * ── 三个必须守住的点 ─────────────────────────────────────────
 *
 * ★ 外壳走 `SheetModal`，不自己写 `Modal`：Android 上 `Modal` 是一个**独立的
 *   Dialog 窗口**，不继承 Activity 的 `adjustResize` —— 自己写的话搜索框会被
 *   键盘整个盖住（页面里的输入框却没事，所以很难联想到）。
 *
 * ★ **长按给「改名 / 合并 / 删除」不是锦上添花**。纯聚合会把用户的错别字原样
 *   固化成候选（「办公」和「办公用品」并排出现），还按频次排 —— 等于天天提醒他
 *   打错了却不给改的地方。合并就是「改名到一个已经存在的标签」，不是第二套代码。
 *
 * ★ 删除走**两步内联确认**，不用 `Alert`：`Alert` 在 Modal 之上是否可见随 ROM 而异，
 *   万一不显示就是「点了没反应」—— 这恰好是本项目最怕的那类静默失败。
 */

import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/controls';
import { SheetModal } from '@/components/ui/sheet-modal';
import { Body, Heading, Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import { filterTags, normalizeTag, tagKey, type TagCount, type TagTransform } from '@/lib/tags';
import { makeStyles } from '@/lib/theme';

export interface TagPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 全部候选，已按频次降序（来自 useTagLibrary） */
  tags: TagCount[];
  /** 当前已选（受控） */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /**
   * 全局改写：改名 / 合并 / 删除，跨全部物品生效。
   *
   * ★ 调用方**必须**同时把本地那份已选也过一次 `applyTagTransform` ——
   *   库里改了、界面上还留着旧名字，是最典型的两边各写一遍的后果。
   *   不传这个回调，长按就不响应（也就不该在说明里承诺能改）。
   */
  onManage?: (transform: TagTransform) => void | Promise<void>;
  /**
   * 「确认后才落库」的用法（批量打标签）传这个：底部按钮换成它，点完才生效。
   * 不传时底部是「完成」—— 那种场景里每次勾选就已经写回去了，不需要二次确认。
   */
  onConfirm?: () => void;
  confirmLabel?: string;
  title?: string;
  /** 已选区下方的一句口径说明（筛选器用来说清「含任一」） */
  hint?: string;
}

type ManageStep = 'root' | 'rename' | 'delete';
interface Managing {
  tag: string;
  count: number;
  step: ManageStep;
  draft: string;
}

export function TagPickerSheet({
  visible,
  onClose,
  tags,
  selected,
  onChange,
  onManage,
  onConfirm,
  confirmLabel = '完成',
  title = '选择标签',
  hint,
}: TagPickerSheetProps) {
  const styles = useStyles();
  const [query, setQuery] = useState('');
  const [managing, setManaging] = useState<Managing | null>(null);

  const selectedKeys = useMemo(() => new Set(selected.map(tagKey)), [selected]);
  const candidates = useMemo(() => filterTags(tags, query), [tags, query]);

  /** 关闭一律走这里：把「搜索词 + 管理面板」一起收掉，下次打开是干净的一屏 */
  const close = () => {
    setQuery('');
    setManaging(null);
    onClose();
  };

  const toggle = (tag: string) => {
    const key = tagKey(tag);
    if (selectedKeys.has(key)) {
      onChange(selected.filter((t) => tagKey(t) !== key));
    } else {
      onChange([...selected, tag]);
    }
  };

  const typed = normalizeTag(query);
  // 「新建」只在输入的内容确实不在候选里时出现 —— 否则等于让用户建一个重名标签
  const canCreate = typed.length > 0 && !tags.some((t) => tagKey(t.tag) === tagKey(typed));
  const create = () => {
    if (!canCreate) return;
    onChange([...selected, typed]);
    setQuery('');
  };

  /** 管理面板里的改名建议：排除它自己，最多给 8 个 */
  const renameSuggestions = useMemo(() => {
    if (!managing || managing.step !== 'rename') return [];
    return filterTags(tags, managing.draft)
      .filter((t) => tagKey(t.tag) !== tagKey(managing.tag))
      .slice(0, 8);
  }, [managing, tags]);

  const openManage = (item: TagCount) => {
    setManaging({ tag: item.tag, count: item.count, step: 'root', draft: item.tag });
  };

  const runManage = async (transform: TagTransform) => {
    await onManage?.(transform);
    setManaging(null);
    setQuery('');
  };

  return (
    <SheetModal visible={visible} onClose={close}>
      {managing ? (
        <ManagePanel
          managing={managing}
          setManaging={setManaging}
          suggestions={renameSuggestions}
          onRun={runManage}
        />
      ) : (
        <>
          <View style={styles.head}>
            <Heading>{title}</Heading>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
              onPress={close}
              hitSlop={10}>
              <Ionicons name="close" size={20} color={Palette.ink3} />
            </Pressable>
          </View>

          <View style={styles.searchWrap}>
            <Ionicons name="search-outline" size={15} color={Palette.ink4} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="搜索，或输入一个新标签"
              placeholderTextColor={Palette.ink4}
              style={styles.searchInput}
              autoCorrect={false}
              allowFontScaling={false}
              returnKeyType="done"
              onSubmitEditing={create}
            />
            {query.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="清空"
                hitSlop={8}
                onPress={() => setQuery('')}>
                <Ionicons name="close-circle" size={16} color={Palette.ink4} />
              </Pressable>
            ) : null}
          </View>

          {selected.length > 0 ? (
            <View style={styles.selectedBlock}>
              <Label tone="ink3" style={styles.blockLabel}>
                已选 {selected.length}
              </Label>
              <View style={styles.wrap}>
                {selected.map((tag) => (
                  <Pressable
                    key={tagKey(tag)}
                    accessibilityRole="button"
                    accessibilityLabel={`移除 ${tag}`}
                    onPress={() => toggle(tag)}
                    style={[styles.chip, styles.chipOn]}>
                    <Label style={styles.chipLabelOn}>{tag}</Label>
                    <Ionicons name="close" size={12} color={Palette.onAccent} />
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          {hint ? (
            <Meta tone="ink4" style={styles.hint}>
              {hint}
            </Meta>
          ) : null}

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled">
            <Label tone="ink3" style={styles.blockLabel}>
              {query.trim() ? '匹配到的标签' : '全部标签'}
            </Label>

            {canCreate ? (
              <Pressable
                accessibilityRole="button"
                onPress={create}
                style={[styles.chip, styles.chipCreate]}>
                <Ionicons name="add" size={13} color={Palette.brand} />
                <Label style={styles.chipLabelCreate}>{typed}</Label>
              </Pressable>
            ) : null}

            <View style={styles.wrap}>
              {candidates.map((item) => {
                const on = selectedKeys.has(tagKey(item.tag));
                return (
                  <Pressable
                    key={tagKey(item.tag)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => toggle(item.tag)}
                    onLongPress={onManage ? () => openManage(item) : undefined}
                    delayLongPress={350}
                    style={({ pressed }) => [
                      styles.chip,
                      on && styles.chipOn,
                      pressed && styles.chipPressed,
                    ]}>
                    <Label style={on ? styles.chipLabelOn : styles.chipLabel}>
                      {item.tag}
                      {item.count > 1 ? ` ${item.count}` : ''}
                    </Label>
                  </Pressable>
                );
              })}
            </View>

            {candidates.length === 0 && !canCreate ? (
              <Body tone="ink3" style={styles.empty}>
                {tags.length === 0
                  ? '库里还没有标签。输入一个再回车，它就会出现在这里，以后直接点选。'
                  : '没有匹配的标签。'}
              </Body>
            ) : null}

            {onManage && !(tags.length === 0 && !query.trim()) ? (
              <Meta tone="ink4" style={styles.footHint}>
                长按标签可以改名、合并或删除（对所有物品生效）
              </Meta>
            ) : null}
          </ScrollView>

          {selected.length > 0 || onConfirm ? (
            <View style={styles.foot}>
              <Button
                label={confirmLabel}
                disabled={onConfirm ? selected.length === 0 : false}
                onPress={() => {
                  onConfirm?.();
                  close();
                }}
              />
            </View>
          ) : null}
        </>
      )}
    </SheetModal>
  );
}

/* ------------------------------------------------------------ 管理面板 */

function ManagePanel({
  managing,
  setManaging,
  suggestions,
  onRun,
}: {
  managing: Managing;
  setManaging: (next: Managing | null) => void;
  suggestions: TagCount[];
  onRun: (transform: TagTransform) => void | Promise<void>;
}) {
  const styles = useStyles();
  const target = normalizeTag(managing.draft);
  const canRename = target.length > 0 && tagKey(target) !== tagKey(managing.tag);
  const [busy, setBusy] = useState(false);

  const run = async (transform: TagTransform) => {
    if (busy) return;
    setBusy(true);
    try {
      await onRun(transform);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="返回"
          hitSlop={10}
          onPress={() => setManaging(null)}>
          <Ionicons name="chevron-back" size={20} color={Palette.ink3} />
        </Pressable>
        <Heading style={styles.manageTitle}>「{managing.tag}」</Heading>
        <Meta tone="ink3">{managing.count} 件</Meta>
      </View>

      {managing.step === 'root' ? (
        <View style={styles.manageBody}>
          <Pressable
            accessibilityRole="button"
            style={styles.actionRow}
            onPress={() => setManaging({ ...managing, step: 'rename', draft: managing.tag })}>
            <Ionicons name="create-outline" size={17} color={Palette.ink2} />
            <View style={styles.actionText}>
              <Body>改名或合并</Body>
              <Meta tone="ink3">改成别的名字，或并到一个已有的标签上</Meta>
            </View>
            <Ionicons name="chevron-forward" size={16} color={Palette.ink4} />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            style={styles.actionRow}
            onPress={() => setManaging({ ...managing, step: 'delete' })}>
            <Ionicons name="trash-outline" size={17} color={Palette.clay} />
            <View style={styles.actionText}>
              <Body color={Palette.clay}>删除这个标签</Body>
              <Meta tone="ink3">从所有物品上摘掉，物品本身不动</Meta>
            </View>
            <Ionicons name="chevron-forward" size={16} color={Palette.ink4} />
          </Pressable>
        </View>
      ) : null}

      {managing.step === 'rename' ? (
        <View style={styles.manageBody}>
          <View style={styles.searchWrap}>
            <TextInput
              value={managing.draft}
              onChangeText={(t) => setManaging({ ...managing, draft: t })}
              placeholder="改成…"
              placeholderTextColor={Palette.ink4}
              style={styles.searchInput}
              autoFocus
              autoCorrect={false}
              allowFontScaling={false}
            />
          </View>

          {suggestions.length > 0 ? (
            <>
              <Label tone="ink3" style={styles.blockLabel}>
                并到已有标签
              </Label>
              <View style={styles.wrap}>
                {suggestions.map((s) => (
                  <Pressable
                    key={tagKey(s.tag)}
                    accessibilityRole="button"
                    style={[styles.chip, styles.chipOn]}
                    onPress={() => void run({ type: 'rename', from: managing.tag, to: s.tag })}>
                    <Label style={styles.chipLabelOn}>{s.tag}</Label>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          <View style={styles.manageFoot}>
            <Button
              label={canRename ? `改为「${target}」` : '改为…'}
              disabled={!canRename}
              loading={busy}
              onPress={() => void run({ type: 'rename', from: managing.tag, to: target })}
            />
            <Meta tone="ink4" style={styles.warn}>
              改名对所有物品生效，这些物品的「最近变动」时间不会被改动。
            </Meta>
          </View>
        </View>
      ) : null}

      {managing.step === 'delete' ? (
        <View style={styles.manageBody}>
          {/* 两步确认：这一步本身不是按钮，是一个说明 + 明确的动作 */}
          <Body tone="ink2" style={styles.confirmText}>
            把「{managing.tag}」从 {managing.count} 件物品上摘掉。物品不会被删除，
            只是不再带这个标签。
          </Body>
          <View style={styles.manageFoot}>
            <Button
              label={`确认删除「${managing.tag}」`}
              tone="danger"
              loading={busy}
              onPress={() => void run({ type: 'delete', tag: managing.tag })}
            />
            <Button
              label="取消"
              tone="ghost"
              disabled={busy}
              onPress={() => setManaging({ ...managing, step: 'root' })}
            />
          </View>
        </View>
      ) : null}
    </>
  );
}

const useStyles = makeStyles((Palette) => ({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: GUTTER,
    paddingTop: Space.lg,
    paddingBottom: Space.md,
  },
  manageTitle: { flex: 1 },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    marginHorizontal: GUTTER,
    paddingHorizontal: Space.md,
    height: 40,
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line,
    backgroundColor: Palette.surface2,
  },
  searchInput: { flex: 1, padding: 0, color: Palette.ink, fontSize: 14 },

  selectedBlock: { marginTop: Space.md },
  blockLabel: { marginHorizontal: GUTTER, marginTop: Space.md, marginBottom: Space.sm },
  hint: { marginHorizontal: GUTTER, marginTop: Space.xs },

  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.sm,
    paddingHorizontal: GUTTER,
  },

  list: { flexShrink: 1, marginTop: Space.xs },
  listContent: { paddingBottom: Space.md },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.md,
    paddingVertical: 6,
    borderRadius: Radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line,
    backgroundColor: Palette.surface,
    overflow: 'hidden',
  },
  chipOn: { backgroundColor: Palette.brand, borderColor: Palette.brand },
  chipCreate: { borderStyle: 'dashed', borderColor: Palette.brand, marginHorizontal: GUTTER },
  chipPressed: { opacity: 0.85 },
  chipLabel: { fontSize: 12.5, color: Palette.ink2 },
  chipLabelOn: { fontSize: 12.5, color: Palette.onAccent },
  chipLabelCreate: { fontSize: 12.5, color: Palette.brand },

  empty: { paddingHorizontal: GUTTER, paddingTop: Space.md, lineHeight: 21 },
  footHint: { paddingHorizontal: GUTTER, paddingTop: Space.lg },

  foot: { paddingHorizontal: GUTTER, paddingTop: Space.md },

  manageBody: { paddingBottom: Space.md },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: GUTTER,
    paddingVertical: Space.md,
  },
  actionText: { flex: 1 },
  manageFoot: { paddingHorizontal: GUTTER, paddingTop: Space.lg, gap: Space.sm },
  confirmText: { paddingHorizontal: GUTTER, paddingTop: Space.xs, lineHeight: 22 },
  warn: { lineHeight: 18 },
}));
