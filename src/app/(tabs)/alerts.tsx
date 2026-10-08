/**
 * 格物 · 到期提醒
 *
 * V1 只做应用内清单，不做系统推送（见 PRD 8.2 推迟项）。
 * 因此这一页的定位是「打开就看见」，而不是「追着你跑」——
 * 顶部文案必须诚实说明这一点，否则用户会以为不提醒是坏了。
 *
 * 这一页现在盯两件事：**快过期的**（食品药品耗材）与**快用完的**（能补货的）。
 * 两者共用同一套分组列表与行组件，只是排在最前面的那个组换了个人。
 */

import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { ItemRow } from '@/components/domain/ItemRow';
import { EmptyState, Loading, UndoBar, type UndoAction } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Space } from '@/constants/theme';
import { adjustQuantity, listExpiring, listLowStock, setQuantity } from '@/lib/db/items';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { stockLabel } from '@/lib/stock';
import { useAppState } from '@/lib/store/app-state';
import type { ExpiringGroup } from '@/lib/types';
import { makeStyles } from '@/lib/theme';

/** 分组标题的语义色。与列表胶囊、库存卡同一套：砖红=已过期/用完，琥珀=将到期/将见底 */
function groupColor(key: ExpiringGroup['key']): string {
  if (key === 'overdue' || key === 'low') return Palette.clay;
  return Palette.amber;
}

export default function AlertsScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { dataVersion, bump } = useAppState();
  const [undo, setUndo] = useState<UndoAction | null>(null);

  const state = useAsyncData(
    async () => {
      // 两组各查一次再拼起来，而不是把 low 塞进 listExpiring ——
      // 那个函数的名字与职责是「到期」，混进库存会让它变成一个说不清的东西
      const [expiring, low] = await Promise.all([listExpiring(), listLowStock()]);
      return low.length > 0
        ? [{ key: 'low' as const, title: '该补货了', items: low }, ...expiring]
        : expiring;
    },
    [dataVersion],
    [] as ExpiringGroup[],
  );

  const actionable = useMemo(
    () => state.data.filter((g) => g.key !== 'later' && g.items.length > 0),
    [state.data],
  );

  /**
   * 「需要关注」按**去重后的件数**算。
   *
   * ★ 不能把各分组的条数直接相加：一件过期的酱油同时「已过期」又「剩 1」，
   *   会在两个组里各出现一次 —— 加出来的数字比实际件数大，而用户会拿它对总数。
   */
  const attentionCount = useMemo(() => {
    const ids = new Set<string>();
    for (const g of state.data) {
      if (g.key === 'later') continue;
      for (const it of g.items) ids.add(it.id);
    }
    return ids.size;
  }, [state.data]);

  /**
   * 顺手补一件。
   *
   * 这一页允许在行尾放一个可点控件，首页列表上却不允许 —— 差别在于**改的方向**：
   * 补一件最坏是数多了，点一下「用掉一件」就回来了；首页的 −1 是反过来的，
   * 误触就真的少一件，还得去翻撤销条。所以这里给 1 步，那里给 2 步。
   */
  const restock = useCallback(
    async (itemId: string, before: number) => {
      await adjustQuantity(itemId, 1);
      bump();
      setUndo({
        message: `已补 1 件 · ${stockLabel(before + 1)}`,
        onUndo: () => {
          void setQuantity(itemId, before).then(bump);
        },
      });
    },
    [bump],
  );

  return (
    <Screen>
      <PageHeader
        title="到期"
        subtitle={
          attentionCount > 0
            ? `共 ${attentionCount} 件需要关注`
            : '给食品、药品、耗材填上过期时间或数量，这里就会列出来'
        }
      />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Gutter>
          <Card tone="inset" style={styles.notice}>
            <Meta tone="ink2" style={styles.noticeText}>
              这一页分两件事盯着：快过期的，和快用完该补货的。
            </Meta>
            <Meta tone="ink4" style={styles.noticeText}>
              V1 不会主动推送通知，打开这一页即可查看。系统级提醒计划在后续版本加入。
            </Meta>
          </Card>
        </Gutter>

        {state.loading ? (
          <Loading />
        ) : attentionCount === 0 ? (
          <EmptyState
            icon="notifications-outline"
            title="没有需要盯着的物品"
            description="录入时给食品药品填上过期时间，或者在耗材上填个数量，这里会自动按紧急程度排好。"
            actionLabel="去录入"
            onAction={() => router.push('/compose')}
          />
        ) : (
          <>
            {actionable.map((group) => (
              <View key={group.key} style={styles.group}>
                <Gutter>
                  <View style={styles.groupHead}>
                    <Label color={groupColor(group.key)} style={styles.groupTitle}>
                      {group.title}
                    </Label>
                    <Meta tone="ink4">{group.items.length} 件</Meta>
                  </View>
                </Gutter>
                <Card padded={false} style={styles.groupCard}>
                  {group.items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      onPress={(it) => router.push({ pathname: '/item/[id]', params: { id: it.id } })}
                      /* 「补货 +」只在这一组给。其余组里的物品也能补货，
                         但那是「顺手」，不是这一页让用户来做的事 */
                      onQuickRestock={
                        group.key === 'low' && item.quantity !== null
                          ? () => void restock(item.id, item.quantity as number)
                          : undefined
                      }
                    />
                  ))}
                </Card>
              </View>
            ))}
          </>
        )}
      </ScrollView>

      <UndoBar action={undo} onDismiss={() => setUndo(null)} />
    </Screen>
  );
}

const useStyles = makeStyles((Palette) => ({
  scroll: { paddingBottom: 120 },
  notice: { padding: Space.md, gap: Space.xs },
  noticeText: { lineHeight: 19 },
  group: { marginTop: Space.xxl },
  /* 卡片左右让出边距，行的内容留白由 ItemRow 自己给 —— 与物品页保持一致 */
  groupCard: { marginHorizontal: GUTTER },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: Space.sm,
  },
  groupTitle: { fontSize: 13, fontWeight: '600', letterSpacing: 0.4 },
}));
