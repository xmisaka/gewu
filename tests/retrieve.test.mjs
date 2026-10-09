/**
 * 问一问「本地检索层」的测试。
 *
 * 这一层的每个错误都是**静默**的，而且错得很像对的：
 *   - 意图判错 → 选出来的候选整批不对（问「能吃的」却给出洗衣液）
 *   - 排序反了 → 最该先吃的那样被排到最后
 *   - 漏判空库 → 用户看到一句言之凿凿的话，底下却一张卡片都没有
 * 三种都不抛异常、不红屏，所以逐条钉。
 *
 * 只 import `src/lib/ai/retrieve.ts`（纯函数，不碰 expo / react-native / db）。
 * 网络与渲染在 client.ts / app/ask.tsx，读库在 lib/db，都不在本文件射程里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  categoryOf,
  classify,
  expiryWindow,
  extractSubject,
  isFood,
  MAX_ANSWER_ITEMS,
  place,
  retrieve,
  textMatch,
  toSnapshot,
} from '../src/lib/ai/retrieve.ts';

const TODAY = '2026-10-08';

/**
 * 一条物品快照。
 *
 * 默认值刻意取「食品 · 还有 84 天到期」：库里绝大多数记录就是这个形状，
 * 让每个用例只需要写出它真正关心的那两三个字段。
 */
function snap(over = {}) {
  return {
    id: 'i-default',
    name: '牛肉面',
    brand: null,
    categoryName: '食品',
    cabinetName: '厨房',
    locationName: '橱柜2',
    expireDate: '2026-12-31',
    daysToExpiry: 84,
    quantity: null,
    tags: [],
    note: null,
    dailyCost: null,
    holdingDays: null,
    price: null,
    createdAt: 1_000,
    ...over,
  };
}

/**
 * 一份覆盖各条分支的库。
 *
 * 特意放进「洗衣液」：它是「能吃的」这条查询最容易混进来的东西 ——
 * 分类不是食品、名字里也没有食品类的字，一旦意图判错，它必然出现在答案里。
 */
const LIB = [
  snap({ id: 'a', name: '牛肉面', categoryName: '食品', daysToExpiry: 84, createdAt: 100 }),
  snap({ id: 'b', name: '酸奶', categoryName: '食品', daysToExpiry: 3, createdAt: 200 }),
  snap({
    id: 'c',
    name: '洗衣液',
    categoryName: '清洁',
    daysToExpiry: -5,
    locationName: '阳台',
    createdAt: 300,
  }),
  snap({
    id: 'd',
    name: '帐篷',
    categoryName: '运动户外',
    daysToExpiry: null,
    expireDate: null,
    locationName: '储物间',
    createdAt: 400,
  }),
  snap({
    id: 'e',
    name: 'Type-C 数据线 1 米',
    categoryName: '数码',
    daysToExpiry: null,
    expireDate: null,
    locationName: '书桌 · 抽屉',
    price: 39,
    dailyCost: 0.5,
    holdingDays: 78,
    createdAt: 500,
  }),
  snap({
    id: 'f',
    name: '纸巾',
    categoryName: '家居',
    daysToExpiry: null,
    expireDate: null,
    quantity: 0,
    createdAt: 600,
  }),
  snap({
    id: 'g',
    name: '酱油',
    categoryName: '食品',
    daysToExpiry: null,
    expireDate: null,
    quantity: 1,
    createdAt: 700,
  }),
];

const ids = (list) => list.map((it) => it.id);

/* ------------------------------------------------------------- 意图 */
/* ★ 顺序就是优先级。这一组用例是整份文件里最该被钉死的部分 ——
   判错优先级不会报错，只会让答案变得「看着挺像那么回事」。 */

test('成本类排在最前：「日均成本最高」不该被「最贵」之外的词抢走', () => {
  assert.deepEqual(classify('日均成本最高的是什么'), { kind: 'cost', metric: 'daily' });
  assert.deepEqual(classify('哪个最贵'), { kind: 'cost', metric: 'price' });
});

test('规模类与补货类', () => {
  assert.deepEqual(classify('一共多少件东西'), { kind: 'count' });
  assert.deepEqual(classify('有什么该买的吗'), { kind: 'lowStock' });
});

test('★「能吃」必须排在「到期」之前，且不设天数上限', () => {
  // 先判「到期」的话，「吃」这个限定就丢了，答案里会混进洗衣液
  const intent = classify('家里还有什么能吃的');
  assert.equal(intent.kind, 'expiring');
  assert.equal(intent.food, true);
  assert.equal(intent.withinDays, Number.POSITIVE_INFINITY);
});

