/**
 * 格物 · 根布局
 *
 * 结构：Stack
 *   ├─ (tabs)            五个底部标签页
 *   ├─ compose           录入（底部中央按钮压栈打开，**不再是 tab** —— 见下）
 *   ├─ item/[id]         物品详情
 *   ├─ item/[id]/edit    编辑（复用录入表单）
 *   ├─ item/[id]/duplicate  复制为新物品（同一张表单，落的是新记录）
 *   ├─ cabinet/[id]      柜内格位
 *   ├─ category          分类管理
 *   ├─ trash             回收站
 *   ├─ supporter         支持者（未激活＝贴码页；已激活＝状态页）
 *   ├─ pro               支持者权益说明（未激活＝值不值；已激活＝我的权益）
 *   ├─ voice             语音录入（说一句话 → 结构化预览 → 待确认）
 *   ├─ batch             批量识图（一次选多张 → 逐张识别 → 清单核对 → 一次入库）
 *   ├─ ai                AI 助手设置（总开关 / Key / 模型 / 用量；我的 → 整理）
 *   └─ ask               问一问（本机检索 + 模型措辞；01 屏搜索框右侧星标）
 *
 * 分类与位置**选择器**刻意不做成路由，而是录入页内的 Modal ——
 * 它们不承载独立语境，做成路由会让返回栈与表单状态纠缠。
 * 但「分类管理」是一条独立语境（改完才回去），所以它是路由。
 *
 * ★ 录入页（`compose`）曾经是 `(tabs)` 里的第五格，2026-10-11 挪到这里。
 *   原因是 **tab 不压栈**：从柜子详情 push 进去等于切 tab，返回键会落到第一格
 *   （我的物品），回不到那个柜子；来源柜子也没处可带。
 *   挪成 Stack 路由后两件事都自然成立 —— 详情见 `app/compose.tsx` 文件头。
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
import { WidgetSync } from '@/components/domain/WidgetSync';
import { autoBackupIfDue } from '@/lib/backup/backup';
import { getDatabase } from '@/lib/db';
import { hydrateApiKey } from '@/lib/photos/stock';
import { AiProvider } from '@/lib/store/ai';
import { AppStateProvider, useAppState } from '@/lib/store/app-state';
import { EntitlementProvider } from '@/lib/store/entitlement';
import { NotifyProvider } from '@/lib/store/notify';
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
              {/* 到期提醒的运行时：要读 `dataVersion` 才知道「数据变了、该重排通知了」，
                  所以必须在 AppStateProvider 内层。它不依赖主题与权益。 */}
              <NotifyProvider>
                <AiProvider>
                  <UpdateProvider>
                    <AppShell />
                  </UpdateProvider>
                </AiProvider>
              </NotifyProvider>
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
        {/* 录入页。走普通压栈（不是 modal）：它是「记一件东西」的主场，
            压在来处那一屏之上，返回即回到来处 */}
        <Stack.Screen name="compose" />
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
        {/* 权益说明页。与 supporter 分家：那一页管「码」，这一页管「权益」。
            门控浮层、「我的」页、激活页三处入口都汇聚到这里 ——
            此前权益只在「你被挡住」的语境里露一角，用户拼不出全貌。 */}
        <Stack.Screen name="pro" />
        <Stack.Screen name="voice" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        {/* AI 设置与问一问都走普通压栈：它们是从某个页面进去、
            办完事就返回的独立语境，不像 voice 那样需要压在列表上临时进行 */}
        <Stack.Screen name="ai" />
        <Stack.Screen name="ask" />
        {/* 批量识图：从录入页右上角进来，选一批照片 → 逐张识别 → 清单核对 → 一次入库。
            与 voice 同属「临时进行的一项操作」，压在录入页上比普通压栈更贴合语境。 */}
        <Stack.Screen
          name="batch"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
        {/* 批量识图的「详细编辑」：新开一页复用 `ItemForm`（清单行装不下整张表单）。
            同样走 modal —— 它是「从清单里临时进去改一条、改完回来」的语境。 */}
        <Stack.Screen
          name="batch/item"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
      </Stack>

      {/* 桌面小组件的快照同步。不画任何东西，只保证「数据/主题一变，
          磁盘上那份 JSON 就是新的」。真正的桌面刷新由原生在 onStop 触发 —— 
          它需要在 ThemeProvider 内层（快照要带当前主题的色值）。 */}
      <WidgetSync />

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
