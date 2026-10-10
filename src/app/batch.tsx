/**
 * 格物 · 批量识图（roadmap 第八章）
 *
 * 一次选多张照片（≤9）→ 逐张识别 → 清单核对 → 批量入库。
 * 从录入页右上角进来；入口挡过一次，这里再挡一次（深链兜底）。
 *
 * ── 一条决定了整个实现形态的约束 ────────────────────────────────
 * ★★ **必须严格串行**。免费模型（智谱 GLM Flash 系列）的限制是
 *    「同一时刻只允许 1 条并发请求」—— 任何「并发 2~3 提速」的写法都会稳定撞 429，
 *    而用户看到的只是一句「调用太频繁」，完全想不到是自己这边并发了。
 *    所以下面是一个朴素的 `for` 循环，一张跑完再下一张。
 *    代价是最坏要等几分钟（9 张 × 每张最长 60s），所以才要有进度（流式冒条）、
 *    停止键（可续跑）、单条重试，以及「别退出这一页」的提示。
 *
 * ── 四条刻意的取舍 ────────────────────────────────────────────
 * 1. **先落盘、再联网**（与单件识物同一条）：用户选的这张图本来就是这件东西的图，
 *    识别失败也不该白拍。照片在联网之前就走完了压缩与入库。
 * 2. **失败/空结果不丢条目**：照片留着、条目留着，标一句「补个名字就能存」，
 *    还能单条重试。直接丢掉会产生没人引用的孤儿文件。
 * 3. **离开这一页会清掉未入库的照片**（见 cleanup 那段）——
 *    本页是「审完一次入库」的语境，不做跨会话恢复：退出即放弃，
 *    留着照片只会在 cache 里悄悄堆积。
 * 4. **「统一分类 / 位置」记在 state 里，而不是一次性刷一遍**：
 *    识别是流式的，用户在第 3 张还在跑的时候设了「统一分类＝食品」，
 *    第 4 张出来也该带上它。一次性 `applyUniform` 只覆盖当时已存在的条目。
 *
 * ── 不复用 ItemForm 的理由（见 roadmap 8.5）
 * `ItemForm` 是整页级组件（自带滚动、双提交按钮、自己的 `useTagLibrary` 与重名检测），
 * 它的 `draft` 只在**首次挂载**时取 `prefill` —— 清单会随识别进度重渲染、行会被重挂，
 * 用户刚改的名称立刻被冲回识别初稿。所以清单行只做**轻量内联**，
 * 要改全字段就跳 `/batch/item`（新开一页复用 `ItemForm`，见那里的头注释）。
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { AiOffNotice } from '@/components/domain/AiOffNotice';
import { CategoryPickerModal } from '@/components/domain/CategoryPickerModal';
import { LocationPickerModal } from '@/components/domain/LocationPickerModal';
import { SupporterGateSheet } from '@/components/domain/SupporterGateSheet';
import { Button, Chip, ChipRow, IconButton } from '@/components/ui/controls';
import { Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { Body, Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Radius, Space } from '@/constants/theme';
import {
  applyEditResult,
  applyResult,
  applyUniform,
  attachPhoto,
  assign,
  isSavable,
  markFailed,
  markRunning,
  newEntry,
  progressLabel,
  progressOf,
  removeEntry,
  rename,
  savableCount,
  toDrafts,
  toggleSelected,
  type BatchEditSeed,
  type BatchEntry,
  type BatchPhoto,
} from '@/lib/ai/batch';
import { putEditing, takeEditResult } from '@/lib/ai/batch-draft';
import { askVision, describeAiError } from '@/lib/ai/client';
import { buildVisionPrompt, parseExtract } from '@/lib/ai/extract';
import { toUploadBase64 } from '@/lib/ai/upload';
import { today } from '@/lib/date';
import { listCategories } from '@/lib/db/categories';
import { createItemsBatch, findItemsByName } from '@/lib/db/items';
import { lastUsedLocationId, listCabinetViews } from '@/lib/db/locations';
import { addPhoto } from '@/lib/db/photos';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { deleteFiles, ingestMany, photoUri, pickFromLibrary, type SourceImage } from '@/lib/photos/pipeline';
import { useAi } from '@/lib/store/ai';
import { useAppState } from '@/lib/store/app-state';
import { useEntitlement } from '@/lib/store/entitlement';
import { makeStyles } from '@/lib/theme';
import type { CabinetView } from '@/lib/types';

/**
 * 单批上限。
 *
 * 取 9 有两个理由：相册多选上限本来就是 9（再多要分批选），
 * 以及 9 × 每张十几秒 ≈ 两三分钟，是「站在柜子前能等完」的量级。
 * 想加就同时改这里与 `pickFromLibrary` 的默认值 —— 别忘了后者的 selectionLimit。
 */
