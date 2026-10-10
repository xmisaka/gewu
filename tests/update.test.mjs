/**
 * 检查更新（纯逻辑层）的测试。
 *
 * 这个功能的**每一个失败模式都是静默的**：清单解析歪了、已是最新判成有新版本、
 * 节流算反了导致再也不检查 —— 三种都不抛异常、不红屏，用户只会觉得
 * 「这 App 好像从来不提示更新」。所以逐条钉住。
 *
 * 只 import `src/lib/update/policy.ts`（纯函数，不碰 expo / db）与
 * `src/constants/site.ts`（一个 import 都没有的常量文件）。
 * 网络、读库、渲染在 check.ts / db/update.ts / UpdateSheet.tsx，不在本文件的射程里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  compareVersionName,
  decideCheck,
  formatVersionChange,
  isNewerVersion,
  parseUpdateManifest,
  readAutoCheck,
  readTimestamp,
  readVersionCode,
  shouldCheckNow,
  shouldPrompt,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_NOTES_MAX,
  updateStatusText,
} from '../src/lib/update/policy.ts';

import { SITE_URL, VERSION_URLS, siteUrlWithSkin } from '../src/constants/site.ts';

const LOCAL = { versionName: '1.5.0', versionCode: 10 };

/** 一份合法的清单（照 docs/version.json 的形状） */
function manifest(overrides = {}) {
  return { versionCode: 11, versionName: '1.6.0', notes: ['新增批量操作'], ...overrides };
}

/* ------------------------------------------------------------ 解析 */

test('解析：合法清单原样通过', () => {
  const parsed = parseUpdateManifest(manifest({ size: '48.3 MB', url: 'https://a.example/x.apk' }));
  assert.equal(parsed.versionCode, 11);
  assert.equal(parsed.versionName, '1.6.0');
  assert.deepEqual(parsed.notes, ['新增批量操作']);
  assert.equal(parsed.size, '48.3 MB');
  assert.equal(parsed.url, 'https://a.example/x.apk');
});

test('解析：versionCode 写成字符串也认（手写 JSON 很容易忘引号规则）', () => {
  assert.equal(parseUpdateManifest(manifest({ versionCode: '12' })).versionCode, 12);
});

test('解析：缺 versionCode / versionName 一律丢弃，绝不猜', () => {
  /* 猜错的代价是天天弹一个假更新，比这次不提示糟得多 */
  assert.equal(parseUpdateManifest(manifest({ versionCode: undefined })), null);
  assert.equal(parseUpdateManifest(manifest({ versionCode: 0 })), null);
  assert.equal(parseUpdateManifest(manifest({ versionCode: -3 })), null);
  assert.equal(parseUpdateManifest(manifest({ versionCode: 1.5 })), null);
  assert.equal(parseUpdateManifest(manifest({ versionName: '' })), null);
  assert.equal(parseUpdateManifest(manifest({ versionName: '   ' })), null);
  assert.equal(parseUpdateManifest(manifest({ versionName: 123 })), null);
});

test('解析：不是对象（含数组 / null / 字符串）一律丢弃', () => {
  for (const raw of [null, undefined, '1.6.0', 42, true, [], [{ versionCode: 11 }]]) {
    assert.equal(parseUpdateManifest(raw), null, `${JSON.stringify(raw)} 不该被当成清单`);
  }
});

test('解析：notes 去空、截断到上限 —— 条数一多会把两个按钮挤出可点区域', () => {
  const parsed = parseUpdateManifest(
    manifest({ notes: ['a', '  ', '', 42, null, ' b ', 'c', 'd', 'e', 'f'] }),
  );
  assert.equal(parsed.notes.length, UPDATE_NOTES_MAX);
  assert.deepEqual(parsed.notes, ['a', 'b', 'c', 'd']);
  assert.ok(UPDATE_NOTES_MAX <= 5, 'notes 上限不该放宽 —— 弹窗不是更新日志页');
});

