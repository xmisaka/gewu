/**
 * 格物 · 检查更新的落盘
 *
 * 三条状态，都进 meta 表：
 *   - `update.lastCheckAt`        上次**尝试**检查的时刻（毫秒），用来做 24h 节流
 *   - `update.dismissedVersionCode` 用户点过「以后再说」的那个版本号
 *   - `update.autoCheck`          自动检查总开关（'0' = 关，其余/缺失 = 开）
 *
 * 记的是「尝试」而不是「成功」：失败也占掉当天的名额。
 * 否则断网时每次冷启动都会重试一遍，既费电又没有任何收益 ——
 * 而更新提示晚一天知道，本来就不影响任何事。
 *
 * 与 `ui.*` / `lic.code` 同一档语义：**本机偏好，不进备份包、恢复出厂清掉**。
 * 「以后再说」跟着手机走而不跟着备份走，也是对的：换机之后本来就该重新问一次。
 */

import { readAutoCheck, readTimestamp, readVersionCode } from '../update/policy';
import { getDatabase, readMeta, writeMeta } from './index';

const KEY_LAST_CHECK = 'update.lastCheckAt';
const KEY_DISMISSED = 'update.dismissedVersionCode';
const KEY_AUTO_CHECK = 'update.autoCheck';

export interface UpdateState {
  lastCheckAt: number | null;
  dismissedVersionCode: number | null;
  /** 自动检查总开关。读不到 = true（默认开，见 policy 的 readAutoCheck） */
  autoCheck: boolean;
}

/**
 * 读三条状态。**任何异常都退化成「从没检查过 + 开关是开的」** ——
 * 库还没热起来（冷启动时这个检查比迁移还早）不该让更新检查整个挂掉，
 * 最坏后果只是多查一次网络。
 */
export async function readUpdateState(): Promise<UpdateState> {
  try {
    const db = await getDatabase();
    const [lastCheck, dismissed, autoCheck] = await Promise.all([
      readMeta(db, KEY_LAST_CHECK),
      readMeta(db, KEY_DISMISSED),
      readMeta(db, KEY_AUTO_CHECK),
    ]);
    return {
      lastCheckAt: readTimestamp(lastCheck),
      dismissedVersionCode: readVersionCode(dismissed),
      autoCheck: readAutoCheck(autoCheck),
    };
  } catch {
    return { lastCheckAt: null, dismissedVersionCode: null, autoCheck: true };
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

export async function writeAutoCheck(on: boolean): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, KEY_AUTO_CHECK, on ? '1' : '0');
}

/**
 * 抹掉「上次检查时刻」。
 *
 * 重新打开自动检查时一定要调它：否则用户刚把开关拨开，
 * 还要等满 24 小时的下一个窗口才查得到 —— 看起来就像开关没生效，
 * 而他没有任何办法验证它到底有没有用。
 * 清掉之后，下一次冷启动立即开网（手动检查本来就不受节流影响）。
 */
export async function clearLastCheckAt(): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, KEY_LAST_CHECK, '');
}