const BATCH_LIMIT = 9;

type Phase = 'picking' | 'running' | 'review' | 'saving' | 'done';

/** 弹层目标：给整批设，还是给某一条改 */
type PickTarget = { mode: 'uniform' } | { mode: 'one'; key: string } | null;

/* ================================================================== 入口 */

export default function BatchScreen() {
  const router = useRouter();
  const { entitled } = useEntitlement();
  const { enabled: aiEnabled, supportsVision } = useAi();

  /* 三道守卫，顺序有理由：**先档位、后总开关** ——
     一个既没付费、又关了开关的人，该先看到「去买」而不是「去打开」
     （后者是他打开也用不了的东西）。与 `/ask`、`/voice` 同序。
     第三道是「这家能不能看图」：纯文本模型进来只会在模型侧报错。 */
  if (!entitled) {
    return (
      <AiOffNotice
        title="批量识图"
        body="批量识图与识物、问一问、语音录入同属支持者档。免费档的录入、到期、库存、照片与备份全部照旧，一个不少。"
        actionLabel="去激活 / 了解支持者档"
        onAction={() => router.push('/supporter')}
        onBack={() => router.back()}
        footer={<SupporterGateSheet visible feature="ai" onClose={() => router.back()} />}
      />
    );
  }
  if (!aiEnabled) {
    return (
      <AiOffNotice
        title="批量识图"
        body="AI 助手总开关关着，这一族入口都不在。打开之后，拍一张、说一句、或者一次选一批照片都可以。"
        actionLabel="去 AI 助手打开开关"
        onAction={() => router.push('/ai')}
        onBack={() => router.back()}
      />
    );
  }
  if (!supportsVision) {
    return (
      <AiOffNotice
        title="批量识图"
        body="当前这家模型看不了图（比如纯文本模型），所以识图入口是藏起来的。换一家能看图的，或给这家填一个识图模型。"
        actionLabel="去 AI 助手换模型"
        onAction={() => router.push('/ai')}
        onBack={() => router.back()}
      />
    );
  }

  return <BatchRunner />;
}

/* ================================================================== 主体 */

