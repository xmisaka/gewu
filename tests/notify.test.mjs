/**
 * 到期提醒的排期算法 —— 纯函数单测。
 *
 * 这一层判错了**不报错**：少排一条是「该响的没响」，多排一条是「响了一件不相干的东西」，
 * 撤错了是「通知凭空消失」。三种症状都只在用户那边、过几天才被发现，
 * 所以每一条判据都在这里钉住。
 *
 * 时间一律用**本地构造**（`new Date(2026, 9, 1, 12, 0)`），不写 UTC 串 ——
 * 否则这台机器换个时区，测试会集体飘一天。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LEAD_DAYS,
  LEAD_DAY_OPTIONS,
  MAX_LEAD_DAYS,
  MAX_SCHEDULED,
  MIN_LEAD_DAYS,
  NOTIFY_ID_PREFIX,
  clampLeadDays,
  describeLeadDays,
  describeNextNotification,
  expiryNotificationId,
  isPresetLeadDays,
  isValidLeadDays,
  isManagedIdentifier,
  locationPhrase,
  planExpiryNotifications,
  readNotifyBadge,
  readNotifyEnabled,
  triggerAt,
} from '../src/lib/notify/plan.ts';

/** 本地时间构造：2026-10-01 12:00 */
const at2016 = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at2016(2026, 10, 1, 12);

const item = (over = {}) => ({
  id: 'a',
  name: '鱼油',
  expireDate: '2026-10-14',
  cabinetName: '厨房柜',
  locationName: '第二格',
  ...over,
});

/* ------------------------------------------------------------ 标识约定 */

test('标识前缀把「到期日 + 提前天数」都编进去', () => {
  assert.equal(expiryNotificationId('a', '2026-10-14', 3), 'gewu-exp-a-2026-10-14-d3');
  assert.ok(expiryNotificationId('a', '2026-10-14', 3).startsWith(NOTIFY_ID_PREFIX));

  /* ★ 改了到期日、或改了提前天数，标识必须变 —— 变不了就撤不掉旧通知 */
  assert.notEqual(expiryNotificationId('a', '2026-10-14', 3), expiryNotificationId('a', '2026-10-15', 3));
  assert.notEqual(expiryNotificationId('a', '2026-10-14', 3), expiryNotificationId('a', '2026-10-14', 1));
});

test('只认自己排的标识，别去撤别人的通知', () => {
  assert.ok(isManagedIdentifier('gewu-exp-a-2026-10-14-d3'));
  assert.ok(!isManagedIdentifier('expo-something-else'));
  assert.ok(!isManagedIdentifier(''));
});

/* ------------------------------------------------------------ 档位收敛 */

test('★ 提前天数：0~365 的整数，四个快捷档只是快捷方式', () => {
  assert.deepEqual([...LEAD_DAY_OPTIONS], [0, 1, 3, 7]);
  assert.equal(DEFAULT_LEAD_DAYS, 3);
  assert.equal(MIN_LEAD_DAYS, 0);
  assert.equal(MAX_LEAD_DAYS, 365);

  /* 快捷档 —— 只有界面拿它高亮 chip，判断逻辑一律不用它 */
  assert.ok(isPresetLeadDays(0) && isPresetLeadDays(3));
  assert.ok(!isPresetLeadDays(10));

  assert.ok(isValidLeadDays(10) && isValidLeadDays(0) && isValidLeadDays(365));
  assert.ok(!isValidLeadDays(366) && !isValidLeadDays(-1) && !isValidLeadDays(1.5));
});

test('★ clampLeadDays：读不到回默认，超范围钳到边界（不是回默认）', () => {
  assert.equal(clampLeadDays('3'), 3);
  assert.equal(clampLeadDays('10'), 10); // ★ 自定义天数
  assert.equal(clampLeadDays(10), 10);
  assert.equal(clampLeadDays('365'), 365);

  /* 用户自己填的 500，给他 365 比给他 3 更接近他的意思 */
  assert.equal(clampLeadDays('500'), 365);
  assert.equal(clampLeadDays('-3'), 0);
  assert.equal(clampLeadDays('3.7'), 3); // 小数截断

  assert.equal(clampLeadDays(null), 3);
  assert.equal(clampLeadDays(undefined), 3);
  assert.equal(clampLeadDays('abc'), 3);
  assert.equal(clampLeadDays(''), 3); // ★ 空串当「没存」，不是「当天」
  assert.equal(clampLeadDays('   '), 3);
  assert.equal(clampLeadDays(NaN), 3);
});

