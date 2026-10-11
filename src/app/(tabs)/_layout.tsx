/**
 * 格物 · 标签页布局
 *
 * 用 expo-router 的经典 Tabs + 完全自定义的 TabBar。
 * 不用 NativeTabs：它无法承载暖棕纸感的设计语言与中央突起按钮，
 * 且仍是 unstable API。
 */

import { Tabs } from 'expo-router';

import TabBar from '@/components/TabBar';
import { useAppState } from '@/lib/store/app-state';

export default function TabsLayout() {
  const { stats } = useAppState();

  /* 角标走「待办口径」（attentionCount）而不是「到期口径」（expiringCount）：
     提醒页现在还会列出「该补货了」，角标必须和那一页里的行数对得上，
     否则点进去会少一件。首页统计卡里的「即将到期」仍用到期口径，标签写的就是这一个。 */
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <TabBar {...props} badgeCount={stats.attentionCount} />}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="album" />
      <Tabs.Screen name="alerts" />
      <Tabs.Screen name="mine" />
      {/* ★ 录入页不在这里 —— 2026-10-11 挪到了根 Stack（`app/compose.tsx`）。
          tab 不压栈，从柜子详情进来录完一件后返回会落到第一格（我的物品）
          而不是那个柜子；位置默认值也带不过来来源柜子。
          它仍然占着底部中央那一格，只是由 TabBar 用 push 打开 —— 见 components/TabBar.tsx。 */}
    </Tabs>
  );
}
