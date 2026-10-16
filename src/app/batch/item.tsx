/**
 * 格物 · 批量识图的「详细编辑」
 *
 * 清单行的轻量内联只够改名称与分类 / 位置；真要在入库前把型号、单价、备注
 * 这类字段一次改全，就得用完整表单 —— 而 `ItemForm` 是整页级组件，
 * **不能挂在清单行里**（它的 `draft` 只在首次挂载时取 `prefill`，
 * 清单会随识别进度重渲染、行会被重挂，用户刚改的值立刻被冲回识别初稿）。
 *
 * 所以：跳一个独立页面复用 `ItemForm`（`prefillMode="draft"`）。
 * 跳页是全新挂载，天然绕开重挂；而且它是**原生 modal presentation**，
 * 不像 RN 的 `Modal` 那样在 Android 上另起一个 Dialog 窗口（那种情形下键盘会盖住输入框，
 * 项目里已经踩过 —— 见 `ui/sheet-modal.tsx` 的头注释）。
 *
 * ★ 状态只传一条、走一次性槽（`lib/ai/batch-draft`）：
 *   取不到槽就显示一句「没有要编辑的条目」并让用户退回 ——
 *   那说明这次跳转不是从清单来的（深链 / 热重载），没有可编辑的东西。
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Image, View } from 'react-native';

import { ItemForm, type FormPayload } from '@/components/domain/ItemForm';
import { IconButton } from '@/components/ui/controls';
import { Loading } from '@/components/ui/feedback';
import { Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { Meta } from '@/components/ui/typography';
import { Radius, Space } from '@/constants/theme';
import type { BatchEditSeed } from '@/lib/ai/batch';
import { clearEditing, peekEditing, putEditResult } from '@/lib/ai/batch-draft';
import { listCategories } from '@/lib/db/categories';
import { listCabinetViews } from '@/lib/db/locations';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { photoUri } from '@/lib/photos/pipeline';
import { makeStyles } from '@/lib/theme';
import type { ItemDraft } from '@/lib/types';

export default function BatchEditScreen() {
  const styles = useStyles();
  const router = useRouter();
  /* 纯读、不清空：每次渲染都要拿到同一条（清空交给 unmount） */
  const editing = peekEditing();

  const categoryState = useAsyncData(() => listCategories(), [], []);
  const cabinetState = useAsyncData(() => listCabinetViews(), [], []);

  /* 离开这一页就把槽清掉 —— 不清的话，下次从别处深链进来会拿到上一条的残留 */
  useEffect(() => clearEditing, []);

  const apply = useCallback(
    async (payload: FormPayload) => {
      if (!editing) return;
      putEditResult({ key: editing.key, seed: seedFromDraft(payload.draft) });
      router.back();
    },
    [editing, router],
  );

  if (!editing) {
    return (
      <Screen>
        <PageHeader title="详细编辑" subtitle="没有要编辑的条目" />
        <View style={styles.center}>
          <Meta tone="ink3" style={styles.centerText}>
            这一页只能从批量识图的清单里点进来。
          </Meta>
        </View>
      </Screen>
    );
  }

  const loading = categoryState.loading || cabinetState.loading;

  return (
    <Screen>
      <PageHeader
        title="详细编辑"
        subtitle="改完点下面「应用」，回到清单再一起保存"
        right={<IconButton icon="close" accessibilityLabel="取消" onPress={() => router.back()} />}
      />
      {loading ? (
        <Loading />
      ) : (
        <ItemForm
          header={
            editing.photo ? (
              <Gutter>
                <View style={styles.thumbWrap}>
                  <Image
                    source={{ uri: photoUri(editing.photo.thumbPath) }}
                    style={styles.thumb}
                  />
                  <Meta tone="ink3">正在编辑这一件</Meta>
                </View>
              </Gutter>
            ) : undefined
          }
          prefill={{ ...editing.seed, sortOrder: null }}
          prefillMode="draft"
          /* 照片区不显示：条目还没入库，没有 photos 记录；
             这张图在清单里已经能看到了，编辑页顶部也放了一张做参照 */
          hidePhotos
          categories={categoryState.data}
          cabinets={cabinetState.data}
          submitLabel="应用到这一条"
          onSubmit={apply}
        />
      )}
    </Screen>
  );
}

/** `ItemDraft` → 槽里那份种子（只取批量条目存得下的字段） */
function seedFromDraft(d: ItemDraft): BatchEditSeed {
  return {
    name: d.name,
    categoryId: d.categoryId,
    locationId: d.locationId,
    expireDate: d.expireDate,
    warrantyUntil: d.warrantyUntil ?? null,
    brand: d.brand,
    model: d.model,
    price: d.price,
    quantity: d.quantity,
    purchaseDate: d.purchaseDate,
    tags: d.tags ?? [],
    note: d.note,
  };
}

const useStyles = makeStyles(() => ({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Space.xxl,
  },
  centerText: { textAlign: 'center', lineHeight: 21 },
  thumbWrap: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingTop: Space.sm },
  thumb: { width: 44, height: 44, borderRadius: Radius.thumb },
}));