test('解析：notes 不是数组时给空数组，而不是整份丢掉', () => {
  assert.deepEqual(parseUpdateManifest(manifest({ notes: '新增批量操作' })).notes, []);
  assert.deepEqual(parseUpdateManifest(manifest({ notes: undefined })).notes, []);
});

test('解析：url 只接受 https，size 去空', () => {
  assert.equal(parseUpdateManifest(manifest({ url: 'http://a.example/x.apk' })).url, undefined);
  assert.equal(parseUpdateManifest(manifest({ url: 'javascript:alert(1)' })).url, undefined);
  assert.equal(parseUpdateManifest(manifest({ url: 42 })).url, undefined);
  assert.equal(parseUpdateManifest(manifest({ size: '   ' })).size, undefined);
});

/* ------------------------------------------------------------ 比对 */

test('版本名比较：逐段比数字，1.10.0 要大于 1.9.0', () => {
  assert.equal(compareVersionName('1.6.0', '1.5.0'), 1);
  assert.equal(compareVersionName('1.5.0', '1.6.0'), -1);
  assert.equal(compareVersionName('1.5.0', '1.5.0'), 0);
  /* 段数不等按补 0 处理 */
  assert.equal(compareVersionName('1.5', '1.5.0'), 0);
  assert.equal(compareVersionName('1.5', '1.5.1'), -1);
  /* 字符串按长度比会在这里翻车：'1.10.0' < '1.9.0' */
  assert.equal(compareVersionName('1.10.0', '1.9.0'), 1);
});

test('版本名比较：非数字段按 0 处理，不把整份清单判废', () => {
  assert.equal(compareVersionName('1.6.0-beta', '1.6.0'), 0);
  assert.equal(compareVersionName('1.6.0', '1.6'), 0);
  assert.equal(compareVersionName('', '0.0.0'), 0);
});

test('有没有新版本：有 versionCode 就只认它（方案页定的基准）', () => {
  assert.equal(isNewerVersion(manifest({ versionCode: 11 }), LOCAL), true);
  assert.equal(isNewerVersion(manifest({ versionCode: 10 }), LOCAL), false);
  assert.equal(isNewerVersion(manifest({ versionCode: 9 }), LOCAL), false);
});

test('有没有新版本：拿不到本机 versionCode 时才退到版本名比较', () => {
  const local = { versionName: '1.5.0', versionCode: null };
  assert.equal(isNewerVersion(manifest({ versionCode: 11, versionName: '1.6.0' }), local), true);
  assert.equal(isNewerVersion(manifest({ versionCode: 11, versionName: '1.5.0' }), local), false);
  assert.equal(isNewerVersion(manifest({ versionCode: 1, versionName: '1.4.9' }), local), false);
});

/* ------------------------------------------------------------ 节流与抑制 */

test('节流：没查过就查', () => {
  assert.equal(shouldCheckNow(null, 1_000_000), true);
  assert.equal(shouldCheckNow(Number.NaN, 1_000_000), true);
});

test('节流：差一点点不算到期，正好到期就算', () => {
  const now = 10 * UPDATE_CHECK_INTERVAL_MS;
  assert.equal(shouldCheckNow(now - UPDATE_CHECK_INTERVAL_MS + 1, now), false);
  assert.equal(shouldCheckNow(now - UPDATE_CHECK_INTERVAL_MS, now), true);
  assert.equal(shouldCheckNow(now - UPDATE_CHECK_INTERVAL_MS * 3, now), true);
});

test('★ 节流：时间戳落在未来（用户把系统时钟往回拨）必须放行，不能把自己锁死', () => {
  /* 只写 elapsed >= interval 的话，这台机器会一直检查不了，
     直到真实时间追上那个错误的时间戳 —— 一个不会自我恢复的死锁 */
  const now = 1_000_000;
  assert.equal(shouldCheckNow(now + 86_400_000, now), true);
  assert.equal(shouldCheckNow(Number.MAX_SAFE_INTEGER, now), true);
});

