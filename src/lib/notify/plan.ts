/**
 * 格物 · 到期提醒的排期算法
 *
 * 「把接下来的到期日排成一批本地通知」—— 这一层是**纯函数**：
 * 不 import expo / react-native / db，输入「物品 + 提前天数 + 现在时刻 + 已排的通知」，
 * 输出「要撤哪些 / 要排哪些」。
 *
 * ★ 为什么单独拆出来：这一层判错了**不报错**。少排一条是「该响的没响」，
 *   多排一条是「响了一件不相干的东西」，撤错了是「通知凭空消失」——
 *   三种症状都只在用户那边、过几天才被发现。所以它必须能被单测直接钉住，
 *   与 `decideAutoBackup`、`planBackupRetention` 同一个道理。
 *
 * 幂等的做法是**差量**而不是「全部推倒重来」：全推倒的话，万一中途失败，
 * 之前排好的提醒会一起没掉。
 */

import { formatDateCN, parseDate, toDateString } from '../date';

/** 我们排的通知都带这个前缀 —— 只动自己排的，不碰别人的 */
export const NOTIFY_ID_PREFIX = 'gewu-exp-';

/**
 * 一次最多排这么多条（**取时间最近的**，不是「多少天内的」）。
 *
 * 系统对每应用的 Alarm 有数量上限；而「排到三年后的那瓶酱油」既没用又占额度。
 * 超出的那些不是丢了 —— 每次 App 启动/改数据都会重排，前面的到期处理掉之后后面的自然补进来。
 */
export const MAX_SCHEDULED = 30;

/** 提醒时刻固定本地 9 点。不做设置项 —— 少一个旋钮，少一类「为什么没响」的疑问。 */
export const NOTIFY_HOUR = 9;

/** 提前几天。0 ＝ 到期当天。 */
export const LEAD_DAY_OPTIONS = [0, 1, 3, 7] as const;
export type LeadDays = (typeof LEAD_DAY_OPTIONS)[number];

export const DEFAULT_LEAD_DAYS: LeadDays = 3;

/** 通知渠道 id。Android 8+ 没有渠道就发不出通知，而且是不报错地发不出。 */
export const NOTIFY_CHANNEL_ID = 'gewu-expiry';

export function isLeadDays(value: unknown): value is LeadDays {
  return typeof value === 'number' && (LEAD_DAY_OPTIONS as readonly number[]).includes(value);
}

/**
 * 开关缺省：**只有 '1' 才算开，其余（含读不到）一律当关**。
 *
 * ★★ 这一条与「检查更新」的 `update.autoCheck`（`value !== '0'`，读不到当开）**正好反着**，
 *    两条都要记牢：
 *      · 更新检查读不到当**开** —— 写反了会让老用户**静默**失去更新提示；
 *      · 通知读不到当**关** —— 打开它要**弹系统权限框**，那是用户的决定，不能替他做。
 */
export function readNotifyEnabled(raw: string | null | undefined): boolean {
  return raw === '1';
}

/**
 * 把从库里读出来的字符串收敛成一个合法档位。
 * 读不到、读到脏值一律回落到默认 —— **不报错**，只是用默认值。
 */
export function clampLeadDays(raw: string | null | undefined): LeadDays {
  if (raw == null) return DEFAULT_LEAD_DAYS;
  const text = String(raw).trim();
  /* ★ 空串要当「没存」而不是「0」—— `Number('')` 是 0，而 0 恰好是个合法档位
     （提前 0 天＝到期当天）。不先挡这一下，库里那个空值会**静默**变成「当天提醒」。 */
  if (text === '') return DEFAULT_LEAD_DAYS;
  const n = Number(text);
  return isLeadDays(n) ? n : DEFAULT_LEAD_DAYS;
}

/** 排期用得到的那几个字段。刻意不用 `ItemView` —— 纯逻辑层不依赖视图模型 */
export interface ExpiryCandidate {
  id: string;
  name: string;
  /** `YYYY-MM-DD` */
  expireDate: string;
  /** 格位所属的柜子名；物品只挂在柜子上时为 null */
  cabinetName?: string | null;
  locationName?: string | null;
}

export interface PlannedNotification {
  identifier: string;
  itemId: string;
  title: string;
  body: string;
  /** 触发时刻（本地毫秒时间戳） */
  at: number;
}

export interface NotifyPlan {
  /** 要从系统里撤掉的标识 */
  cancel: string[];
  /** 要新排（或重排）的通知 */
  schedule: PlannedNotification[];
  /**
   * 这一轮跑完之后，系统里**应当**排着的那批（按时间升序，含已经在排的）。
   *
   * 给界面用的：「已排 N 条 · 最近一条 10-14」直接读它，不必再回系统查一遍
   * （也不必去解析标识里编着的日期 —— 那是另一种会分叉的真相来源）。
   */
  kept: PlannedNotification[];
}

