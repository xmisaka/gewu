/**
 * 格物 · 复制为新物品
 *
 * PRD §8.1「V1 交付范围」第 4 项写的就是「连续录入、一键复制」，
 * §10 风险清单「录入疲劳（高风险）」的应对也点名要它 ——
 * 同款买第二个（线材、杯子、收纳盒）不该重填一遍全部字段。
 *
 * 为什么不复用编辑页：编辑是**差量更新**已有的那一条，这里是**新建一条**。
 * 两条路径共用时最容易出的错，是把原物品的照片一起带过来 ——
 * 两个副本共用同一份图，删掉其中一个，另一个立刻变成白框。
 * 所以照片、备注、型号、标签、排序值一律不带，只带
 * 名称 / 分类 / 位置 / 品牌 / 单价（这五项在新记录上重新填一遍的成本最高）。
 * 购买日期与过期时间也不带：那是原件的属性，抄过来持有成本就错了。
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';

import { ItemForm, type FormPayload, type ItemSeed } from '@/components/domain/ItemForm';
import { IconButton } from '@/components/ui/controls';
import { EmptyState, Loading } from '@/components/ui/feedback';
import { PageHeader, Screen } from '@/components/ui/layout';
import { listCategories } from '@/lib/db/categories';
import { createItem, getItemView } from '@/lib/db/items';
import { listCabinetViews } from '@/lib/db/locations';
import { addPhoto, promotePhoto } from '@/lib/db/photos';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import type { ItemView } from '@/lib/types';

/**
 * 原件 → 模板。**白名单**而不是黑名单：只挑这五项带过去，
 * 将来给物品加新字段时，默认行为是「不被复制」，
 * 不会因为漏删一项就把照片或备注悄悄带过来。
 */
function seedFrom(item: ItemView): ItemSeed {
  return {
    name: item.name,
    categoryId: item.categoryId,
    locationId: item.locationId,
    brand: item.brand,
    price: item.price,
    // 以下一律按「新录入」处理
    purchaseDate: null,
    expireDate: null,
    model: null,
    tags: [],
    note: null,
    sortOrder: null,
  };
}

export default function DuplicateItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { bump, dataVersion } = useAppState();
  const [submitting, setSubmitting] = useState(false);

  const itemState = useAsyncData(() => getItemView(id), [id, dataVersion], null as ItemView | null);
  const categoryState = useAsyncData(() => listCategories(), [dataVersion], []);
  const cabinetState = useAsyncData(() => listCabinetViews(), [dataVersion], []);

  const handleSubmit = async (payload: FormPayload) => {
    setSubmitting(true);
    try {
      const newId = await createItem(payload.draft);
      for (const photo of payload.newPhotos) {
        await addPhoto(newId, photo.filePath, photo.thumbPath);
      }
      if (payload.coverPath) await promotePhoto(newId, payload.coverPath);

      bump();
      /* 落到**新**物品的详情页：用户刚确认下来的是这一件新记录，
         回到原件详情反而会让人以为没存上。返回键从原件详情回去。 */
      router.replace({ pathname: '/item/[id]', params: { id: newId } });
    } finally {
      setSubmitting(false);
    }
  };

  const loading = itemState.loading || categoryState.loading || cabinetState.loading;

  /* 三个都加载完才渲染表单：预填逻辑要读分类的默认保质期，
     而 useState 的初值只算一次 —— 先拿空分类渲染再补数据，那份默认保质期就永远补不上了。 */
  if (loading) {
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
        title="复制为新物品"
        subtitle="名称、分类、位置、品牌、单价已带过；照片与备注不带"
        right={<IconButton icon="close" accessibilityLabel="关闭" onPress={() => router.back()} />}
      />

      <ItemForm
        prefill={seedFrom(itemState.data)}
        categories={categoryState.data}
        cabinets={cabinetState.data}
        submitLabel="保存这件副本"
        onSubmit={handleSubmit}
        submitting={submitting}
      />
    </Screen>
  );
}