test('抑制：「以后再说」只对那一个版本有效，下一个版本照弹', () => {
  assert.equal(shouldPrompt(manifest({ versionCode: 11 }), null), true);
  assert.equal(shouldPrompt(manifest({ versionCode: 11 }), 11), false);
  assert.equal(shouldPrompt(manifest({ versionCode: 11 }), 10), true);
  assert.equal(shouldPrompt(manifest({ versionCode: 12 }), 11), true);
  /* 脏数据不该让提示永远消失 */
  assert.equal(shouldPrompt(manifest({ versionCode: 11 }), Number.NaN), true);
});

test('meta 里读出来的字符串要能安全当数字用', () => {
  assert.equal(readTimestamp('1759900000000'), 1759900000000);
  assert.equal(readTimestamp(null), null);
  assert.equal(readTimestamp(''), null);
  assert.equal(readTimestamp('abc'), null);
  assert.equal(readTimestamp('0'), null);
  assert.equal(readTimestamp('-1'), null);

  assert.equal(readVersionCode('11'), 11);
  assert.equal(readVersionCode('11.7'), 11);
  assert.equal(readVersionCode(null), null);
  assert.equal(readVersionCode('v11'), null);
  assert.equal(readVersionCode('0'), null);
});

/* ------------------------------------------------------------ 自动检查总开关 */

test('★ 总开关关掉后，自动路径一次网都不发', () => {
  assert.equal(
    decideCheck({ manual: false, autoCheck: false, lastCheckAt: null, now: 1_000_000 }),
    'disabled',
  );
});

test('★ 总开关管不着手动检查 —— 挡了它等于把更新入口整个堵死', () => {
  /* 关掉自动检查是用户的正当选择，但不该以「再也更新不了」为代价 */
  assert.equal(
    decideCheck({ manual: true, autoCheck: false, lastCheckAt: null, now: 1_000_000 }),
    'go',
  );
});

test('总开关开着时，24h 节流照旧生效', () => {
  const now = 10 * UPDATE_CHECK_INTERVAL_MS;
  assert.equal(decideCheck({ manual: false, autoCheck: true, lastCheckAt: now - 1, now }), 'throttled');
  assert.equal(
    decideCheck({ manual: false, autoCheck: true, lastCheckAt: now - UPDATE_CHECK_INTERVAL_MS, now }),
    'go',
  );
  assert.equal(decideCheck({ manual: false, autoCheck: true, lastCheckAt: null, now }), 'go');
});

test('开关先于节流判断：关着就是关着，不管上次什么时候查的', () => {
  /* 反过来的话，用户会看到「刚关掉开关，它还是查了一次」 */
  assert.equal(
    decideCheck({ manual: false, autoCheck: false, lastCheckAt: 0, now: 1_000_000 }),
    'disabled',
  );
});

test('★ 开关读不出来一律当「开」：写成 === "1" 会让老用户静默失去更新提示', () => {
  assert.equal(readAutoCheck('1'), true);
  assert.equal(readAutoCheck('0'), false);
  assert.equal(readAutoCheck(null), true);
  assert.equal(readAutoCheck(''), true);
  assert.equal(readAutoCheck('garbage'), true);
});

