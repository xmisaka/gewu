/**
 * 格物 · 根布局
 *
 * 结构：Stack
 *   ├─ (tabs)            五个底部标签页
 *   ├─ item/[id]         物品详情
 *   ├─ item/[id]/edit    编辑（复用录入表单）
 *   ├─ item/[id]/duplicate  复制为新物品（同一张表单，落的是新记录）
 *   ├─ cabinet/[id]      柜内格位
 *   ├─ category          分类管理
 *   └─ trash             回收站
 *
 * 分类与位置**选择器**刻意不做成路由，而是录入页内的 Modal ——
 * 它们不承载独立语境，做成路由会让返回栈与表单状态纠缠。
 * 但「分类管理」是一条独立语境（改完才回去），所以它是路由。
 *
 * 启动时预热数据库（建表 + seed 内置分类），失败不阻塞界面，
 * 各页面自行展示空态或错误，比白屏更可诊断。
 * 顺带跑一次「到期就自动备份」（C4）：纯本地存储是单点故障，
 * 而 PRD 已判定「需要手动触发的备份最终会被弃用」。
 */

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { autoBackupIfDue } from '@/lib/backup/backup';
import { getDatabase } from '@/lib/db';
import { hydrateApiKey } from '@/lib/photos/stock';
import { AppStateProvider, useAppState } from '@/lib/store/app-state';
import { ThemeProvider, useTheme } from '@/lib/theme';

export default function RootLayout() {
  useEffect(() => {
    void getDatabase()
      .then(() => hydrateApiKey())
      .catch(() => {
        // 初始化错误留给具体页面处理，这里只保证不崩
      });
  }, []);

  // 外层不取主题：它包着 Provider，读不到当前主题。
  // 背景色交给内层 AppShell 与各屏的 contentStyle。
  return (
    <GestureHandlerRootView style={shell.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppStateProvider>
            <AppShell />
          </AppStateProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * 导航壳。放在 ThemeProvider 内层，才能按当前主题决定状态栏明暗与屏幕底色 ——
 * 深色主题下状态栏图标必须转白，否则在墨底上看不见。
 */
function AppShell() {
  const { isDark, tokens } = useTheme();
  const { bump } = useAppState();

  /* 自动备份挂在这里（Provider 内层）只跑一次：
     距上次备份满 7 天且数据确有过变化，就静默往本机写一份。
     真写出了东西才 bump —— 让「我的」页那行状态立刻是新的，
     没写就一点动静都不要有。整个过程不弹窗、不打断启动。 */
  useEffect(() => {
    let alive = true;
    void autoBackupIfDue()
      .then((outcome) => {
        if (alive && outcome.ran) bump();
      })
      .catch(() => {
        // 自动备份失败不值得打扰用户，下次启动还会再判断一次
      });
    return () => {
      alive = false;
    };
  }, [bump]);

  // 直接依赖 tokens（每套主题一个稳定对象），比依赖 isDark 更准确 ——
  // 它既被真实引用，引用变化也恰好等于主题变化
  const screenOptions = useMemo(
    () => ({ headerShown: false, contentStyle: { backgroundColor: tokens.canvas } }),
    [tokens],
  );

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack screenOptions={screenOptions}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="item/[id]/index" />
        <Stack.Screen name="item/[id]/edit" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen
          name="item/[id]/duplicate"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
        <Stack.Screen name="cabinet/[id]" />
        <Stack.Screen
          name="cabinet/new"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
        <Stack.Screen name="category/index" />
        <Stack.Screen name="trash" />
      </Stack>
    </>
  );
}

const shell = StyleSheet.create({
  root: { flex: 1 },
});