test('到期类：默认可看 30 天，说了「今天」「这周」就收窄', () => {
  assert.deepEqual(classify('这个月哪些要到期'), { kind: 'expiring', withinDays: 30, food: false });
  assert.deepEqual(classify('今天有什么到期的'), { kind: 'expiring', withinDays: 0, food: false });
  assert.deepEqual(classify('这周要过期的'), { kind: 'expiring', withinDays: 7, food: false });
});

test('expiryWindow：认不出时间范围时退回「即将到期」的统一口径（30 天）', () => {
  assert.equal(expiryWindow('有什么要过期的'), 30);
  assert.equal(expiryWindow('今天'), 0);
  assert.equal(expiryWindow('最近几天'), 7);
});

test('位置类：「露营装备」要翻成库里的分类名，不能只当搜索词', () => {
  const intent = classify('露营装备放哪了', LIB);
  assert.equal(intent.kind, 'location');
  assert.equal(intent.categoryName, '运动户外');
});

test('位置类：同义词表没接住的，categoryName 留空、退回按名字搜', () => {
  const intent = classify('数据线在哪', LIB);
  assert.equal(intent.kind, 'location');
  assert.equal(intent.query, '数据线');
  assert.equal(intent.categoryName, null);
});

test('兜底：看不懂意图就当搜索词用', () => {
  const intent = classify('帐篷');
  assert.equal(intent.kind, 'search');
  assert.equal(intent.query, '帐篷');
});

test('空问题与单字一律判 unknown，不要硬猜', () => {
  assert.deepEqual(classify(''), { kind: 'unknown' });
  assert.deepEqual(classify('嗯'), { kind: 'unknown' });
});

/* --------------------------------------------------- 剥词与分类判定 */

test('extractSubject：剥掉口语词，留下物品名', () => {
  assert.equal(extractSubject('我的数据线放哪了'), '数据线');
  assert.equal(extractSubject('请问一下帐篷放在哪里'), '帐篷');
  // 整句都是代词时剥完是空串 —— 这是对的，classify 会用 `extractSubject(q) || q` 兜回来
  assert.equal(extractSubject('这些东西都在哪'), '');
});

test('★「X 放哪了」这种省掉「在」的问法也要能抽出物品名', () => {
  // 缺口没补上时，抽出来的是「数据线放哪」——拿它去匹配必然落空，
  // 于是库里有这东西却回答「没找到」。这一条就是为那个缺口钉的。
  assert.equal(extractSubject('数据线放哪了'), '数据线');
  assert.equal(classify('数据线放哪了', LIB).kind, 'location');
});

test('★ 从这条问法一路走到检索结果：库里真有的东西不能答「没找到」', () => {
  const r = retrieve('我的数据线放哪了', LIB, TODAY);
  assert.deepEqual(ids(r.items), ['e']);
  assert.ok(!r.fact.includes('没找到'), `明明库里有，却答没找到：${r.fact}`);
});

/* ★★ 与上一条同族 —— 词表缺的是「问一个柜子里都有什么」那一族问法。
   原表只有「放哪 / 在哪 / 哪个柜子」这类找单件东西的说法，于是最常见的清点问法
   会被判成普通搜索，整句拿去和物品字段做子串匹配：柜子里有 8 件也答「没找到」。 */
test('★★「X 里有什么」：柜子里有东西就不能答「没找到」', () => {
  const shelf = [
    snap({ id: 'x1', name: '遥控器', categoryName: '数码', cabinetName: '客厅电视柜', locationName: null, createdAt: 100 }),
    snap({ id: 'x2', name: '机顶盒', categoryName: '数码', cabinetName: '客厅电视柜', locationName: null, createdAt: 200 }),
  ];

  for (const q of [
    '客厅电视柜里有什么',
    '客厅电视柜有什么',
    '客厅电视柜里放了什么',
    '客厅电视柜里面有什么东西',
    '客厅电视柜里都有啥',
  ]) {
    const r = retrieve(q, shelf, TODAY);
    assert.equal(r.intent.kind, 'location', `${q} 应判成位置类，实得 ${r.intent.kind}`);
    assert.deepEqual(ids(r.items), ['x2', 'x1'], q);
    assert.ok(!r.fact.includes('没找到'), `${q} 柜子里明明有东西，却答：${r.fact}`);
  }
});

test('★ 位置名部分对上也要能命中（「电视柜」对「客厅电视柜」）', () => {
  const shelf = [snap({ id: 'x1', name: '遥控器', cabinetName: '客厅电视柜', locationName: null })];
  const r = retrieve('电视柜里有什么', shelf, TODAY);

  assert.deepEqual(ids(r.items), ['x1']);
  assert.ok(!r.fact.includes('没找到'), r.fact);
});

