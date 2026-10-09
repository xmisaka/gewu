/* 用**线上那份真实清单**跑一遍 App 的判定逻辑。
   policy.ts 是纯逻辑（不 import expo / react-native / db），所以能直接进 node 跑。
   这里验的是「App 拿到官网那份 JSON 之后，会不会做出正确的判断」。 */
import { readFileSync } from 'node:fs';
const { parseUpdateManifest, isNewerVersion, formatVersionChange, updateStatusText, shouldCheckNow, shouldPrompt, UPDATE_NOTES_MAX } =
  await import('../src/lib/update/policy.ts');

const raw = JSON.parse(readFileSync('docs/version.json', 'utf8'));
const m = parseUpdateManifest(raw);

console.log('① 解析线上清单');
console.log('   versionCode =', m.versionCode, '/ versionName =', m.versionName, '/ size =', m.size);
console.log('   notes 条数 =', m.notes.length, '（上限 %d）', UPDATE_NOTES_MAX);
console.log('   url =', m.url);
console.log('   → 被截断的条数：', raw.notes.length - m.notes.length);
console.log();

console.log('② 判定（versionCode 是基准）');
const cur = { versionName: '2.0.0', versionCode: 16 };
const old = { versionName: '1.5.0', versionCode: 15 };
console.log('   已装 16（当前）→ 有新版本？', isNewerVersion(m, cur), '｜设置页文案：', updateStatusText(isNewerVersion(m, cur) ? 'available' : 'latest', cur));
console.log('   已装 15（旧版）→ 有新版本？', isNewerVersion(m, old), '｜设置页文案：', updateStatusText('available', old));
console.log('   弹窗副标题（15 → 新）：', formatVersionChange(old, m));
console.log();

console.log('③ 节流与抑制');
const now = Date.now();
console.log('   从未查过        → 该查？', shouldCheckNow(null, now));
console.log('   刚查过          → 该查？', shouldCheckNow(now, now), '（24h 内不重复开网）');
console.log('   时钟被拨回一年  → 该查？', shouldCheckNow(now + 365 * 86400_000, now), '（不能死锁）');
console.log('   点过「以后再说」16 → 还弹？', shouldPrompt(m, 16), '（同版本不重复弹）');
console.log();

console.log('④ 坏清单要被丢掉，而不是猜一个版本号');
for (const [label, bad] of [
  ['缺 versionCode', { versionName: '2.0.0' }],
  ['缺 versionName', { versionCode: 17 }],
  ['versionCode 是 0', { versionName: '2.0.0', versionCode: 0 }],
  ['整个是数组', []],
  ['是 null', null],
]) {
  console.log('   %-18s → %s', label, parseUpdateManifest(bad));
}
