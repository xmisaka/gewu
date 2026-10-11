/**
 * 录入页的「返回语境」—— 源码静态断言。
 *
 * ★ 这条不变量靠人盯**必漏**。
 *
 * 录入页原本是 `(tabs)` 里的一格。从柜子详情 `router.push('/compose')` 进去，
 * 在 tab 导航里等于**切 tab** —— 于是安卓返回键落到第一格（我的物品），
 * 回不到那个柜子；来源柜子也无处可带，位置默认值只能取「上次用过的位置」
 * （从别的柜子进来时那个值是错的）。
 *
 * 2026-10-11 把它挪到根 Stack 才同时修好这两条。症状是「返回去了错的地方」
 * +「位置默认值不对」—— 两条都不崩、不报错，普通测试更不会红，
 * 只能把源码读出来断言。**谁哪天顺手把它挪回 tab，这里要红。**
 *
 * 用 readFileSync 而不是 import：这些文件都 import 了 react-native，
 * 在 node:test 里根本加载不了（与 theme.test.mjs / ai-gating.test.mjs 同一个理由）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const exists = (rel) => existsSync(new URL(rel, import.meta.url));

test('录入页注册在根 Stack 上，不在 (tabs) 里', () => {
  assert.ok(exists('../src/app/compose.tsx'), '录入页应当是根 Stack 路由 app/compose.tsx');
  assert.ok(
    !exists('../src/app/(tabs)/compose.tsx'),
    '录入页不能放回 (tabs)：tab 不压栈，从柜子详情进去录完一件，返回会落到「我的物品」而不是那个柜子',
  );

  const tabsLayout = read('../src/app/(tabs)/_layout.tsx');
  assert.ok(
    !/<Tabs\.Screen[^>]*name="compose"/.test(tabsLayout),
    '(tabs)/_layout 里不该再注册 compose',
  );

  const rootLayout = read('../src/app/_layout.tsx');
  assert.ok(/<Stack\.Screen\s+name="compose"/.test(rootLayout), '根 Stack 要注册 compose');
});

test('底部中央那枚按钮是压栈打开录入页，不是切 tab', () => {
  const src = read('../src/components/TabBar.tsx');
  assert.match(src, /router\.push\('\/compose'\)/, '中央按钮要走 router.push 压栈');
  assert.ok(
    !/navigation\.navigate\(\s*['"]compose['"]\s*\)/.test(src),
    '中央按钮不能 navigate 到 compose —— 那是切 tab，返回键只会落到第一格',
  );
});

test('从柜子进录入页要带上这个柜子', () => {
  const cabinet = read('../src/app/cabinet/[id].tsx');
  assert.match(
    cabinet,
    /pathname:\s*'\/compose'[^}]*locationId/,
    '柜子详情的「录一件」必须把柜子 id 带过去，否则位置默认值只能取「上次用过的位置」',
  );

  const compose = read('../src/app/compose.tsx');
  assert.ok(
    compose.includes('useLocalSearchParams'),
    '录入页要从路由参数读来源柜子 —— 参数绑在这一份实例上，不会串到下一次进入',
  );
  assert.match(
    compose,
    /sessionLocationId !== undefined[\s\S]{0,120}originLocationId[\s\S]{0,120}lastLocationState\.data/,
    '位置默认值的优先级应当是：本次会话刚录过的 > 来源柜子 > 上次用过的位置',
  );
  assert.ok(
    compose.includes('lastLocationState.loading'),
    '读「上次用过的位置」是异步的，必须算进 loading 闸门 —— 否则表单会先拿 null 挂载，' +
      '而 ItemForm 的 defaults 只被 useState 取一次初值，数据后到也补不上（不报错，只在慢机上出现）',
  );
});

test('收工回「来处」，不硬回物品页', () => {
  const compose = read('../src/app/compose.tsx');
  assert.match(
    compose,
    /\}\s*else\s*\{\s*leave\(\);\s*\}/,
    "「保存并完成」要走 leave() —— 不能写成 router.replace('/')，" +
      '那会把「从柜子进来」的人硬拖回物品页',
  );
  assert.match(compose, /router\.canGoBack\(\)/, '无栈可退（冷启动深链直达）时才回退到物品页');
  assert.match(compose, /router\.back\(\)/, 'leave() 要走返回键');
});
