/**
 * 格物 · 界面偏好
 *
 * 借 meta 表存 UI 偏好，键统一加 `ui.` 前缀，与 schema_version 这类系统键分开。
 * 纯本地应用，没有账号也没有云端配置，偏好跟着数据库一起走：
 * 导出备份不会带上它们，恢复出厂会连偏好一起清掉 —— 这是刻意的，
 * 偏好属于「这台设备上怎么看」，不属于「我的数据」。
 */

import { getDatabase, readMeta, writeMeta } from './index';

const PREFIX = 'ui.';

/** 列表排序方式，值为 ItemSort */
export const PREF_ITEM_SORT = 'items.sort';

/** 浅色主题，值为 ThemeKey（深色档跟随系统，不存偏好） */
export const PREF_THEME = 'theme';

export async function readPref(key: string): Promise<string | null> {
  const db = await getDatabase();
  return readMeta(db, PREFIX + key);
}

export async function writePref(key: string, value: string): Promise<void> {
  const db = await getDatabase();
  await writeMeta(db, PREFIX + key, value);
}
