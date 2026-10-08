/**
 * 格物 · 检查更新的落盘
 *
 * 两条状态，都进 meta 表：
 *   - `update.lastCheckAt`        上次**尝试**检查的时刻（毫秒），用来做 24h 节流
 *   - `update.dismissedVersionCode` 用户点过「以后再说」的那个版本号
 *
 * 记的是「尝试」而不是「成功」：失败也占掉当天的名额。
 * 否则断网时每次冷启动都会重试一遍，既费电又没有任何收益 ——
 * 而更新提示晚一天知道，本来就不影响任何事。
 *
 * 与 `ui.*` / `lic.code` 同一档语义：**本机偏好，不进备份包、恢复出厂清掉**。
 * 「以后再说」跟着手机走而不跟着备份走，也是对的：换机之后本来就该重新问一次。
 */

import { readTimestamp, readVersionCode } from '../update/policy';
import { getDatabase, readMeta, writeMeta } from './index';

const KEY_LAST_CHECK = 'update.lastCheckAt';
const KEY_DISMISSED = 'update.dismissedVersionCode';

export interface UpdateState {
  lastCheckAt: number | null;
  dismissedVersionCode: number | null;
}

/**
 * 读两条状态。**任何异常都退化成「从没检查过」** ——
 * 库还没热起来（冷启动时这个检查比迁移还早）不该让更新检查整个挂掉，
 * 最坏后果只是多查一次网络。
 */
export async function readUpdateState(): Promise<UpdateState> {
  try {
    const db = await getDatabase();
    const [lastCheck, dismissed] = await Promise.all([
      readMeta(db, KEY_LAST_CHECK),
      readMeta(db, KEY_DISMISSED),
    ]);
    return { lastCheckAt: readTimestamp(lastCheck), dismissedVersionCode: readVersionCode(dismissed) };
  } catch {
    return { lastCheckAt: null, dismissedVersionCode: null };
  }
}

export async function writeLastCheckAt(at: number): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, KEY_LAST_CHECK, String(at));
}

export async function writeDismissedVersionCode(code: number): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, KEY_DISMISSED, String(code));
}