test('describeLeadDays：「当天」/「N 天」，界面与通知标题共用一套说法', () => {
  assert.equal(describeLeadDays(0), '当天');
  assert.equal(describeLeadDays(1), '1 天');
  assert.equal(describeLeadDays(30), '30 天');
});

test('★ 开关缺省：只有 1 才算开 —— 与「检查更新」读不到当开正好反着', () => {
  assert.equal(readNotifyEnabled('1'), true);

  assert.equal(readNotifyEnabled('0'), false);
  assert.equal(readNotifyEnabled(null), false);
  assert.equal(readNotifyEnabled(undefined), false);
  assert.equal(readNotifyEnabled(''), false);
  /* 脏值不当开：通知要弹系统权限框，不能替用户做主 */
  assert.equal(readNotifyEnabled('true'), false);
  assert.equal(readNotifyEnabled('yes'), false);
});

test('★ 角标开关缺省：只有 0 才算关 —— 与通知开关反着，和「检查更新」同向', () => {
  /* 它只是个显示偏好，缺省必须维持原样；写成 === '1' 会让老用户静默失去角标 */
  assert.equal(readNotifyBadge(null), true);
  assert.equal(readNotifyBadge(undefined), true);
  assert.equal(readNotifyBadge(''), true);
  assert.equal(readNotifyBadge('1'), true);
  assert.equal(readNotifyBadge('true'), true);

  assert.equal(readNotifyBadge('0'), false);
});

/* ------------------------------------------------------------ 触发时刻 */

test('触发时刻 = 到期日往前 N 天的本地 9 点', () => {
  assert.equal(triggerAt('2026-10-14', 3), at2016(2026, 10, 11, 9));
  assert.equal(triggerAt('2026-10-14', 0), at2016(2026, 10, 14, 9));
  assert.equal(triggerAt('2026-10-14', 7), at2016(2026, 10, 7, 9));
  /* 跨月也要对 */
  assert.equal(triggerAt('2026-11-02', 3), at2016(2026, 10, 30, 9));
  /* 跨年 */
  assert.equal(triggerAt('2027-01-02', 3), at2016(2026, 12, 30, 9));
});

test('到期日读不出来就返回 null（跳过，不报错）', () => {
  assert.equal(triggerAt('', 3), null);
  assert.equal(triggerAt('2026/10/14', 3), null);
  assert.equal(triggerAt('2026-13-40', 3), null);
});

/* ------------------------------------------------------------ 位置短语 */

test('位置短语：柜子 + 格位；同名只说一次', () => {
  assert.equal(locationPhrase('厨房柜', '第二格'), '厨房柜 第二格');
  assert.equal(locationPhrase(null, '第二格'), '第二格');
  assert.equal(locationPhrase('厨房柜', null), '厨房柜');
  /* 物品直接挂在柜子上时两者同名 —— 说两遍像结巴 */
  assert.equal(locationPhrase('厨房柜', '厨房柜'), '厨房柜');
  assert.equal(locationPhrase(null, null), null);
  assert.equal(locationPhrase('  ', '  '), null);
});

/* ------------------------------------------------------------ 排期 */

test('正常排一条：标题说还剩几天，正文带到期日与位置', () => {
  const plan = planExpiryNotifications({
    items: [item()],
    leadDays: 3,
    now: NOW,
    existing: [],
  });

  assert.deepEqual(plan.cancel, []);
  assert.equal(plan.schedule.length, 1);
  const n = plan.schedule[0];
  assert.equal(n.identifier, 'gewu-exp-a-2026-10-14-d3');
  assert.equal(n.itemId, 'a');
  assert.equal(n.title, '还有 3 天到期 · 鱼油');
  assert.equal(n.body, '到期日 2026年10月14日 · 厨房柜 第二格');
  assert.equal(n.at, at2016(2026, 10, 11, 9));
});

test('提前 0 天：标题写「今天到期」，不是「还有 0 天」', () => {
  const plan = planExpiryNotifications({
    items: [item()],
    leadDays: 0,
    now: NOW,
    existing: [],
  });
  assert.equal(plan.schedule[0].title, '今天到期 · 鱼油');
  assert.equal(plan.schedule[0].at, at2016(2026, 10, 14, 9));
});

