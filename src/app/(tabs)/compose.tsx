/**
 * 格物 · 录入页（连续录入）
 *
 * V1 成败的关键页。用户能不能坚持记下去，九成取决于这一屏的操作量。
 * 因此主按钮是「保存并录下一件」而不是「完成」—— 界面要推着用户往前走，
 * 而不是引导他退出。保存后自动沿用刚才的位置与分类。
 *
 * ── 识物预填接在这一页 ──────────────────────────────────────────
 * 表单本身不知道「支持者档」「有没有配 Key」，那是这一页的判断：
 * 需要时把 `onAiRecognize` 传下去，识物入口才出现。
 * 识别的顺序是**先落盘、再联网**：用户拍的那张实物照本身就该成为物品照片，
 * 所以它在网络往返之前就走完了压缩与入库；模型那一步失败也只是拿不到字段，
 * 照片照旧留着（否则一次网络抖动会让用户白拍一张）。
 */

import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

import { SupporterGateSheet } from '@/components/domain/SupporterGateSheet';
import {
  ItemForm,
  type AiRecognition,
  type AiRecognizeError,
  type AiRecognizeSource,
  type FormPayload,
} from '@/components/domain/ItemForm';
import { IconButton } from '@/components/ui/controls';
import { Loading } from '@/components/ui/feedback';
import { Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { Meta } from '@/components/ui/typography';
import { Space } from '@/constants/theme';
import { askVision, describeAiError } from '@/lib/ai/client';
import { toUploadBase64 } from '@/lib/ai/upload';
import { buildVisionPrompt, EMPTY_FIELDS, parseExtract } from '@/lib/ai/extract';
import { today } from '@/lib/date';
import { listCategories } from '@/lib/db/categories';
import { createItem } from '@/lib/db/items';
import { listCabinetViews, lastUsedLocationId } from '@/lib/db/locations';
import { addPhoto, promotePhoto } from '@/lib/db/photos';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { captureWithCamera, ingestMany, pickFromLibrary } from '@/lib/photos/pipeline';
import { useAi } from '@/lib/store/ai';
import { useAppState } from '@/lib/store/app-state';
import { useEntitlement } from '@/lib/store/entitlement';
import { useTheme } from '@/lib/theme';

export default function ComposeScreen() {
  const router = useRouter();
  const { bump, dataVersion } = useAppState();
  // 本页没有样式表，但底下那行提示用的是内联取色 ——
  // 取 tokens 这个动作同时建立主题订阅，否则换肤时它不会更新
  const { tokens } = useTheme();

  /** 递增即重挂表单，实现「保存后清空继续录」 */
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [defaultLocationId, setDefaultLocationId] = useState<string | null>(null);
  /** 免费档点识物时弹的门控浮层 */
  const [gateOpen, setGateOpen] = useState(false);

  const { entitled } = useEntitlement();
  const { active: aiActive, enabled: aiEnabled, record } = useAi();

  const categoryState = useAsyncData(() => listCategories(), [dataVersion], []);
  const cabinetState = useAsyncData(() => listCabinetViews(), [dataVersion], []);

  // 首次进入时，沿用上次用过位置；之后沿用本次会话中刚录的位置
  const lastLocationState = useAsyncData(() => lastUsedLocationId(), [], null as string | null);
  const effectiveLocation = defaultLocationId ?? lastLocationState.data;

  const categoryNames = categoryState.data.map((c) => c.name);

  /**
   * 识物：取图 → 落盘 → 压缩副本 → 问模型 → 解析。
   *
   * ★ 门控放在这里而不是藏掉入口：免费档点一下看到的是「这东西是什么、
   *   免费档少了什么」，而不是一个不存在的按钮 —— 没有商店的评分兜底时，
   *   说清楚比装作没有更重要（与 01 屏那个星标同一个口径）。
   */
  const recognize = useCallback(
    async (source: AiRecognizeSource): Promise<AiRecognition | AiRecognizeError | null> => {
      if (!entitled) {
        setGateOpen(true);
        return null;
      }
      if (!aiActive) {
        /*
         * 「开关没开」与「Key 没填」要分开说 —— 两件事用户要做的不一样。
         * 混成一句「还没配置 AI」，填过 Key 却忘了开开关的人会找不到问题在哪。
         */
        return {
          error: aiEnabled
            ? '还没填 API Key：到「我的」页的「AI 助手」里填上自己的 Key'
            : 'AI 助手还没打开：到「我的」页的「AI 助手」里打开总开关',
        };
      }

      // 1) 取图（相机 / 相册各限一张：识物只需要一张实物照）
      const picked = source === 'camera' ? await captureWithCamera() : await pickFromLibrary(1);
      if (picked.denied) {
        return { error: source === 'camera' ? '没有相机权限，拍不了' : '没有相册权限，选不了图' };
      }
      if (picked.sources.length === 0) return null; // 用户取消，什么都不做
      const src = picked.sources[0];

      // 2) 先落盘：这张照片最终要挂到物品上，与识别成败无关
      const ingested = await ingestMany([src]);
      const photo = ingested.photos[0] ?? null;
      if (!photo) return { error: '这张图处理失败了，换一张试试' };

      // 3) 压缩副本 → 问模型。失败也把照片交回去（见 AiRecognition.notice 的注释）
      try {
        const base64 = await toUploadBase64(src.uri, src.width, src.height);
        const raw = await askVision(buildVisionPrompt(categoryNames), base64);
        record('vision');

        const parsed = parseExtract(raw, { today: today(), categories: categoryNames });
        if (!parsed) {
          return { fields: EMPTY_FIELDS, filled: [], confidence: null, photo };
        }
        return { ...parsed, photo };
      } catch (err) {
        return {
          fields: EMPTY_FIELDS,
          filled: [],
          confidence: null,
          photo,
          notice: `${describeAiError(err)}。照片已经存下了，字段自己填一下`,
        };
      }
    },
    [entitled, aiActive, record, categoryNames],
  );

  const handleSubmit = async (payload: FormPayload, action: 'primary' | 'secondary') => {
    setSubmitting(true);
    try {
      const itemId = await createItem(payload.draft);
      for (const photo of payload.newPhotos) {
        await addPhoto(itemId, photo.filePath, photo.thumbPath);
      }
      // 找来的封面要排到最前，否则它会被追加在末尾，列表里看到的还是旧图
      if (payload.coverPath) await promotePhoto(itemId, payload.coverPath);

      setLastSaved(payload.draft.name);
      setDefaultLocationId(payload.draft.locationId ?? null);
      bump();

      if (action === 'primary') {
        // 继续录下一件：清空表单，但保留位置默认值
        setFormKey((k) => k + 1);
      } else {
        router.replace('/');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const loading = categoryState.loading || cabinetState.loading;

  return (
    <Screen>
      <PageHeader
        title="录入"
        subtitle={lastSaved ? `刚记下「${lastSaved}」，继续下一件` : '每件东西只敲一个名字就能存'}
        /* 语音入口这里留一个，首页搜索框右侧还有一个（那一格与星标并排，
           是设计稿 01 屏的画法）。两处不是重复，分工不同：
           首页那格是「在列表上随手录一句」，不必先走进录入页；
           这一格是「人已经在录入页了，改成说的」——
           录入页是「记一件东西」这一动作的主场，它上面没有语音入口才奇怪。 */
        right={
          <IconButton
            icon="mic-outline"
            accessibilityLabel="语音录入"
            onPress={() => router.push('/voice')}
          />
        }
      />

      {loading ? (
        <Loading />
      ) : (
        <ItemForm
          key={formKey}
          categories={categoryState.data}
          cabinets={cabinetState.data}
          defaults={{ locationId: effectiveLocation }}
          submitLabel="保存并录下一件"
          secondaryLabel="保存并完成"
          onSubmit={handleSubmit}
          submitting={submitting}
          onAiRecognize={recognize}
        />
      )}

      <Gutter>
        <Meta color={tokens.ink4} style={{ paddingBottom: Space.md }}>
          提示：只有名称是必填的。分类会自动猜，猜错了以后能批量改。
        </Meta>
      </Gutter>

      <SupporterGateSheet visible={gateOpen} feature="ai" onClose={() => setGateOpen(false)} />
    </Screen>
  );
}
