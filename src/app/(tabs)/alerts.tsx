/**
 * 格物 · 到期提醒
 *
 * V1 只做应用内清单，不做系统推送（见 PRD 8.2 推迟项）。
 * 因此这一页的定位是「打开就看见」，而不是「追着你跑」——
 * 顶部文案必须诚实说明这一点，否则用户会以为不提醒是坏了。
 */

import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';

import { ItemRow } from '@/components/domain/ItemRow';
import { EmptyState, Loading } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen } from '@/components/ui/layout';
import { Label, Meta } from '@/components/ui/typography';
import { GUTTER, Palette, Space } from '@/constants/theme';
import { listExpiring } from '@/lib/db/items';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import type { ExpiringGroup } from '@/lib/types';
import { makeStyles } from '@/lib/theme';

export default function AlertsScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { dataVersion } = useAppState();

  const state = useAsyncData(() => listExpiring(), [dataVersion], [] as ExpiringGroup[]);

  const actionable = useMemo(
    () => state.data.filter((g) => g.key !== 'later' && g.items.length > 0),
    [state.data],
  );
  const totalTagged = useMemo(() => state.data.reduce((sum, g) => sum + g.items.length, 0), [state.data]);

  return (
    <Screen>
      <PageHeader
        title="到期"
        subtitle={
          totalTagged > 0
            ? `共 ${totalTagged} 件填了过期时间`
            : '给食品、药品、耗材填上过期时间，这里就会列出来'
        }
      />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Gutter>
          <Card tone="inset" style={styles.notice}>
            <Meta tone="ink2" style={styles.noticeText}>
              V1 不会主动推送通知，打开这一页即可查看。系统级提醒计划在后续版本加入。
            </Meta>
          </Card>
        </Gutter>

        {state.loading ? (
          <Loading />
        ) : totalTagged === 0 ? (
          <EmptyState
            icon="notifications-outline"
            title="没有需要盯着的物品"
            description="录入时给食品药品填上过期时间，这里会自动按紧急程度排好。"
            actionLabel="去录入"
            onAction={() => router.push('/compose')}
          />
        ) : (
          <>
            {actionable.map((group) => (
              <View key={group.key} style={styles.group}>
                <Gutter>
                  <View style={styles.groupHead}>
                    <Label
                      color={group.key === 'overdue' ? Palette.clay : Palette.amber}
                      style={styles.groupTitle}>
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
                    />
                  ))}
                </Card>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const useStyles = makeStyles((Palette) => ({
  scroll: { paddingBottom: 120 },
  notice: { padding: Space.md },
  noticeText: { lineHeight: 20 },
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