test('没有位置就不写位置，只留到期日', () => {
  const plan = planExpiryNotifications({
    items: [item({ cabinetName: null, locationName: null })],
    leadDays: 3,
    now: NOW,
    existing: [],
  });
  assert.equal(plan.schedule[0].body, '到期日 2026年10月14日');
});

test('★ 提醒时刻已经过去的不补排 —— 否则一开开关就弹一堆', () => {
  /* 明天到期、提前 3 天 → 提醒时刻是 9-29，早就过了 */
  const soon = item({ id: 'b', expireDate: '2026-10-02' });
  const plan = planExpiryNotifications({
    items: [soon],
    leadDays: 3,
    now: NOW,
    existing: [],
  });
  assert.deepEqual(plan.schedule, []);

  /* 但同一件东西、提前 0 天 → 明早 9 点那条还在，不能一起被吞掉 */
  const plan0 = planExpiryNotifications({
    items: [soon],
    leadDays: 0,
    now: NOW,
    existing: [],
  });
  assert.equal(plan0.schedule.length, 1);
  assert.equal(plan0.schedule[0].at, at2016(2026, 10, 2, 9));
});

test('提醒时刻正好等于「现在」也不排（边界取开区间）', () => {
  const edge = item({ id: 'e', expireDate: '2026-10-04' }); // 提前 3 天 → 10-01 09:00
  const plan = planExpiryNotifications({
    items: [edge],
    leadDays: 3,
    now: at2016(2026, 10, 1, 9),
    existing: [],
  });
  assert.deepEqual(plan.schedule, []);
});

test('已过期的物品不排（它的提醒时刻必然在过去）', () => {
  const plan = planExpiryNotifications({
    items: [item({ id: 'old', expireDate: '2026-09-01' })],
    leadDays: 3,
    now: NOW,
    existing: [],
  });
  assert.deepEqual(plan.schedule, []);
});

test('到期日读不出来的物品静默跳过，不影响别人', () => {
  const plan = planExpiryNotifications({
    items: [item({ id: 'bad', expireDate: '不是日期' }), item()],
    leadDays: 3,
    now: NOW,
    existing: [],
  });
  assert.equal(plan.schedule.length, 1);
  assert.equal(plan.schedule[0].itemId, 'a');
});

test('按时间升序排，并只留最近的 30 条', () => {
  /* 40 件，到期日依次往后推 —— 靠后的那些应当被截掉 */
  const items = Array.from({ length: 40 }, (_, i) =>
    item({ id: `i${i}`, name: `物 ${i}`, expireDate: `2026-11-${String(i + 1).padStart(2, '0')}` }),
  );
  const plan = planExpiryNotifications({ items, leadDays: 3, now: NOW, existing: [] });

  assert.equal(MAX_SCHEDULED, 30);
  assert.equal(plan.schedule.length, 30);

  const times = plan.schedule.map((n) => n.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), '必须按时间升序');
  assert.equal(plan.schedule[0].itemId, 'i0');
  assert.equal(plan.schedule[29].itemId, 'i29');
  /* 第 31 条起的那些没排上，但也不是丢了 —— 下次重排还会轮到它们 */
  assert.ok(!plan.schedule.some((n) => n.itemId === 'i30'));
});

test('★ 差量：已排过的不重排，撤掉不该留的', () => {
  const items = [item()];
  const existing = ['gewu-exp-a-2026-10-14-d3'];

  const plan = planExpiryNotifications({ items, leadDays: 3, now: NOW, existing });
  assert.deepEqual(plan.schedule, [], '已经在系统里排着的不要再排一遍');
  assert.deepEqual(plan.cancel, []);
});

test('★ 改了到期日：旧标识要撤，新标识要排', () => {
  const items = [item()]; // 现在的到期日是 10-14
  const existing = ['gewu-exp-a-2026-10-10-d3']; // 上一轮按 10-10 排的

  const plan = planExpiryNotifications({ items, leadDays: 3, now: NOW, existing });
  assert.deepEqual(plan.cancel, ['gewu-exp-a-2026-10-10-d3']);
  assert.deepEqual(plan.schedule.map((n) => n.identifier), ['gewu-exp-a-2026-10-14-d3']);
});

test('★ 改了提前天数：整批换标识（这就是把档位编进 id 的意义）', () => {
  const items = [item()];
  const existing = ['gewu-exp-a-2026-10-14-d3'];

  const plan = planExpiryNotifications({ items, leadDays: 1, now: NOW, existing });
  assert.deepEqual(plan.cancel, ['gewu-exp-a-2026-10-14-d3']);
  assert.deepEqual(plan.schedule.map((n) => n.identifier), ['gewu-exp-a-2026-10-14-d1']);
  assert.equal(plan.schedule[0].title, '还有 1 天到期 · 鱼油');
});

