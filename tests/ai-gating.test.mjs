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
 * ★★ 2026-10-15：总开关的**默认值**从「关」翻成「开」。它现在表达的是
 *    「用户有没有主动把这一族关掉」，免费档也看得见入口（点下去弹门控）。
 *    原来默认关 + 设置页对未激活档整页锁着 = 免费用户从没见过这族入口，
 *    而且不报错。默认值本身也在这份测试里钉住（见下面两条）。
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
  ['../src/app/compose.tsx', '录入页右上的语音 / 批量识图，以及照片条的识物'],
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

test('★ 总开关默认值是「开」：null 视为开，不是视为关', () => {
  /*
   * 默认值也是这条门控的一部分，而且是最容易悄悄翻回去的一格。
   *
   * 2026-10-15 之前它是「关」。看着更保守，实际后果是免费用户**永远**看不到
   * 这一族入口 —— AI 设置页对未激活档整页锁着，他们打不开开关，于是
   * `enabled` 恒为 false，首页与录入页的图标从来不渲染，任何一处都不报错。
   * 所以这条钉的是「默认是开」，不是在测实现细节。
   */
  const src = read('../src/lib/ai/config.ts');
  assert.match(
    src,
    /return runtimeEnabled !== false;/,
    '总开关的默认值被翻回「关」了。那会让免费档从没见过 AI 入口 ——' +
      ' 他们进不去设置页、永远打不开这个开关，而且任何一处都不报错。' +
      ' 改之前先读 lib/ai/config.ts 里 saveAiEnabled 上面那段。',
  );
});

test('AI store 在读库之前就按「开」渲染，免得每次冷启动把图标闪出来', () => {
  const src = read('../src/lib/store/ai.tsx');
  assert.match(
    src,
    /const \[enabled, setEnabledState\] = useState\(true\)/,
    'AI store 里总开关的初值必须是 true：默认关的话，每次冷启动都会先按' +
      '「关」渲染一帧、读完库再冒出来，用户看到图标闪一下 —— 不报错。',
  );
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
  /* ★ 这里**没有 `/voice`** —— 2026-10-17 起语音录入属于免费权益，
     它只剩总开关那一道守卫（下面那条单独钉住）。 */
  for (const rel of ['../src/app/ask.tsx', '../src/app/batch.tsx']) {
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

test('★★ 语音录入页只剩总开关一道守卫 —— 档位判断不许再加回去', () => {
  /*
   * 2026-10-17 的划档：语音走系统识别器、不耗模型调用、不要 Key，
   * 把它锁在付费墙后面是这道墙里最没道理的一格，所以放进了免费权益。
   *
   * ★ 这条断言守的是**方向的另一半**：以前这里断言「必须有档位守卫」，
   *   现在必须反过来断言「没有档位守卫」。只删不补的话，下次谁把门控加回去
   *   也不会有人发现 —— 而症状是「免费用户点了麦克风看到付费浮层」，
   *   不报错、不崩，测别的也都绿。
   */
  const src = read('../src/app/voice.tsx');
  assert.equal(
    /if\s*\(\s*!entitled/.test(src),
    false,
    '语音录入页不该再有档位判断 —— 它属于免费权益，加了就是把人挡在一扇他已经有权进的门外',
  );
  assert.equal(
    src.includes('SupporterGateSheet'),
    false,
    '语音录入页不该再挂门控浮层',
  );
  assert.ok(src.includes('if (!aiEnabled)'), '总开关那道守卫必须留着：它和识物、问答共用一个总闸');
  assert.ok(src.includes('AiOffNotice'), '总开关关着时要走共用的 AiOffNotice');
});

test('★★ 录入页与首页：语音入口不再看档位，批量识图仍然看', () => {
  /* 两处麦克风都要**无条件**跳 `/voice`。判据写反的代价：
     免费用户点了麦克风毫无反应（或弹一层「支持者功能」），
     而他其实有权用 —— 这种「明明写着免费却用不了」最难被自测发现。 */
  const compose = read('../src/app/compose.tsx');
  assert.equal(
    /if\s*\(\s*!entitled\s*\)\s*\{?\s*setGateOpen\(true\)[\s\S]{0,80}voice/.test(compose),
    false,
    '录入页不该在语音入口上判档位',
  );
  assert.match(
    compose,
    /accessibilityLabel="语音录入"\s*\n?\s*onPress=\{\(\) => router\.push\('\/voice'\)\}/,
    '录入页的语音按钮应当无条件跳 `/voice`',
  );

  const home = read('../src/app/(tabs)/index.tsx');
  const openVoice = /const openVoice = useCallback\(([\s\S]{0,200}?)\[/.exec(home)?.[1] ?? '';
  assert.ok(openVoice, '在首页找不到 openVoice');
  assert.equal(
    /entitled/.test(openVoice),
    false,
    '首页的语音入口不该看档位 —— 它已经属于免费权益',
  );
  assert.ok(
    /router\.push\('\/voice'\)/.test(openVoice),
    '首页的语音入口应当直接跳 `/voice`',
  );
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
  const src = read('../src/app/compose.tsx');
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
  /* ★ 锚点只钉「一起收起」这四个字，不钉整句：2026-10-17 文案精简把
     「关闭后它们一起收起」改成了「管着四个入口。关掉后它们一起收起……」，
     整句锚点会让**正常的文案编辑**红一次。这里要守的是口径（这个开关管着整族），
     不是某个版本的措辞。 */
  assert.ok(
    src.includes('一起收起'),
    '总开关下面那句说明是**对用户的承诺**，也是这套门控存在的理由；改文案前先确认口径没变',
  );
  /* ★ 2026-10-15：AI 一族的入口从三个（识物/问答/语音）变成四个，多出「批量识图」。
     两处列举（总开关说明、语音那条注解）都要带上它 —— 漏一处，用户就会以为
     批量识图不在这套门控里，而它恰恰是最省事的那个。 */
  assert.ok(
    src.includes('批量识图'),
    'AI 设置页必须把「批量识图」写进四个入口里 —— 它同属这一族，漏了就是静默少一项',
  );
});