test('★ 清点问法的尾巴要剥干净，query 不能剩下半句', () => {
  assert.equal(extractSubject('客厅电视柜里有什么'), '客厅电视柜');
  assert.equal(extractSubject('电视柜里面有什么东西'), '电视柜');
  assert.equal(extractSubject('客厅电视柜里放了什么'), '客厅电视柜');
  assert.equal(extractSubject('书架上都有什么'), '书架上');
});

test('★「有什么」很泛，但不能把更具体的意图抢过来', () => {
  // 钉的是判定顺序：补货 ③、吃的 ④、到期 ⑤ 都排在位置 ⑥ 之前
  assert.equal(classify('有什么该补货了', LIB).kind, 'lowStock');
  assert.equal(classify('家里还有什么能吃的', LIB).kind, 'expiring');
  assert.equal(classify('有什么要过期了', LIB).kind, 'expiring');
  assert.equal(classify('一共有多少件东西', LIB).kind, 'count');
  assert.equal(classify('有什么最贵', LIB).kind, 'cost');
});

test('★★ 问的若是库里的位置名，不能因为名字里带分类词就改按分类过滤', () => {
  // 「厨房吊柜」含「厨房」，而同义词表把「厨房」翻成分类「厨房」——
  // 一旦按分类过滤，吊柜里的食品与清洁用品全被漏掉，只剩分类恰好叫「厨房」的那几件。
  const kitchen = [
    snap({ id: 'k1', name: '挂面', categoryName: '食品', cabinetName: '厨房吊柜', locationName: null }),
    snap({ id: 'k2', name: '洗洁精', categoryName: '清洁', cabinetName: '厨房吊柜', locationName: null }),
    snap({ id: 'k3', name: '炒锅', categoryName: '厨房', cabinetName: '灶台下', locationName: null }),
  ];

  const r = retrieve('厨房吊柜里有什么', kitchen, TODAY);
  assert.equal(r.intent.kind, 'location');
  assert.deepEqual(ids(r.items).sort(), ['k1', 'k2'], '吊柜里那两件都要给，含非「厨房」分类的');
});

test('位置类：分类同义词那条路没被上面那道闸挡掉', () => {
  const r = retrieve('露营装备放哪了', LIB, TODAY);
  assert.deepEqual(ids(r.items), ['d']);
});

test('★ 剥词用纯字符串替换，问题里带正则元字符也不该炸', () => {
  // 这里若改用正则替换，「(」「?」会把模式打断，轻则少剥一个词、重则抛错
  const q = '数据线(1米)在哪？';
  assert.doesNotThrow(() => extractSubject(q));
  assert.ok(extractSubject(q).includes('数据线'));
});

test('categoryOf：同义词表优先，其次是库里真实存在的分类名', () => {
  assert.equal(categoryOf('露营装备', LIB), '运动户外');
  assert.equal(categoryOf('渔具', [snap({ categoryName: '渔具' })]), '渔具');
  assert.equal(categoryOf('渔具', LIB), null);
  assert.equal(categoryOf('', LIB), null);
});

test('isFood：分类命中或名字里带食品类的字', () => {
  assert.equal(isFood(snap({ name: '电池', categoryName: '食品' })), true);
  assert.equal(isFood(snap({ name: '牛肉面', categoryName: '未分类' })), true);
  // 洗衣液不是吃的 —— 名字里没有食品类的字
  assert.equal(isFood(snap({ name: '洗衣液', categoryName: '清洁' })), false);
});

test('★★ 名字线索不能盖过用户自己填的分类（否则「能吃的」会混进这些）', () => {
  // 这四个都是被粗糙的名字线索误判过的真实例子：
  //   「面」→ 面膜    「粉」→ 洗衣粉     「水」→ 水龙头/墨水    「油」→ 机油
  assert.equal(isFood(snap({ name: '面膜', categoryName: '个护' })), false);
  assert.equal(isFood(snap({ name: '洗衣粉', categoryName: '清洁' })), false);
  assert.equal(isFood(snap({ name: '水龙头', categoryName: '家居' })), false);
  assert.equal(isFood(snap({ name: '机油', categoryName: '五金' })), false);
  // 自定义分类不在「明确非食品」表里，仍按名字判 —— 不能因为一个白名单把自定义分类误伤
  assert.equal(isFood(snap({ name: '挂面', categoryName: '粮油囤货' })), true);
  assert.equal(isFood(snap({ name: '大米', categoryName: null })), true);
});

