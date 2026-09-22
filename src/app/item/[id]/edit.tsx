/**
 * 格物 · 编辑物品
 *
 * 复用录入表单，但落库路径不同：这里是「差量更新」而不是「新建」。
 * 照片的增删也在这一层落地 —— 表单只负责声明「移除了哪些」，
 * 真正删文件必须等保存成功，否则用户取消就丢了图。
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';

import { ItemForm, type FormPayload } from '@/components/domain/ItemForm';
import { Loading , EmptyState } from '@/components/ui/feedback';
import { PageHeader, Screen } from '@/components/ui/layout';
import { IconButton } from '@/components/ui/controls';
import { listCategories } from '@/lib/db/categories';
import { getItemView, updateItem } from '@/lib/db/items';
import { listCabinetViews } from '@/lib/db/locations';
import { addPhoto, listPhotos, promotePhoto, removePhoto } from '@/lib/db/photos';
import { deleteFiles } from '@/lib/photos/pipeline';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import type { ItemView, Photo } from '@/lib/types';

export default function EditItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { bump, dataVersion } = useAppState();
  const [submitting, setSubmitting] = useState(false);

  const itemState = useAsyncData(() => getItemView(id), [id, dataVersion], null as ItemView | null);
  const photoState = useAsyncData(() => listPhotos(id), [id, dataVersion], [] as Photo[]);
  const categoryState = useAsyncData(() => listCategories(), [dataVersion], []);
  const cabinetState = useAsyncData(() => listCabinetViews(), [dataVersion], []);

  const handleSubmit = async (payload: FormPayload) => {
    setSubmitting(true);
    try {
      await updateItem(id, payload.draft);

      // 先删后加：移除的照片连同沙盒文件一起清掉
      for (const photoId of payload.removedPhotoIds) {
        const files = await removePhoto(photoId);
        deleteFiles(files);
      }
      for (const photo of payload.newPhotos) {
        await addPhoto(id, photo.filePath, photo.thumbPath);
      }
      // 找来的封面要排到最前，否则它会被追加在末尾，列表里看到的还是旧图
      if (payload.coverPath) await promotePhoto(id, payload.coverPath);

      bump();
      router.back();
    } finally {
      setSubmitting(false);
    }
  };

  const loading =
    itemState.loading || photoState.loading || categoryState.loading || cabinetState.loading;

  if (loading && !itemState.data) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  if (!itemState.data) {
    return (
      <Screen>
        <PageHeader
          title="物品不存在"
          right={<IconButton icon="close" accessibilityLabel="返回" onPress={() => router.back()} />}
        />
        <EmptyState icon="alert-circle-outline" title="它可能已被彻底删除" />
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader
        title="编辑物品"
        subtitle={itemState.data.name}
        right={<IconButton icon="close" accessibilityLabel="关闭" onPress={() => router.back()} />}
      />

      <ItemForm
        initialItem={itemState.data}
        initialPhotos={photoState.data}
        categories={categoryState.data}
        cabinets={cabinetState.data}
        submitLabel="保存修改"
        onSubmit={handleSubmit}
        submitting={submitting}
      />
    </Screen>
  );
}
