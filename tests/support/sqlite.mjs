/**
 * 测试支撑：用 node:sqlite 顶替 expo-sqlite。
 *
 * 目的：让 src/lib/db 下的仓储能在 Node 里对着**真的 SQLite**跑，
 * 而不是只靠 tsc 过一遍 —— SQL 是字符串，类型系统管不到它。
 *
 * 只实现仓储实际用到的那五个方法（见 db/index.ts 与各 repository）。
 * expo-sqlite 的调用签名是 `(sql, ...args)` 变参，
 * node:sqlite 的 prepare().run/get/all 也是变参，因此是一对一直通。
 */

import { DatabaseSync } from 'node:sqlite';

/** 已打开的连接，供收尾统一关闭（Windows 上句柄未关会让临时目录删不掉） */
const openHandles = [];

/** 关闭所有 shim 连接，测试收尾时调用 */
export function closeAllShimDatabases() {
  while (openHandles.length) {
    try {
      openHandles.pop().close();
    } catch {
      /* 已关闭则忽略 */
    }
  }
}

export function openShimDatabase(filePath) {
  const raw = new DatabaseSync(filePath);
  openHandles.push(raw);

  return {
    execAsync: async (sql) => {
      raw.exec(sql);
    },
    runAsync: async (sql, ...args) => raw.prepare(sql).run(...args),
    getFirstAsync: async (sql, ...args) => raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql, ...args) => raw.prepare(sql).all(...args),
    withTransactionAsync: async (fn) => {
      raw.exec('BEGIN');
      try {
        await fn();
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
