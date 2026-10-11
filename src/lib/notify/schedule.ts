/**
 * 格物 · 到期提醒的落地壳
 *
 * 这一层只做四件事：**建渠道、读/请求权限、把 plan 的结果落到系统、读回已排的标识**。
 * 一个业务判断都不写在这里 —— 判断全在 `plan.ts`，那才是能被单测钉住的地方
 * （这层 import 了 expo-notifications 与 react-native，node:test 根本加载不了）。
 *
 * ★ 规矩：任何一步失败都**不抛给用户**。通知这条链路断了，录入、查找、备份一件都不少 ——
 *   与 AI 的「降级一律静默」同一条。所以这里的每个函数都只做一件事、由调用方统一兜错。
 */

import * as Notifications from 'expo-notifications';
import { useMemo } from 'react';
import { Platform } from 'react-native';

import {
  isManagedIdentifier,
  NOTIFY_CHANNEL_ID,
  type NotifyPlan,
  type PlannedNotification,
} from './plan';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/**
 * 建通知渠道。
 *
 * ★ Android 8+ **没有渠道就发不出通知，而且是不报错地发不出** ——
 *   所以这一步必须发生在**打开开关**那一刻（也必须在要权限之前：
 *   Android 13 的权限框要有渠道才弹得出来）。
 *
 * ★ 重要度取 `LOW`：**不响铃、不横幅**，只安静地落进通知栏。
 *   （`DEFAULT` 在 Android 上是「响一声」的意思 —— 到期提醒不该抢这一下。
 *     想让它能响的用户，自己在系统的渠道设置里调高即可，那个旋钮归系统管。）
 *
 * ★ 渠道建完之后，**名字与描述之外都不能再改**（Android 的限制）——
 *   所以这几个值一旦发出去就是终态，改它们需要换渠道 id。
 */
export async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(NOTIFY_CHANNEL_ID, {
    name: '到期提醒',
    description: '食品药品快到期时提前几天提醒一次',
    importance: Notifications.AndroidImportance.LOW,
    enableVibrate: false,
    enableLights: false,
    vibrationPattern: null,
    showBadge: true,
  });
}

export async function readPermission(): Promise<PermissionState> {
  const { granted, status } = await Notifications.getPermissionsAsync();
  if (granted) return 'granted';
  return status === 'undetermined' ? 'undetermined' : 'denied';
}

/**
 * 请求通知权限。**只在用户打开开关时调用**，绝不在冷启动弹 ——
 * 没解释就弹框的 App，被拒之后再也问不回来（Android 13 起尤其如此）。
 * ★ 先建渠道：没有渠道，Android 13 的权限框弹不出来（表现为「点了开关没反应」）。
 */
export async function requestPermission(): Promise<PermissionState> {
  await ensureChannel();
  const { granted, status } = await Notifications.requestPermissionsAsync();
  if (granted) return 'granted';
  return status === 'undetermined' ? 'undetermined' : 'denied';
}

/** 系统里还排着的、**本 App 排的**通知标识（别人的不许碰） */
export async function listManagedScheduled(): Promise<string[]> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  return all.map((r) => r.identifier).filter(isManagedIdentifier);
}

/**
 * 撤掉本 App 排的**全部**通知。用户关掉开关时用 ——
 * 关了开关还照响，比不提醒更伤信任。
 * ★ 只按前缀撤自己的，不会误伤别处排的通知。
 */
export async function cancelAllManaged(): Promise<void> {
  for (const identifier of await listManagedScheduled()) {
    await Notifications.cancelScheduledNotificationAsync(identifier);
  }
}

async function scheduleOne(n: PlannedNotification): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    /* ★ 自己给标识：幂等全靠它（见 plan.ts 的 expiryNotificationId） */
    identifier: n.identifier,
    content: {
      title: n.title,
      body: n.body,
      /* 点通知要能回到那一件物品上 */
      data: { itemId: n.itemId },
      /* 不写 sound：Android 的声音由**渠道**的重要度决定（我方渠道是 LOW＝不响），
         这里再写一遍反而会让「渠道设置」这个用户可见的旋钮失效 */
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: n.at,
      channelId: NOTIFY_CHANNEL_ID,
    },
  });
}

/** 按 plan 执行差量：先撤、再排。撤比排先行 —— 中途失败时宁可少一条，也不要留一条错的 */
export async function applyPlan(plan: NotifyPlan): Promise<void> {
  for (const identifier of plan.cancel) {
    await Notifications.cancelScheduledNotificationAsync(identifier);
  }
  for (const item of plan.schedule) {
    await scheduleOne(item);
  }
}

/**
 * 前台收到通知时怎么办。
 *
 * 不装这个 handler 的话，通知在 App 正开着的时候可能被直接丢掉 ——
 * 而「到期提醒」恰恰可能在用户翻别的东西时到达。
 * 让它照常落进通知栏，但不出声、不叠角标。
 */
export function installForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/**
 * 「App 是被点通知拉起来的」时那次响应里的 itemId。
 *
 * ★ 冷启动这条路径必须单独处理：只在运行期挂监听器的话，从通知进 App 会停在首页，
 *   用户以为点错了。取用 `useLastNotificationResponse()`（它同时覆盖运行期与冷启动）。
 * ★ 它可能把同一条响应重复交回来，所以调用方要按 key 去重。
 */
export function useOpenedFromNotification(): { key: string; itemId: string } | null {
  const response = Notifications.useLastNotificationResponse();
  const itemId = itemIdFromResponse(response);
  const key = response?.notification.request.identifier ?? null;
  /* ★ 必须 memo：不 memo 的话每次渲染都是新对象，调用方把它放进 effect 依赖就会死循环 */
  return useMemo(() => (itemId && key ? { key, itemId } : null), [key, itemId]);
}

/** 从冷启动那次响应里取 itemId（App 是被点通知拉起来的） */
export function itemIdFromResponse(
  response: Notifications.NotificationResponse | null | undefined,
): string | null {
  const itemId = response?.notification.request.content.data?.itemId;
  return typeof itemId === 'string' && itemId.length > 0 ? itemId : null;
}
