/**
 * 格物 · 激活码的落盘
 *
 * 存哪儿：meta 表（键 `lic.` 前缀），**不引入 AsyncStorage** ——
 * 它是原生模块，为了存一个字符串多加一个原生依赖不划算，
 * 而 App 早就有 meta 表与读写封装（`ui.*` 偏好走的是同一条路）。
 *
 * 语义与 `ui.*` 偏好一致：**不进备份包、恢复出厂会一起清掉**。
 * 这是刻意的 —— 码本来就不绑设备，换机把同一串再粘一次即可；
 * 反过来，把激活状态藏进备份包，等于让「恢复一份旧备份」就能回退授权。
 *
 * 只存码，不存解出来的档位：档位每次启动重新验签算出来，
 * 这样换公钥会自动生效，也不会留下与公钥对不上的陈旧授权。详见 lib/entitlement.ts。
 */

import { entitlementFromCode, type Entitlement } from '../entitlement';
import { getDatabase, readMeta, writeMeta } from './index';

const KEY_CODE = 'lic.code';

export async function loadEntitlement(): Promise<Entitlement> {
  const db = await getDatabase();
  return entitlementFromCode(await readMeta(db, KEY_CODE));
}

export async function saveEntitlementCode(code: string): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, KEY_CODE, code);
}

/** 清掉激活。目前没有界面入口 —— 留它是为了「换公钥 / 排查问题」时不必手动改库 */
export async function clearEntitlementCode(): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, KEY_CODE, '');
}