test('★ check.ts 必须走 decideCheck，不许自己再写一遍判断', () => {
  /* 自己写一遍的后果：总开关会在某个分支里被绕开，而且不报错 */
  const src = readFileSync(new URL('../src/lib/update/check.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('decideCheck('), 'check.ts 没走 decideCheck —— 总开关可能被绕开');
  assert.ok(!src.includes('shouldCheckNow'), 'check.ts 又自己判节流了，应该交给 decideCheck');
});

/* ------------------------------------------------------------ 文案 */

test('弹窗副标题：有体积就带上，没有就省掉后半段', () => {
  assert.equal(formatVersionChange(LOCAL, manifest({ versionName: '1.6.0', size: '48.3 MB' })), '1.5.0 → 1.6.0 · 48.3 MB');
  assert.equal(formatVersionChange(LOCAL, manifest({ versionName: '1.6.0' })), '1.5.0 → 1.6.0');
});

test('设置页那行文案三态齐全', () => {
  assert.equal(updateStatusText('checking', LOCAL), '检查中…');
  assert.equal(updateStatusText('latest', LOCAL), '已是最新 · 1.5.0');
  assert.equal(updateStatusText('available', LOCAL), '有新版本');
  assert.equal(updateStatusText('failed', LOCAL), '暂时连不上官网');
  /* idle 不能是空串或「—」：那等于把入口藏起来，用户不会想到它其实可以点 */
  assert.equal(updateStatusText('idle', LOCAL), '点击检查');
});

/* ------------------------------------------------------------ 与仓库里的真实清单对账 */

test('★ 发版自检：仓库里的 docs/version.json 必须能被解析出来', () => {
  /* 这份文件是发版时拷到官网根目录的那一份。它一旦写坏，
     线上就是「永远查不到更新」，而且不会有任何报错 —— 所以在这里钉住。 */
  const raw = JSON.parse(readFileSync(new URL('../docs/version.json', import.meta.url), 'utf8'));
  const parsed = parseUpdateManifest(raw);
  assert.ok(parsed, 'docs/version.json 解析失败（缺 versionCode / versionName？）');
  assert.equal(typeof parsed.versionCode, 'number');
  assert.ok(parsed.versionName.length > 0);
  assert.ok(parsed.notes.length > 0, '更新说明为空的话，弹窗就只剩一句版本号');
  /* url 现在是弹窗主按钮的直接去处（2026-10-10 改口径）：它必须是本站域名下的
     .apk 直链 —— 写成网页地址，点「去下载」就下载回一个 HTML；写成外站，
     域名过期/换服务器时无声死链 */
  assert.ok(parsed.url, '清单缺 url：主按钮会退回官网页，直链口径失效');
  assert.ok(parsed.url.startsWith(`${SITE_URL}/downloads/`), `url 不在本站 downloads/ 下：${parsed.url}`);
  assert.ok(parsed.url.endsWith('.apk'), `url 不是 APK 直链：${parsed.url}`);
});

test('★ 发版自检：版本清单地址形状正确，且主源在官网域名下', () => {
  assert.ok(VERSION_URLS.length >= 1);
  assert.equal(VERSION_URLS[0], `${SITE_URL}/version.json`);
  for (const url of VERSION_URLS) {
    assert.ok(url.startsWith('https://'), `${url} 必须是 https`);
    assert.ok(url.endsWith('version.json'), `${url} 的路径名不对`);
  }
  /* 备用源要有意义，必须指向**另一台主机** —— 同一域名下的第二个路径，
     在「官网挂了」这个唯一的失败场景里救不了场 */
  if (VERSION_URLS.length > 1) {
    const host = (u) => new URL(u).host;
    assert.notEqual(host(VERSION_URLS[0]), host(VERSION_URLS[1]), '备用源不该和主源同域名');
  }
});

test('官网换肤地址：?skin= 必须在 #anchor 之前，参数要转义', () => {
  /* 官网换肤器认 ?skin=<key>（与 theme.ts 主题键同名）。query 写在锚点后面
     会变成锚点的一部分，浏览器根本不把它当查询参数 —— 那样换肤就静默失效 */
  assert.equal(siteUrlWithSkin('xuanye'), `${SITE_URL}/?skin=xuanye`);
  assert.equal(siteUrlWithSkin('xuanye', '#download'), `${SITE_URL}/?skin=xuanye#download`);
  /* 主题键来自内部常量，但转义兜底要有 —— 传入花值也不能拼出畸形 URL */
  assert.equal(siteUrlWithSkin('xu&y'), `${SITE_URL}/?skin=xu%26y`);
});