function BatchRunner() {
  const styles = useStyles();
  const router = useRouter();
  const { bump } = useAppState();
  const { record } = useAi();

  const [entries, setEntries] = useState<BatchEntry[]>([]);
  const [phase, setPhase] = useState<Phase>('picking');
  const [hint, setHint] = useState<string | null>(null);
  const [saved, setSaved] = useState(0);
  const [catTarget, setCatTarget] = useState<PickTarget>(null);
  const [locTarget, setLocTarget] = useState<PickTarget>(null);

  /**
   * 统一分类 / 位置。
   *
   * ★ 必须同时存一份 ref：识别循环里要读的**是当下最新**的值，
   *   而 `useCallback` 闭包只会捕获它创建那一刻的 state。
   *   用户在第三张还在跑时改了这个值，第四张要立刻用上 —— 只读 state 会拿到旧值，
   *   而且不报错（只是那一条的分类没跟上）。
   */
  const [uniform, setUniformState] = useState<{
    categoryId: string | null;
    locationId: string | null;
  }>({ categoryId: null, locationId: null });
  const uniformRef = useRef(uniform);
  const setUniform = useCallback(
    (patch: Partial<{ categoryId: string | null; locationId: string | null }>) => {
      uniformRef.current = { ...uniformRef.current, ...patch };
      setUniformState(uniformRef.current);
    },
    [],
  );

  /** 与库里已有物品重名的名字（只提示、不阻断，与单件录入口径一致） */
  const [dupes, setDupes] = useState<ReadonlySet<string>>(() => new Set());

  const categoryState = useAsyncData(() => listCategories(), [], []);
  const cabinetState = useAsyncData(() => listCabinetViews(), [], []);
  const lastLocState = useAsyncData(() => lastUsedLocationId(), [], null as string | null);

  const categories = categoryState.data;
  const categoryNames = useMemo(() => categories.map((c) => c.name), [categories]);

  /** 停止标志。只影响「还开不开下一张」—— 正在飞的那条请求由它自己的超时兜住 */
  const stopRef = useRef(false);
  /** 已成功入库的条目 key。离开页面时据此判断哪些照片**不该**删 */
  const savedKeysRef = useRef<Set<string>>(new Set());
  /** 只启动一次（分类读完 → 开相册 → 开跑） */
  const startedRef = useRef(false);
  /** cleanup 与事件回调要读到最新条目，而它们拿不到闭包里的 state */
  const entriesRef = useRef<BatchEntry[]>([]);
  /** 原始选中的图与对应 key —— 停止之后「继续识别」要靠它们接上 */
  const sourcesRef = useRef<SourceImage[]>([]);
  const keysRef = useRef<string[]>([]);

  const progress = useMemo(() => progressOf(entries), [entries]);
  const savable = useMemo(() => savableCount(entries), [entries]);
  const pendingCount = useMemo(
    () => entries.reduce((n, e) => (e.status === 'pending' ? n + 1 : n), 0),
    [entries],
  );

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  /**
   * 离开这一页 → 清掉**还没入库**的那些照片。
   *
   * 为什么必须由本页负责：这些文件是在「先落盘」那一步写进沙盒的，
   * 而条目还只活在内存里。用户按返回键离开，条目没了、文件却还在 ——
   * 除了下次「导入备份」时的对账，没人会来清它（那可能是几个月后）。
   *
   * ★ 判据是 `savedKeysRef` 而不是「有没有 photo」：保存过的条目，
   *   照片已经挂到 items 上了，删了就是删用户的图。
   */
  useEffect(() => {
    return () => {
      /* ★ cleanup 里**就是要读 ref 那一刻的最新值** —— 这里的 ref 是数据、不是 React 节点：
         用户可能已经中途保存过一批（`savedKeysRef` 在那时被写过），
         那些照片绝不能删。lint 那条「ref 可能已变」的建议针对的是 DOM 节点 ref，
         在这里正好反着 —— 所以要的是最新值，不是挂载时的快照。 */
      /* eslint-disable react-hooks/exhaustive-deps -- 见上：cleanup 要读最新 ref */
      const savedKeys = savedKeysRef.current;
      const orphans: string[] = [];
      for (const e of entriesRef.current) {
        if (!e.photo || savedKeys.has(e.key)) continue;
        orphans.push(e.photo.filePath, e.photo.thumbPath);
      }
      if (orphans.length > 0) deleteFiles(orphans);
      /* eslint-enable react-hooks/exhaustive-deps */
    };
  }, []);

  /**
   * 同名检测。
   *
   * 防抖 700ms（清单里每次敲字都会改 entries），逐个名字查一次 ——
   * 条数上限是 9，本地 SQLite 一条查询是毫秒级，不值得为它写一条聚合 SQL。
   * ★ 查重失败**静默**：这是一句附加提示，不该因为它让整页报错。
   */
  useEffect(() => {
    const names = Array.from(new Set(entries.map((e) => e.name.trim()).filter(Boolean)));
    if (names.length === 0) {
      setDupes(new Set());
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        const found = new Set<string>();
        for (const n of names) {
          try {
            const hits = await findItemsByName(n);
            if (hits.length > 0) found.add(n);
          } catch {
            // 忽略：这只是提示
          }
        }
        if (alive) setDupes(found);
      })();
    }, 700);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [entries]);

  /* 「详细编辑」改完回来 —— 把结果写回那一条 */
  useFocusEffect(
    useCallback(() => {
      const r = takeEditResult();
      if (r) setEntries((prev) => applyEditResult(prev, r.key, r.seed));
    }, []),
  );

  /* ---------------------------------------------------------- 识别 */

  /**
   * 用一张**已经落盘**的照片跑一次识别，并把结果写进那一条。
   *
   * 抽出来是为了给「单条重试」复用：重试时照片早就在沙盒里了，
   * 没必要（也不该）让用户重新选一次图。
   */
  const recognizePhoto = useCallback(
    async (key: string, photo: BatchPhoto, names: string[]) => {
      try {
        /* 上传源用**刚落盘的压缩图**，不是原始选中的那张 ——
           相机原图动辄 4000×3000，从它缩到 1024 要整张解码一遍，
           低端机上就是好几秒，而这一步越慢越容易顶到超时。 */
        const base64 = await toUploadBase64(photoUri(photo.filePath), photo.width, photo.height);

        /* 这一句是整条链路上唯一会等很久的地方（超时上限 60s） */
        const raw = await askVision(buildVisionPrompt(names), base64);
        record('vision');

        /* 解析。返回 null ＝ 一个字段都没读出来，归为「待补名」 */
        const parsed = parseExtract(raw, { today: today(), categories: names });
        setEntries((prev) => {
          const next = applyResult(prev, key, parsed, categories);
          /* ★ 统一值只套**这一条**。用 applyUniform 会把其他条目里
             用户单独改过的分类/位置一并冲掉 —— 那不叫「统一」，叫覆盖。 */
          const u = uniformRef.current;
          let out = next;
          if (u.categoryId) out = assign(out, key, { categoryId: u.categoryId });
          if (u.locationId) out = assign(out, key, { locationId: u.locationId });
          return out;
        });
      } catch (err) {
        /* 失败**不中断整批**：这一条降级成「待补名」，照片照旧留着，还能重试。
           文案来自 describeAiError —— 它已经把「超时」「限流」「Key 不对」分开说了。 */
        setEntries((prev) =>
          markFailed(
            prev,
            key,
            `${describeAiError(err)}。照片已经存下了，补个名字就能保存，也可以点重试`,
          ),
        );
      }
    },
    [categories, record],
  );

  /** 从第 `from` 条接着跑（串行）。`runAll` 走 0，`resume` 走第一个 pending */
  const runFrom = useCallback(
    async (from: number, names: string[]) => {
      const sources = sourcesRef.current;
      const keys = keysRef.current;
      for (let i = from; i < sources.length; i += 1) {
        if (stopRef.current) break;
        const key = keys[i];
        setEntries((prev) => markRunning(prev, key));

        try {
          /* 1) 先落盘：这张照片最终要挂到物品上，与识别成败无关 */
          const ing = await ingestMany([sources[i]]);
          const photo = ing.photos[0];
          if (!photo) {
            setEntries((prev) => markFailed(prev, key, '这张图处理不了，单独再试一次'));
            continue;
          }
          const ref: BatchPhoto = {
            filePath: photo.filePath,
            thumbPath: photo.thumbPath,
            width: photo.width,
            height: photo.height,
          };
          setEntries((prev) => attachPhoto(prev, key, ref));

          /* 2) 压缩 → 联网 → 解析，都在 recognizePhoto 里 */
          await recognizePhoto(key, ref, names);
        } catch (err) {
          /* ingestMany 自己不会抛（单张失败进 failed 数组），
             走到这里说明是落盘之外的意外 */
          setEntries((prev) =>
            markFailed(prev, key, `${describeAiError(err)}。照片没有存下，单独再试一次`),
          );
        }
      }
    },
    [recognizePhoto],
  );

  const runAll = useCallback(
    async (sources: SourceImage[], names: string[]) => {
      stopRef.current = false;
      const seeded = sources.map((_, i) => newEntry(`b${Date.now()}-${i}`, null));
      sourcesRef.current = sources;
      keysRef.current = seeded.map((e) => e.key);
      setEntries(seeded);
      setPhase('running');
      await runFrom(0, names);
      setPhase('review');
    },
    [runFrom],
  );

  const start = useCallback(async () => {
    const names = categoryState.data.map((c) => c.name);
    const picked = await pickFromLibrary(BATCH_LIMIT);
    if (picked.denied) {
      setHint('没有相册权限，选不了图。到系统设置里给格物加上「照片」权限再试。');
      setPhase('review');
      return;
    }
    if (picked.sources.length === 0) {
      // 用户取消选择 —— 这一页没有存在的理由了，安静退回
      router.back();
      return;
    }
    await runAll(picked.sources, names);
  }, [categoryState.data, router, runAll]);

  /* 分类读出来之后再开相册：提示词里要带上「可选分类」，
     分类还没到就开跑，模型拿到的是一份空清单（识别质量会掉，且不报错） */
  useEffect(() => {
    const ready = !categoryState.loading && !cabinetState.loading;
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    void start().catch(() => {
      setHint('打开相册失败了，退回去重试一次');
      setPhase('review');
    });
  }, [categoryState.loading, cabinetState.loading, start]);

  /* ---------------------------------------------------------- 停止 / 继续 / 重试 */

  const stop = useCallback(() => {
    stopRef.current = true;
    setHint('已停止。前面识别好的可以照常保存，剩下的点「继续识别」接着跑。');
  }, []);

  /** 接着跑队列里仍是 pending 的那些（同一次会话内；不做跨会话恢复） */
  const resume = useCallback(async () => {
    const idx = entriesRef.current.findIndex((e) => e.status === 'pending');
    if (idx < 0) return;
    setHint(null);
    stopRef.current = false;
    setPhase('running');
    await runFrom(idx, categoryNames);
    setPhase('review');
  }, [categoryNames, runFrom]);

  /** 单条重试：用它的照片重跑一次识别，不重新选图 */
  const retryOne = useCallback(
    async (key: string) => {
      const entry = entriesRef.current.find((e) => e.key === key);
      if (!entry?.photo) return;
      setEntries((prev) => markRunning(prev, key));
      await recognizePhoto(key, entry.photo, categoryNames);
    },
    [categoryNames, recognizePhoto],
  );

  /* ---------------------------------------------------------- 保存 */

  const save = useCallback(async () => {
    const picked = entries.filter(isSavable);
    if (picked.length === 0) return;
    setPhase('saving');
    try {
      const drafts = toDrafts(picked, {
        locationId: uniform.locationId ?? lastLocState.data,
      });
      const ids = await createItemsBatch(drafts);

      /* 照片逐条挂。★ 与 items 不在同一个事务里（photos 的插入在它自己的模块），
         所以单独兜一道：挂失败不该让整次保存崩掉，但要**如实说一声**，
         否则用户只会看到「刚存的那批有几件没图」而不知为什么。 */
      let photoFailed = 0;
      for (let i = 0; i < picked.length; i += 1) {
        const p = picked[i].photo;
        if (!p) continue;
        try {
          await addPhoto(ids[i], p.filePath, p.thumbPath);
          savedKeysRef.current.add(picked[i].key);
        } catch {
          photoFailed += 1;
        }
      }

      bump();
      setSaved(picked.length);
      setPhase('done');
      if (photoFailed > 0) {
        setHint(`有 ${photoFailed} 件没能挂上照片，去详情页补一张就行。`);
      }
    } catch {
      setHint('没能保存，再试一次。');
      setPhase('review');
    }
  }, [bump, entries, lastLocState.data, uniform.locationId]);

  /* ---------------------------------------------------------- 交互 */

  const close = useCallback(() => router.back(), [router]);

  const onPickCategory = useCallback(
    (id: string | null) => {
      const target = catTarget;
      setCatTarget(null);
      if (!target) return;
      if (target.mode === 'uniform') {
        setUniform({ categoryId: id });
        setEntries((prev) => applyUniform(prev, { categoryId: id }));
      } else {
        setEntries((prev) => assign(prev, target.key, { categoryId: id }));
      }
    },
    [catTarget, setUniform],
  );

  const onPickLocation = useCallback(
    (id: string | null) => {
      const target = locTarget;
      setLocTarget(null);
      if (!target) return;
      if (target.mode === 'uniform') {
        setUniform({ locationId: id });
        setEntries((prev) => applyUniform(prev, { locationId: id }));
      } else {
        setEntries((prev) => assign(prev, target.key, { locationId: id }));
      }
    },
    [locTarget, setUniform],
  );

  /** 详细编辑：把这一条放进一次性槽，跳到复用 `ItemForm` 的页面 */
  const openEdit = useCallback(
    (entry: BatchEntry) => {
      putEditing({ key: entry.key, seed: seedFromEntry(entry), photo: entry.photo });
      router.push('/batch/item');
    },
    [router],
  );

  /* ---------------------------------------------------------- 渲染 */

  if (phase === 'picking' && entries.length === 0) {
    return (
      <Screen>
        <PageHeader title="批量识图" subtitle="正在打开相册" />
        <View style={styles.center}>
          <ActivityIndicator color={Palette.brand} />
          <Meta tone="ink3" style={styles.centerText}>
            选好之后会一张一张识别，中途别退出这一页
          </Meta>
        </View>
      </Screen>
    );
  }

  if (phase === 'done') {
    return (
      <Screen>
        <PageHeader title="批量识图" subtitle={`已保存 ${saved} 件`} />
        <View style={styles.center}>
          <Ionicons name="checkmark-circle" size={44} color={Palette.sage} />
          <Body tone="ink2" style={styles.centerText}>
            这批已经进库了，在物品列表里能看到。
          </Body>
          {hint ? (
            <Meta color={Palette.amber} style={styles.centerText}>
              {hint}
            </Meta>
          ) : null}
          <Button label="完成" onPress={close} block={false} style={styles.doneBtn} />
        </View>
      </Screen>
    );
  }

  const showTools = phase === 'running' || phase === 'review';

  return (
    <Screen>
      <PageHeader
        title="批量识图"
        subtitle={progressLabel(progress, savable)}
        right={
          phase === 'running' ? (
            <IconButton icon="stop-circle-outline" accessibilityLabel="停止识别" onPress={stop} />
          ) : (
            <IconButton icon="close" accessibilityLabel="关闭" onPress={close} />
          )
        }
      />

      {showTools ? (
        <ChipRow>
          <Chip label="统一分类" onPress={() => setCatTarget({ mode: 'uniform' })} />
          <Chip label="统一位置" onPress={() => setLocTarget({ mode: 'uniform' })} />
          {phase === 'review' && pendingCount > 0 ? (
            <Chip label={`继续识别 ${pendingCount}`} onPress={() => void resume()} />
          ) : null}
        </ChipRow>
      ) : null}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {entries.map((entry) => (
          <EntryRow
            key={entry.key}
            entry={entry}
            categories={categories}
            cabinets={cabinetState.data}
            duplicated={dupes.has(entry.name.trim())}
            onRename={(name) => setEntries((prev) => rename(prev, entry.key, name))}
            onToggle={() => setEntries((prev) => toggleSelected(prev, entry.key))}
            onRemove={() => setEntries((prev) => removeEntry(prev, entry.key))}
            onPickCategory={() => setCatTarget({ mode: 'one', key: entry.key })}
            onPickLocation={() => setLocTarget({ mode: 'one', key: entry.key })}
            onEdit={() => openEdit(entry)}
            onRetry={() => void retryOne(entry.key)}
          />
        ))}

        {hint ? (
          <Gutter>
            <Meta color={Palette.clay} style={styles.hint}>
              {hint}
            </Meta>
          </Gutter>
        ) : null}
      </ScrollView>

      <Gutter>
        <Button
          label={savable > 0 ? `保存 ${savable} 件` : '还没有能保存的'}
          icon="download-outline"
          disabled={savable === 0 || phase === 'saving'}
          loading={phase === 'saving'}
          onPress={() => void save()}
          style={styles.saveBtn}
        />
        {savable > 0 && savable < entries.length ? (
          <Meta tone="ink3" style={styles.saveNote}>
            有 {entries.length - savable} 件没勾选或还没名字，不会保存。
          </Meta>
        ) : null}
      </Gutter>

      <CategoryPickerModal
        visible={catTarget !== null}
        categories={categories}
        title={catTarget?.mode === 'uniform' ? '统一分类' : '这一件的分类'}
        onClose={() => setCatTarget(null)}
        onPick={onPickCategory}
      />
      <LocationPickerModal
        visible={locTarget !== null}
        cabinets={cabinetState.data}
        selectedId={null}
        onClose={() => setLocTarget(null)}
        onPick={onPickLocation}
      />
    </Screen>
  );
}

