/**
 * AI 族入口的门控口径 —— 源码静态断言。
 *
 * 这一族一共 **5 个入口 + 3 个可深链的页面**，分散在 5 个文件里：
 *   首页搜索框右侧（麦克风 / 星标）· 录入页右上（语音 / 批量识图）·
 *   录入页照片条的「识物」· `/ask`、`/voice`、`/batch` 三个页面自身的兜底。
 *
 * ★★ 它们必须挂在**同一个判据** `useAi().enabled`（总开关）上，
 *    而不是 `active`（那还要求填了 Key，是「能不能跑」），更不能各页现编一个。
 *    这条不变量靠人盯**必漏**：症状是「开关明明关着、界面上还满屏 AI」，
 *    它不报错、界面也不崩，普通测试更不会红 —— 所以只能把源码读出来断言。
 *
 * 用 readFileSync 而不是 import：这些文件都 import 了 react-native，
 * 在 node:test 里根本加载不了（与 theme.test.mjs 同一个理由）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** 必须自己挡总开关的文件 */
const GATED_FILES = [
  ['../src/app/(tabs)/index.tsx', '首页搜索框右侧的麦克风与星标'],
  ['../src/app/(tabs)/compose.tsx', '录入页右上的语音 / 批量识图，以及照片条的识物'],
  ['../src/app/ask.tsx', '问一问页（深链兜底）'],
  ['../src/app/voice.tsx', '语音录入页（深链兜底）'],
  ['../src/app/batch.tsx', '批量识图页（深链兜底）'],
];

/**
 * 允许读 AI store 但**不需要**挡入口的文件，各自写明豁免理由。
 *
 * ★ 这份清单是这条测试真正的兜底：哪天有人新加一个页面去用 AI store，
 *   忘了挡总开关，下面的「全量扫描」会立刻把他揪出来 ——
 *   而不是等到用户发现「关了开关还有入口」。
 */
const EXEMPT = new Map([
  ['src/lib/store/ai.tsx', 'AI store 自身 —— `useAi()` 就定义在这个文件里'],
  ['src/app/ai.tsx', 'AI 助手设置页自身，开关就在这一页上'],
  ['src/app/(tabs)/mine.tsx', '只在设置行上显示「已开启 / 已关闭 / 未配置」，不是功能入口'],
  ['src/components/domain/AiProviderModals.tsx', '设置页的弹层，只读写供应商与模型名'],
  ['src/components/domain/AiKeyModal.tsx', '设置页的弹层，只读写 Key'],
]);

/** 递归收集 src/ 下所有 .tsx 的相对路径（POSIX 风格） */
function walkTsx(dir, out = []) {
  for (const entry of readdirSync(new URL(dir, import.meta.url))) {
    const rel = `${dir}/${entry}`;
    if (statSync(new URL(rel, import.meta.url)).isDirectory()) {
      walkTsx(rel, out);
    } else if (entry.endsWith('.tsx')) {
      out.push(rel.replace(/^\.\.\//, ''));
    }
  }
  return out;
}

test('AI 族入口一律挂在总开关（enabled）上，不挂在 active 上', () => {
  let checked = 0;
  for (const [rel, what] of GATED_FILES) {
    const src = read(rel);
    assert.ok(src.includes('useAi()'), `${what}（${rel}）没读 AI store`);
    assert.match(
      src,
      /enabled:\s*aiEnabled/,
      `${what}（${rel}）没有从 useAi() 里取出总开关。入口必须挂 enabled —— ` +
        '挂 active 的话，没填 Key 的人会看不到入口，而关掉开关的人反而还看得见（正好写反）',
    );
    checked += 1;
  }
  assert.equal(checked, GATED_FILES.length);
  // 兜底：清单本身被改短了也要报出来，否则「漏检」会伪装成「全绿」
  assert.equal(GATED_FILES.length, 5, '入口清单变了，请同步这份测试与 store/ai.tsx 的口径注释');
});

test('全量扫描：新页面若读 AI store 就必须挡总开关，或写进豁免清单', () => {
  const files = walkTsx('../src');
  assert.ok(files.length > 20, `只扫到 ${files.length} 个 .tsx，路径大概率写错了`);

  const gated = new Set(GATED_FILES.map(([rel]) => rel.replace(/^\.\.\//, '')));
  const offenders = [];
  for (const rel of files) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    if (!src.includes('useAi()')) continue;
    if (gated.has(rel) || EXEMPT.has(rel)) continue;
    offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `这些文件读了 AI store 却既没挡总开关、也不在豁免清单里：${offenders.join(', ')}`,
  );
});

test('深链兜底页面：先挡档位、后挡总开关，顺序不能反', () => {
  for (const rel of ['../src/app/ask.tsx', '../src/app/voice.tsx', '../src/app/batch.tsx']) {
    const src = read(rel);
    const gate = src.indexOf('if (!entitled)');
    const off = src.indexOf('if (!aiEnabled)');
    assert.ok(gate >= 0, `${rel} 少了支持者档守卫 —— 深链就是一道暗门`);
    assert.ok(off >= 0, `${rel} 少了总开关守卫`);
    assert.ok(
      gate < off,
      `${rel} 两道守卫的顺序反了：一个既没付费、又关了开关的人会先看到「去打开开关」，` +
        '那可是他打开也用不了的东西',
    );
    assert.ok(src.includes('AiOffNotice'), `${rel} 应当走共用的 AiOffNotice，别各写一套`);
  }
});

test('识物入口的判据只有一个来源：ItemForm 不自己读 AI store', () => {
  const src = read('../src/components/domain/ItemForm.tsx');
  assert.ok(
    !src.includes('useAi'),
    'ItemForm 不该自己判断「支持者档 / 有没有配 Key / 开关开没开」—— ' +
      '它只认 onAiRecognize 有没有传进来。判据一旦分叉，就会出现「按钮在、按下去必然报错」',
  );
  assert.ok(src.includes('{onAiRecognize ? ('), '识物按钮应当由 onAiRecognize 是否存在决定');
});

test('录入页传识物回调时同时看总开关与看图能力', () => {
  const src = read('../src/app/(tabs)/compose.tsx');
  assert.match(
    src,
    /onAiRecognize=\{[^}]*aiEnabled[^}]*canRecognize[^}]*\}/,
    '识物入口要同时满足：总开关开着（用户没关）且当前这家能看图（不是纯文本模型）',
  );
});

test('设置页文案不得再声称「语音与总开关无关」', () => {
  const src = read('../src/app/ai.tsx');
  assert.ok(
    !src.includes('与上面的总开关无关'),
    '那句话说反了：语音与识物、问答同属「智能录入」，共用一个总闸',
  );
  assert.ok(
    src.includes('界面上的 AI 入口一并隐藏'),
    '总开关下面那句说明是**对用户的承诺**，也是这套门控存在的理由；改文案前先确认口径没变',
  );
});
