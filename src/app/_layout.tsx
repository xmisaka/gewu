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
 *   ├─ trash             回收站
 *   ├─ supporter         支持者（未激活＝贴码页；已激活＝状态页）
 *   ├─ voice             语音录入（说一句话 → 结构化预览 → 待确认）
 *   ├─ ai                AI 助手设置（总开关 / Key / 模型 / 用量；我的 → 整理）
 *   └─ ask               问一问（本机检索 + 模型措辞；01 屏搜索框右侧星标）
 *
 * 分类与位置**选择器**刻意不做成路由，而是录入页内的 Modal ——
 * 它们不承载独立语境，做成路由会让返回栈与表单状态纠缠。
 * 但「分类管理」是一条独立语境（改完才回去），所以它是路由。
 *
 * 启动时预热数据库（建表 + seed 内置分类），失败不阻塞界面，
 * 各页面自行展示空态或错误，比白屏更可诊断。
 * 顺带跑一次「到期就自动备份」（C4）：纯本地存储是单点故障，
 * 而 PRD 已判定「需要手动触发的备份最终会被弃用」。
 * 再顺带查一次更新（24h 节流，见 lib/store/update）—— 不上商店之后，
 * 这条通道是用户唯一能知道「有新版本」的途径。
 */

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { UpdateSheet } from '@/components/domain/UpdateSheet';
import { autoBackupIfDue } from '@/lib/backup/backup';
import { getDatabase } from '@/lib/db';
import { hydrateApiKey } from '@/lib/photos/stock';
import { AiProvider } from '@/lib/store/ai';
import { AppStateProvider, useAppState } from '@/lib/store/app-state';
import { EntitlementProvider } from '@/lib/store/entitlement';
import { UpdateProvider, useUpdate } from '@/lib/store/update';
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
  //
  // 权益必须包在主题外层：主题运行时要用它判断「这套配色当前能不能用」，
  // 顺序反了会在 useTheme 里读到未初始化的权益上下文。
  //
  // AI 运行时（Key / 开关 / 用量）读的是本机 meta，与主题、权益都没有依赖关系，
  // 放在这里只是因为它要包住所有页面 —— 冷启动读一次就位，之后各屏直接订阅。
  return (
    <GestureHandlerRootView style={shell.root}>
      <SafeAreaProvider>
        <EntitlementProvider>
          <ThemeProvider>
            <AppStateProvider>
              <AiProvider>
                <UpdateProvider>
                  <AppShell />
                </UpdateProvider>
              </AiProvider>
            </AppStateProvider>
          </ThemeProvider>
        </EntitlementProvider>
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
  /* 更新弹窗挂在根上（而不是「我的」页里）：
     冷启动那次检查的结果要在任何页面都能弹出来，而它只该有一份实例 */
  const { sheetOpen, manifest, local, remindLater, closeSheet } = useUpdate();

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
        <Stack.Screen name="supporter" />
        <Stack.Screen name="voice" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        {/* AI 设置与问一问都走普通压栈：它们是从某个页面进去、
            办完事就返回的独立语境，不像 voice 那样需要压在列表上临时进行 */}
        <Stack.Screen name="ai" />
        <Stack.Screen name="ask" />
      </Stack>

      <UpdateSheet
        visible={sheetOpen}
        manifest={manifest}
        local={local}
        onRemindLater={remindLater}
        onDownloaded={closeSheet}
      />
    </>
  );
}

const shell = StyleSheet.create({
  root: { flex: 1 },
});