test('★「1 米」是量词，不能把线材算成吃的', () => {
  // 未分类的数据线：没有分类可依据，只能靠名字 —— 而名字里的「米」是长度单位
  assert.equal(isFood(snap({ name: 'Type-C 数据线 1 米', categoryName: '未分类' })), false);
  assert.equal(isFood(snap({ name: '网线两米', categoryName: null })), false);
  // 但真的米还是要认出来
  assert.equal(isFood(snap({ name: '大米 5 斤', categoryName: null })), true);
});

/* ------------------------------------------------------------- 检索 */

test('★「还有什么能吃的」只给食品，且最该先吃的排第一', () => {
  const r = retrieve('家里还有什么能吃的', LIB, TODAY);
  assert.equal(r.intent.kind, 'expiring');
  assert.ok(!ids(r.items).includes('c'), '洗衣液混进了「能吃的」结果里');
  assert.ok(!ids(r.items).includes('e'), '「数据线 1 米」被那个「米」字算成了吃的');
  // 酸奶 3 天 < 牛肉面 84 天 < 酱油（没记到期时间，沉底）
  assert.deepEqual(ids(r.items), ['b', 'a', 'g']);
  assert.equal(r.total, 3);
  assert.ok(r.fact.includes('酸奶'), `fact 没点出最该先吃的那样：${r.fact}`);
  assert.ok(r.fact.includes('还剩 3 天'), `fact 没写还剩几天：${r.fact}`);
});

test('到期类：已过期的也算「要到期」，而且排在最前', () => {
  const r = retrieve('这个月哪些要到期', LIB, TODAY);
  // 只在窗口内：洗衣液(-5) 与 酸奶(3)；牛肉面 84 天在窗口外
  assert.deepEqual(ids(r.items), ['c', 'b']);
  assert.ok(r.fact.includes('已经过期 5 天'), `fact 没报已过期天数：${r.fact}`);
});

test('到期类：窗口收窄到今天就只剩已过期那天那样', () => {
  const r = retrieve('今天有什么到期的', LIB, TODAY);
  assert.deepEqual(ids(r.items), ['c']);
});

test('* 没填到期时间的物品不参与「即将到期」，而不是排到最后', () => {
  const r = retrieve('有什么要过期的', LIB, TODAY);
  assert.ok(!ids(r.items).some((id) => ['d', 'e', 'f', 'g'].includes(id)), '把没填到期时间的也算进来了');
});

test('位置类：命中分类时按分类给，位置从哪件物品上取', () => {
  const r = retrieve('露营装备放哪了', LIB, TODAY);
  assert.deepEqual(ids(r.items), ['d']);
  assert.ok(r.fact.includes('帐篷'), `fact 没点出物品名：${r.fact}`);
  assert.ok(r.fact.includes('储物间'), `fact 没报出位置：${r.fact}`);
});

test('位置类：同一种东西分布在多处时，数量与地点数都要写出来', () => {
  const spread = [
    snap({ id: 'x1', name: '数据线', categoryName: '数码', locationName: '书桌', createdAt: 1 }),
    snap({ id: 'x2', name: '数据线', categoryName: '数码', locationName: '客厅', createdAt: 2 }),
  ];
  const r = retrieve('数据线在哪', spread, TODAY);
  assert.equal(r.total, 2);
  assert.ok(r.fact.includes('2 个地方'), `fact 没写地点数：${r.fact}`);
});

test('位置类：都还没记位置时不能编一个出来', () => {
  const r = retrieve('数据线在哪', [snap({ id: 'x', name: '数据线', locationName: null, cabinetName: null })], TODAY);
  assert.ok(r.fact.includes('还没记位置'), `fact 编了位置：${r.fact}`);
});

test('成本类：日均与单价是两套口径，别混用', () => {
  const daily = retrieve('日均成本最高的是什么', LIB, TODAY);
  assert.ok(daily.fact.includes('日均成本最高'), daily.fact);
  assert.ok(daily.fact.includes('数据线'), daily.fact);
  assert.ok(daily.fact.includes('/天'), daily.fact);

  const price = retrieve('哪个最贵', LIB, TODAY);
  assert.ok(price.fact.includes('单价最高'), price.fact);
  assert.ok(price.fact.includes('¥39'), price.fact);
});

test('补货类：余量 ≤1 才算，用完了的要单独说', () => {
  const r = retrieve('有什么该买的吗', LIB, TODAY);
  assert.deepEqual(ids(r.items), ['f', 'g']);
  assert.ok(r.fact.includes('2 件该补货'), r.fact);
  assert.ok(r.fact.includes('1 件已经用完'), r.fact);
});