test('物品被删掉（或没了到期日）：已排的那条要撤掉', () => {
  const plan = planExpiryNotifications({
    items: [],
    leadDays: 3,
    now: NOW,
    existing: ['gewu-exp-a-2026-10-14-d3'],
  });
  assert.deepEqual(plan.cancel, ['gewu-exp-a-2026-10-14-d3']);
  assert.deepEqual(plan.schedule, []);
});

test('不碰别人的通知：非本前缀的既不撤也不会进要排的集合', () => {
  const plan = planExpiryNotifications({
    items: [item()],
    leadDays: 3,
    now: NOW,
    existing: ['expo-other-thing', 'gewu-exp-a-2026-10-10-d3'],
  });
  assert.deepEqual(plan.cancel, ['gewu-exp-a-2026-10-10-d3']);
  assert.ok(!plan.cancel.includes('expo-other-thing'));
});

test('已排列表里有重复标识也只撤一次', () => {
  const plan = planExpiryNotifications({
    items: [],
    leadDays: 3,
    now: NOW,
    existing: ['gewu-exp-x-2026-10-14-d3', 'gewu-exp-x-2026-10-14-d3'],
  });
  assert.deepEqual(plan.cancel, ['gewu-exp-x-2026-10-14-d3']);
});

test('空库 / 全空输入不炸，返回空计划', () => {
  const plan = planExpiryNotifications({ items: [], leadDays: 3, now: NOW, existing: [] });
  assert.deepEqual(plan, { cancel: [], schedule: [], kept: [] });
});

test('★ 脏的提前天数不会把整批物品吞掉 —— 入口先收敛，再排', () => {
  /* 静默跳过整批，比用一个错档位更难查：用户只会看到「一条都没排上」 */
  const plan = planExpiryNotifications({
    items: [item()],
    leadDays: Number.NaN,
    now: NOW,
    existing: [],
  });
  assert.equal(plan.schedule.length, 1, '脏值应当收敛成默认值，而不是一条都不排');
  assert.equal(plan.schedule[0].identifier, 'gewu-exp-a-2026-10-14-d3');
});

test('★ 自定义天数也进标识 —— 10 天与 3 天是两套 id，互不覆盖', () => {
  const ten = planExpiryNotifications({ items: [item()], leadDays: 10, now: NOW, existing: [] });
  assert.equal(ten.schedule[0].identifier, 'gewu-exp-a-2026-10-14-d10');
  assert.equal(ten.schedule[0].at, at2016(2026, 10, 4, 9));
  assert.equal(ten.schedule[0].title, '还有 10 天到期 · 鱼油');
});

test('★ kept 是「跑完之后系统里应当排着的那批」—— 界面读它，不再回系统查', () => {
  const items = [item()];
  /* 已经在系统里的那条：这一轮不重排，但它仍然在 kept 里（否则界面会说「已排 0 条」） */
  const plan = planExpiryNotifications({
    items,
    leadDays: 3,
    now: NOW,
    existing: ['gewu-exp-a-2026-10-14-d3'],
  });
  assert.deepEqual(plan.schedule, []);
  assert.equal(plan.kept.length, 1);
  assert.equal(plan.kept[0].identifier, 'gewu-exp-a-2026-10-14-d3');
  /* 而「要被撤掉的那条」不该出现在 kept 里 */
  assert.ok(!plan.kept.some((n) => n.identifier === 'gewu-exp-a-2026-10-10-d3'));
});

test('kept 按时间升序，最近的排在最前', () => {
  const items = [
    item({ id: 'late', expireDate: '2026-12-01' }),
    item({ id: 'soon', expireDate: '2026-10-20' }),
    item({ id: 'mid', expireDate: '2026-11-01' }),
  ];
  const plan = planExpiryNotifications({ items, leadDays: 3, now: NOW, existing: [] });
  assert.deepEqual(plan.kept.map((n) => n.itemId), ['soon', 'mid', 'late']);
});

/* ------------------------------------------------------------ 展示 */

test('「最近的提醒」用 MM-DD 表示', () => {
  assert.equal(describeNextNotification(at2016(2026, 10, 4, 9)), '10-04');
  assert.equal(describeNextNotification(null), null);
});