/**
 * 通知标识把**到期日与提前天数都编进去**。
 *
 * ★ 这是这一层最省事的一个决定：用户改了到期日、或者把「提前几天」从 3 改成 1，
 *   标识自然就变了 —— 旧的那条落进「要撤的」集合，新的落进「要排的」集合。
 *   于是幂等判据不用再写一套「内容比对」，也就不会出现「旧通知还在、内容是老的」这种
 *   既不报错又很难查的错。
 */
export function expiryNotificationId(
  itemId: string,
  expireDate: string,
  leadDays: LeadDays,
): string {
  return `${NOTIFY_ID_PREFIX}${itemId}-${expireDate}-d${leadDays}`;
}

/** 这条已排的通知是本 App 排的吗（不能误撤别人/别处排的） */
export function isManagedIdentifier(identifier: string): boolean {
  return identifier.startsWith(NOTIFY_ID_PREFIX);
}

/**
 * 触发时刻 = 到期日往前 `leadDays` 天的 **本地 9 点**。
 * 到期日读不出来 → null（调用方直接跳过，不报错）。
 *
 * ★ 用逐段解析出来的本地 Date 再改，不走 `new Date(str)`：后者在部分引擎上按 UTC 解析，
 *   会整体差一天（`lib/date.ts` 的 `parseDate` 已经处理过这个坑）。
 */
export function triggerAt(expireDate: string, leadDays: LeadDays): number | null {
  const d = parseDate(expireDate);
  if (!d) return null;
  /* ★ 回环校验：`2026-13-40` 这种越界日期能过正则，`new Date(2026, 12, 40)` 不会变 NaN，
     而是**悄悄进位**成 2027-02-09 —— 于是通知会在一个莫名其妙的日期响。
     把解析结果再写回字符串比一遍，是最省事也最不可能漏的判据。 */
  if (toDateString(d) !== expireDate.trim()) return null;
  d.setDate(d.getDate() - leadDays);
  d.setHours(NOTIFY_HOUR, 0, 0, 0);
  return d.getTime();
}

/**
 * 位置短语：「厨房柜 第二格」。
 * 柜子名与格位名相同时只说一次 —— 物品直接挂在柜子上时，两者会是同一个名字。
 */
export function locationPhrase(
  cabinetName?: string | null,
  locationName?: string | null,
): string | null {
  const cab = cabinetName?.trim() || null;
  const loc = locationName?.trim() || null;
  if (!cab && !loc) return null;
  if (!cab) return loc;
  if (!loc || loc === cab) return cab;
  return `${cab} ${loc}`;
}

function titleFor(name: string, leadDays: LeadDays): string {
  return leadDays === 0 ? `今天到期 · ${name}` : `还有 ${leadDays} 天到期 · ${name}`;
}

function bodyFor(expireDate: string, cabinetName?: string | null, locationName?: string | null): string {
  const where = locationPhrase(cabinetName, locationName);
  return where ? `到期日 ${formatDateCN(expireDate)} · ${where}` : `到期日 ${formatDateCN(expireDate)}`;
}

/**
 * 算出这一轮要撤哪些、要排哪些。
 *
 * 不排的两种情况：
 *   · 到期日读不出来（脏数据，静默跳过）；
 *   · 提醒时刻已经过去 —— **不补排**。补排的后果是「一开开关就弹一堆」，
 *     而那些物品本来就在提醒页里列着（用户此刻正看着这台手机）。
 */
export function planExpiryNotifications(input: {
  items: ExpiryCandidate[];
  leadDays: LeadDays;
  /** 现在（毫秒时间戳）。传进来而不是在函数里取，才能被单测钉住 */
  now: number;
  /** 系统里已排的通知标识（调用方从 getAllScheduledNotificationsAsync 里取） */
  existing: string[];
  maxCount?: number;
}): NotifyPlan {
  const { items, leadDays, now, existing, maxCount = MAX_SCHEDULED } = input;

  const desired: PlannedNotification[] = [];
  for (const item of items) {
    const at = triggerAt(item.expireDate, leadDays);
    if (at === null || at <= now) continue;
    desired.push({
      identifier: expiryNotificationId(item.id, item.expireDate, leadDays),
      itemId: item.id,
      title: titleFor(item.name, leadDays),
      body: bodyFor(item.expireDate, item.cabinetName, item.locationName),
      at,
    });
  }

  // 只留时间最近的 maxCount 条
  desired.sort((a, b) => a.at - b.at || a.identifier.localeCompare(b.identifier));
  const kept = desired.slice(0, maxCount);

  const keepIds = new Set(kept.map((k) => k.identifier));
  const existingIds = [...new Set(existing.filter(isManagedIdentifier))].sort();

  return {
    cancel: existingIds.filter((id) => !keepIds.has(id)),
    schedule: kept.filter((k) => !existingIds.includes(k.identifier)),
    kept,
  };
}

/** 「最近的提醒是几号」——「我的」页那一行要用 */
export function describeNextNotification(at: number | null): string | null {
  if (at == null) return null;
  const d = new Date(at);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
