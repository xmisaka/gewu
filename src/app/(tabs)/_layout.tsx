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

  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <TabBar {...props} badgeCount={stats.expiringCount} />}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="album" />
      <Tabs.Screen name="compose" />
      <Tabs.Screen name="alerts" />
      <Tabs.Screen name="mine" />
    </Tabs>
  );
}