/* ================================================================== 清单行 */

function EntryRow({
  entry,
  categories,
  cabinets,
  duplicated,
  onRename,
  onToggle,
  onRemove,
  onPickCategory,
  onPickLocation,
  onEdit,
  onRetry,
}: {
  entry: BatchEntry;
  categories: { id: string; name: string }[];
  cabinets: CabinetView[];
  duplicated: boolean;
  onRename: (name: string) => void;
  onToggle: () => void;
  onRemove: () => void;
  onPickCategory: () => void;
  onPickLocation: () => void;
  onEdit: () => void;
  onRetry: () => void;
}) {
  const styles = useStyles();
  const categoryName = entry.categoryId
    ? (categories.find((c) => c.id === entry.categoryId)?.name ?? '未分类')
    : '未分类';
  const locationName = findLocationName(cabinets, entry.locationId);
  /** 失败 / 空结果且照片还在 → 可以原地重试 */
  const canRetry = (entry.status === 'failed' || entry.status === 'empty') && !!entry.photo;

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: entry.selected }}
        accessibilityLabel="勾选这一件"
        hitSlop={6}
        onPress={onToggle}
        style={styles.check}>
        <Ionicons
          name={entry.selected ? 'checkmark-circle' : 'ellipse-outline'}
          size={22}
          color={entry.selected ? Palette.brand : Palette.ink4}
        />
      </Pressable>

      <View style={styles.thumb}>
        {entry.photo ? (
          <Image source={{ uri: photoUri(entry.photo.thumbPath) }} style={styles.thumbImg} />
        ) : (
          <Ionicons name="image-outline" size={20} color={Palette.ink4} />
        )}
      </View>

      <View style={styles.rowBody}>
        <TextInput
          value={entry.name}
          onChangeText={onRename}
          placeholder="给它起个名字"
          placeholderTextColor={Palette.ink4}
          style={styles.nameInput}
          allowFontScaling={false}
        />
        <View style={styles.metaRow}>
          <Pressable accessibilityRole="button" onPress={onPickCategory} hitSlop={6}>
            <Label color={entry.categoryId ? Palette.brand : Palette.ink3}>{categoryName}</Label>
          </Pressable>
          <Meta tone="ink4">·</Meta>
          <Pressable accessibilityRole="button" onPress={onPickLocation} hitSlop={6}>
            <Label color={entry.locationId ? Palette.brand : Palette.ink3}>
              {locationName ?? '没定位置'}
            </Label>
          </Pressable>
        </View>
        <View style={styles.statusRow}>
          <Meta color={statusColor(entry)} style={styles.status}>
            {statusText(entry)}
          </Meta>
          {canRetry ? (
            <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={6}>
              <Label color={Palette.brand}>重试</Label>
            </Pressable>
          ) : null}
        </View>
        {duplicated ? (
          <Meta color={Palette.amber} style={styles.status}>
            与库里已有物品重名
          </Meta>
        ) : null}
      </View>

      <View style={styles.rowActions}>
        <IconButton
          icon="create-outline"
          size={18}
          tone="ink3"
          accessibilityLabel="详细编辑"
          onPress={onEdit}
        />
        <IconButton
          icon="trash-outline"
          size={18}
          tone="ink3"
          accessibilityLabel="不要这一件"
          onPress={onRemove}
        />
      </View>
    </View>
  );
}

