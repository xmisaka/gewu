/**
 * 格物 · 提醒偏好的仓储
 *
 * 键直接放 meta 表（`notify.*` 命名空间），**不进备份包、恢复出厂清掉** ——
 * 沿用既有约定：偏好属于「这台设备上怎么提醒我」，不属于「我的数据」。
 *
 * 与 `db/update.ts` 同一个写法：这里只负责「读出来 / 写回去」，
 * 「读不到算开还是算关」那个判断放在 `notify/plan.ts` 里（纯函数，能被单测钉住）。
 */

import {
  clampLeadDays,
  readNotifyBadge,
  readNotifyEnabled,
  type ExpiryCandidate,
  type LeadDays,
} from '../notify/plan';
import { getDatabase, readMeta, writeMeta } from './index';
import { listExpiring } from './items';

const KEY_ENABLED = 'notify.expiry';
const KEY_LEAD_DAYS = 'notify.leadDays';
const KEY_BADGE = 'notify.badge';

export interface NotifyPrefs {
  enabled: boolean;
  leadDays: LeadDays;
  /** 「提醒」标签上那个待办角标数字要不要显示 */
  badge: boolean;
}

export async function readNotifyPrefs(): Promise<NotifyPrefs> {
  const db = await getDatabase();
  const [enabled, leadDays, badge] = await Promise.all([
    readMeta(db, KEY_ENABLED),
    readMeta(db, KEY_LEAD_DAYS),
    readMeta(db, KEY_BADGE),
  ]);
  return {
    enabled: readNotifyEnabled(enabled),
    leadDays: clampLeadDays(leadDays),
    badge: readNotifyBadge(badge),
  };
}

export async function writeNotifyEnabled(on: boolean): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, KEY_ENABLED, on ? '1' : '0');
}

export async function writeNotifyLeadDays(days: LeadDays): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, KEY_LEAD_DAYS, String(days));
}

export async function writeNotifyBadge(on: boolean): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, KEY_BADGE, on ? '1' : '0');
}

/**
 * 排期要的候选。
 *
 * ★ **复用 `listExpiring()`**，不新写查询：它已经是「全部带 `expire_date` 的物品、
 *   按到期日升序」，展开成 overdue → soon → later 恰好仍是日期升序；
 *   而且走的是 `SELECT_VIEW`（全显式列名），不会踩 `SELECT *` 那个静默坑。
 */
export async function listExpiryCandidates(): Promise<ExpiryCandidate[]> {
  const groups = await listExpiring();
  return groups.flatMap((g) => g.items).map((it) => ({
    id: it.id,
    name: it.name,
    expireDate: it.expireDate ?? '',
    cabinetName: it.cabinetName,
    locationName: it.locationName,
  }));
}
