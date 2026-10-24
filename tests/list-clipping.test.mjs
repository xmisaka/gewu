/**
 * 首页列表的子视图裁剪 —— 守护测试。
 *
 * 2026-10-24 真机反馈：「列表经常空白，明明有数据」。
 * 现象是**空白的那一段仍然占着行高**，白底与左右卡边都在，里面的内容整块不见，
 * 连行间的发丝线也没有 —— 因为那根线正是被摘掉的 ItemRow 自己画的。
 *
 * 根因：**Android 上 FlatList 的 removeClippedSubviews 默认是 true**
 *   （`node_modules/react-native/Libraries/Lists/FlatList.js` 的
 *    `removeClippedSubviewsOrDefault()`：`?? Platform.OS === 'android'`）。
 * 而裁剪只改**原生子视图的挂载关系、不改布局**，于是「高度对、内容空」。
 * RN 自己在这个 prop 的类型注释里写着
 * "may have bugs (missing content) in some circumstances"。
 *
 * 这条坏了**不会报错、也不会崩**，只会偶发丢内容，而且在模拟器/别人的机器上
 * 大概率复现不出来（取决于滚动与重新布局的时序）。所以只能用源码级断言钉住。
 *
 * ★ 别把下面这条断言当成「性能优化被禁止」：VirtualizedList 的窗口化仍然生效，
 *   这个开关关掉的只是「已渲染的 cell 是否被回收」。拿它换滚动性能，
 *   代价是用户看不见自己录进去的东西 —— 不划算。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const homeSource = read('../src/app/(tabs)/index.tsx');

/**
 * 抽首页那个 FlatList 的**属性区**。
 *
 * ★ 两个坑都踩过，别再退回朴素的 `indexOf`：
 *   ① `indexOf('<FlatList')` 会先命中 `useRef<FlatList<ItemView>>(null)` ——
 *      属性区从那一行开始，只剩一小截，底下所有断言都在空壳上跑（假绿）；
 *   ② `/[\s\S]*?\/>/` 会提前停在内层 JSX（`renderItem` 里的 `<ItemRow … />`）。
 * 所以起止都要求**标签 / 属性名后面直接跟换行或 `=`**：
 *   `<FlatList` + 换行 ＝ 真标签；`ListHeaderComponent={` ＝ 真属性（注释里的纯词不算）。
 */
function flatListAttributeSpan(source) {
  const open = new RegExp(/<FlatList\r?\n/).exec(source);
  assert.ok(open, '首页里找不到 <FlatList> 标签 —— 列表结构变了，这条守护测试需要跟着改');

  const from = open.index;
  const end = source.indexOf('ListHeaderComponent={', from);
  assert.ok(end > from, '从 <FlatList 到 ListHeaderComponent 之间找不到属性区 —— 抽取方式失效');

  const text = source.slice(from, end);
  // 自检：抽全了没。抽漏的话，下面每条断言都会在空字符串上「全绿」
  assert.ok(
    /data=\{items\}/.test(text),
    '属性区里连 data={items} 都没有 —— 抽取起点又落在别处了，下面的断言不可信',
  );
  return { from, end, text };
}

/* ==================== 1. 必须显式关掉裁剪 ==================== */

test('★★★ 首页 FlatList 关掉子视图裁剪（Android 默认是 true，会偶发丢行）', () => {
  const span = flatListAttributeSpan(homeSource);

  assert.ok(
    /removeClippedSubviews=\{false\}/.test(span.text),
    '首页 FlatList 没有写 removeClippedSubviews={false} —— ' +
      'Android 上它默认是 true，会表现为「有数据但整行空白」，且不报错',
  );
});

test('★ 不能被改回 true（裁剪是静默的：高度留着，内容没了）', () => {
  const span = flatListAttributeSpan(homeSource);

  assert.ok(
    !/removeClippedSubviews=\{true\}/.test(span.text),
    '有人把 removeClippedSubviews 打开了 —— 那是拿可见性换滚动性能',
  );
});

/* ==================== 2. 列表仍是窗口化的 ==================== */

/**
 * 关掉裁剪**不等于**关掉窗口化。若某天有人顺手把 `data={items}` 换成
 * 一次性 map 出一整列 View（为了「反正不裁剪了」），几百件物品会全部挂到
 * 原生树上，滚动立刻变卡 —— 那是把这条修复理解反了。
 */
test('列表仍然交给 FlatList 渲染（关裁剪 ≠ 全量铺开）', () => {
  const span = flatListAttributeSpan(homeSource);

  assert.ok(/data=\{items\}/.test(span.text), 'FlatList 的 data 不再是 items —— 列表数据源被换掉了');
  assert.ok(/keyExtractor=/.test(span.text), 'FlatList 少了 keyExtractor —— 行会按 index 复用，勾选态与库存面板会串行');
});
