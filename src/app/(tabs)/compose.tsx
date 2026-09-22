/**
 * 格物 · 录入页（连续录入）
 *
 * V1 成败的关键页。用户能不能坚持记下去，九成取决于这一屏的操作量。
 * 因此主按钮是「保存并录下一件」而不是「完成」—— 界面要推着用户往前走，
 * 而不是引导他退出。保存后自动沿用刚才的位置与分类。
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';

import { ItemForm, type FormPayload } from '@/components/domain/ItemForm';
import { Loading } from '@/components/ui/feedback';
import { Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { Meta } from '@/components/ui/typography';
import { Space } from '@/constants/theme';
import { listCategories } from '@/lib/db/categories';
import { createItem } from '@/lib/db/items';
import { listCabinetViews, lastUsedLocationId } from '@/lib/db/locations';
import { addPhoto, promotePhoto } from '@/lib/db/photos';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
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

  const categoryState = useAsyncData(() => listCategories(), [dataVersion], []);
  const cabinetState = useAsyncData(() => listCabinetViews(), [dataVersion], []);

  // 首次进入时，沿用上次用过位置；之后沿用本次会话中刚录的位置
  const lastLocationState = useAsyncData(() => lastUsedLocationId(), [], null as string | null);
  const effectiveLocation = defaultLocationId ?? lastLocationState.data;

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
        />
      )}

      <Gutter>
        <Meta color={tokens.ink4} style={{ paddingBottom: Space.md }}>
          提示：只有名称是必填的。分类会自动猜，猜错了以后能批量改。
        </Meta>
      </Gutter>
    </Screen>
  );
}