test('规模类：空库时也要给出确定的数字，不能是「没找到」', () => {
  const r = retrieve('一共多少件东西', [], TODAY);
  assert.equal(r.total, 0);
  assert.ok(r.fact.includes('共 0 件'), r.fact);
});

test('搜索类：命中与不命中各说各的', () => {
  const hit = retrieve('帐篷', LIB, TODAY);
  assert.deepEqual(ids(hit.items), ['d']);
  assert.ok(hit.fact.includes('1 条'), hit.fact);

  const miss = retrieve('吉他', LIB, TODAY);
  assert.deepEqual(miss.items, []);
  assert.ok(miss.fact.includes('没找到'), miss.fact);
});

test('★ 空库优先于一切意图：先说「先记几件」，别谈排序', () => {
  const r = retrieve('家里还有什么能吃的', [], TODAY);
  assert.ok(r.fact.includes('库里还是空的'), r.fact);
  assert.equal(r.items.length, 0);
});

test('unknown 要给得出可上手的三句话示例', () => {
  const r = retrieve('嗯', LIB, TODAY);
  assert.equal(r.intent.kind, 'unknown');
  assert.ok(r.fact.includes('没太听懂'), r.fact);
  assert.ok(r.fact.includes('能吃的'), '示例里应当出现「能吃的」这类可直接照抄的问法');
});

test('★ 候选超过上限就截断，但 total 报的是符合条件的全量', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    snap({ id: `m${i}`, name: `罐头${i}`, daysToExpiry: 1, createdAt: i }),
  );
  const r = retrieve('这个月哪些要到期', many, TODAY);
  assert.equal(r.items.length, MAX_ANSWER_ITEMS);
  assert.equal(r.total, 12);
  assert.ok(r.fact.includes('12 件'), `fact 该报全量而不是截断后的条数：${r.fact}`);
});

test('retrieve 不修改传进来的数组（排序发生在副本上）', () => {
  const before = ids(LIB);
  retrieve('这个月哪些要到期', LIB, TODAY);
  assert.deepEqual(ids(LIB), before);
});

/* --------------------------------------------------------- 文本匹配 */

test('textMatch：整词命中', () => {
  assert.equal(textMatch(snap({ name: 'Type-C 数据线 1 米' }), '数据线'), true);
  assert.equal(textMatch(snap({ name: '帐篷' }), '吉他'), false);
});

test('textMatch：每个字都出现也算（只对 ≥2 字的词）', () => {
  assert.equal(textMatch(snap({ name: '露营帐篷' }), '露帐'), true);
});

test('textMatch：空查询一律不匹配，免得把整个库翻出来', () => {
  assert.equal(textMatch(snap(), ''), false);
  assert.equal(textMatch(snap(), '   '), false);
});

test('textMatch：品牌、标签、备注也都在可搜范围里', () => {
  assert.equal(textMatch(snap({ name: '电池', brand: '南孚' }), '南孚'), true);
  assert.equal(textMatch(snap({ name: '电池', tags: ['备用'] }), '备用'), true);
  assert.equal(textMatch(snap({ name: '电池', note: '遥控器里那对' }), '遥控器'), true);
});

/* ------------------------------------------------------------- 小件 */

test('place：有柜子有格位就写成「厨房 · 橱柜2」', () => {
  assert.equal(place(snap({ cabinetName: '厨房', locationName: '橱柜2' })), '厨房 · 橱柜2');
  assert.equal(place(snap({ cabinetName: null, locationName: '橱柜2' })), '橱柜2');
  assert.equal(place(snap({ cabinetName: '厨房', locationName: null })), '厨房');
  assert.equal(place(snap({ cabinetName: null, locationName: null })), '还没记位置');
});

test('toSnapshot：只带问答用得上的字段，派生字段不外泄', () => {
  const view = {
    id: 'v1',
    name: '牛肉面',
    brand: '康师傅',
    categoryName: '食品',
    cabinetName: '厨房',
    locationName: '橱柜2',
    expireDate: '2026-12-31',
    daysToExpiry: 84,
    quantity: 2,
    tags: ['备用'],
    note: null,
    dailyCost: 1.2,
    holdingDays: 30,
    price: 36,
    createdAt: 42,
    // ↓ 这些是 ItemView 上对问答无用、刻意不进快照的字段
    coverThumb: 'thumbs/x.jpg',
    photoCount: 3,
  };
  const s = toSnapshot(view);
  assert.equal(s.name, '牛肉面');
  assert.equal(s.daysToExpiry, 84);
  assert.equal('coverThumb' in s, false, '照片相关的派生字段不该进快照');
  assert.equal('photoCount' in s, false, '照片数量不该进快照 —— 模型会把它当事实写进答案');
});