/* ================================================================== 工具 */

function statusText(entry: BatchEntry): string {
  switch (entry.status) {
    case 'pending':
      return '排队中';
    case 'running':
      return '识别中，请稍等';
    case 'done':
      return `AI 填了 ${entry.filled.length} 项，核对一下`;
    case 'empty':
      return '没读出字段，补个名字就能保存';
    case 'failed':
      return entry.notice ?? '这一张没识别成功，补个名字就能保存';
  }
}

function statusColor(entry: BatchEntry): string {
  if (entry.status === 'failed') return Palette.clay;
  if (entry.status === 'empty') return Palette.amber;
  return Palette.ink3;
}

/** 位置 id → 「柜子 · 格位」的可读名 */
function findLocationName(cabinets: CabinetView[], id: string | null): string | null {
  if (!id) return null;
  for (const c of cabinets) {
    if (c.id === id) return c.name;
    for (const s of c.slots) {
      if (s.slot.id === id) return `${c.name} · ${s.slot.name}`;
    }
  }
  return null;
}

/** 条目 → 详细编辑的种子（模型的输出 + 用户的草稿合起来） */
function seedFromEntry(e: BatchEntry): BatchEditSeed {
  return {
    name: e.name,
    categoryId: e.categoryId,
    locationId: e.locationId,
    expireDate: e.expireDate,
    brand: e.fields.brand,
    model: e.fields.model,
    price: e.fields.price,
    quantity: e.fields.quantity,
    purchaseDate: e.fields.purchaseDate,
    tags: e.fields.tags,
    note: e.fields.note,
  };
}

/* ================================================================== 样式 */

const useStyles = makeStyles((Palette) => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.sm, paddingHorizontal: Space.xxl },
  centerText: { textAlign: 'center', lineHeight: 21 },
  doneBtn: { marginTop: Space.lg },

  list: { flex: 1, marginTop: Space.sm },
  listContent: { paddingBottom: Space.lg },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    marginHorizontal: GUTTER,
    marginBottom: Space.sm,
    paddingVertical: Space.sm,
    paddingRight: Space.xs,
    backgroundColor: Palette.surface,
    borderRadius: Radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line,
  },
  check: { paddingLeft: Space.md },
  thumb: {
    width: 46,
    height: 46,
    borderRadius: Radius.thumb,
    backgroundColor: Palette.inset,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImg: { width: 46, height: 46 },
  rowBody: { flex: 1, gap: 2 },
  nameInput: { fontSize: 15, fontWeight: '500', color: Palette.ink, padding: 0 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  status: { fontSize: 12 },
  rowActions: { flexDirection: 'row', alignItems: 'center' },

  hint: { marginBottom: Space.sm, lineHeight: 20 },
  saveBtn: { marginTop: Space.sm },
  saveNote: { marginTop: Space.xs, marginBottom: Space.sm },
}));
