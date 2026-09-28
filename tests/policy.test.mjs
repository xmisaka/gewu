/**
 * 备份策略单测 —— 自动备份的触发判定 + 本机备份包的保留策略。
 *
 * 为什么这两块必须单独测：它们都是「判错了不会报错，只会静默做错事」的那一类。
 *   判太松 → 每次启动都重打一遍整个照片库，低存储手机被写爆；
 *   判太紧 → 自动备份永远不会发生，而用户以为它在；
 *   保留策略差一 → 要么把唯一一份备份删掉（不可逆），要么在 cache 里堆成存储炸弹。
 * 全是纯函数，不碰文件系统与数据库，所以能直接把边界一个个钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_BACKUP_INTERVAL_DAYS,
  decideAutoBackup,
  planBackupRetention,
  summarizeBackups,
} from '../src/lib/backup/policy.ts';

const DAY = 86_400_000;
const NOW = 1_780_000_000_000;
const MB = 1024 * 1024;

/** 默认输入：有数据、从没备份过、当前指纹为 fp */
const base = {
  itemCount: 12,
  lastBackupAt: 0,
  lastFingerprint: null,
  fingerprint: 'items=12',
  now: NOW,
};

/* ------------------------------------------------------------ 触发判定 */

test('自动备份：库是空的就不备', () => {
  assert.equal(decideAutoBackup({ ...base, itemCount: 0 }), 'no-data');
  // 空库时连"从没备份过"也不该触发 —— 没有东西可备
  assert.equal(decideAutoBackup({ ...base, itemCount: 0, lastBackupAt: NOW - 30 * DAY }), 'no-data');
});

test('自动备份：从没备份过但有数据 → 该备', () => {
  assert.equal(decideAutoBackup(base), 'due');
  // 「没备份过」必须优先于「指纹没变」的判断，否则新用户永远等不到第一份
  assert.equal(decideAutoBackup({ ...base, lastFingerprint: 'items=12' }), 'due');
});

test('自动备份：不到间隔就再等 —— 哪怕数据变了', () => {
  const last = NOW - 3 * DAY;
  assert.equal(
    decideAutoBackup({ ...base, lastBackupAt: last, lastFingerprint: 'items=11' }),
    'fresh',
  );
  // 差一分钟不到 7 天，仍然算 fresh
  assert.equal(
    decideAutoBackup({
      ...base,
      lastBackupAt: NOW - (AUTO_BACKUP_INTERVAL_DAYS * DAY - 60_000),
      lastFingerprint: 'items=11',
    }),
    'fresh',
  );
});

test('自动备份：满间隔且数据动过 → 该备', () => {
  assert.equal(
    decideAutoBackup({
      ...base,
      lastBackupAt: NOW - AUTO_BACKUP_INTERVAL_DAYS * DAY,
      lastFingerprint: 'items=11',
    }),
    'due',
  );
});

test('自动备份：满间隔但数据一点没变 → 不白备一份', () => {
  assert.equal(
    decideAutoBackup({
      ...base,
      lastBackupAt: NOW - 30 * DAY,
      lastFingerprint: base.fingerprint,
    }),
    'unchanged',
  );
  // 上次备份时没记下指纹（老版本升上来）→ 无从比较，按"该备"处理，宁可多留一份
  assert.equal(
    decideAutoBackup({ ...base, lastBackupAt: NOW - 30 * DAY, lastFingerprint: null }),
    'due',
  );
});

test('自动备份：时间戳落在未来（改过系统时间）按"刚备份过"处理', () => {
  assert.equal(
    decideAutoBackup({ ...base, lastBackupAt: NOW + 5 * DAY, lastFingerprint: 'items=1' }),
    'fresh',
  );
});

/* ------------------------------------------------------------ 保留策略 */

/** 造一组备份包，名字里的序号越大越新 */
function backups(sizesMB) {
  return sizesMB.map((mb, i) => ({
    name: `格物-备份-202609${String(10 + i).padStart(2, '0')}-0900.zip`,
    bytes: mb * MB,
  }));
}

/** 从文件名里取「日」，用来断言留下的是哪几份（前缀 6 个字 + 年月 4 位） */
function dayOf(name) {
  return name.slice(12, 14);
}

test('保留策略：空目录返回空计划', () => {
  const plan = planBackupRetention([], { maxFiles: 3, maxBytes: 400 * MB });
  assert.deepEqual(plan, { keep: [], remove: [] });
});

test('保留策略：超份数时留新的、删旧的', () => {
  const plan = planBackupRetention(backups([10, 10, 10, 10, 10]), {
    maxFiles: 3,
    maxBytes: 400 * MB,
  });
  assert.equal(plan.keep.length, 3);
  assert.equal(plan.remove.length, 2);
  // 留下的是最新的三份（名字里的序号 04 / 03 / 02）
  assert.deepEqual(
    plan.keep.map((f) => dayOf(f.name)),
    ['14', '13', '12'],
  );
  assert.deepEqual(
    plan.remove.map((f) => dayOf(f.name)),
    ['11', '10'],
  );
});

test('保留策略：字节预算比份数先到就先按预算淘汰', () => {
  // 每份 100MB、预算 250MB：留得下两份，第三份就超了
  const plan = planBackupRetention(backups([100, 100, 100]), {
    maxFiles: 10,
    maxBytes: 250 * MB,
  });
  assert.equal(plan.keep.length, 2);
  assert.equal(plan.remove.length, 1);
  assert.equal(dayOf(plan.keep[0].name), '12');
});

test('保留策略：至少留一份 —— 单份就超预算也留着', () => {
  const plan = planBackupRetention(backups([900]), { maxFiles: 3, maxBytes: 400 * MB });
  assert.equal(plan.keep.length, 1);
  assert.equal(plan.remove.length, 0);
});

test('保留策略：只留一份（手动清理的口径）', () => {
  const plan = planBackupRetention(backups([1, 2, 3]), {
    maxFiles: 1,
    maxBytes: 400 * MB,
  });
  assert.equal(plan.keep.length, 1);
  assert.equal(dayOf(plan.keep[0].name), '12');
  assert.equal(plan.remove.length, 2);
});

test('保留策略：入参顺序不影响结果（名字本身就是时间序）', () => {
  const files = backups([10, 10, 10]);
  const shuffled = [files[1], files[2], files[0]];
  const plan = planBackupRetention(shuffled, { maxFiles: 2, maxBytes: 400 * MB });
  assert.deepEqual(
    plan.keep.map((f) => dayOf(f.name)),
    ['12', '11'],
  );
});

test('备份合计：份数与字节都算对', () => {
  assert.deepEqual(summarizeBackups([]), { count: 0, bytes: 0 });
  assert.deepEqual(summarizeBackups(backups([3, 4])), { count: 2, bytes: 7 * MB });
});
