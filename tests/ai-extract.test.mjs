/**
 * AI 两个「文本层」的测试：
 *   - extract.ts：识物与语音共用的字段抽取（抠 JSON → 折算字段 → 定 filled）
 *   - answer.ts ：问一问的提示词组装与模型回复清洗
 *
 * 这一层的错误同样是**静默**的，而且往往表现为「看起来挺正常」：
 *   - 分类名没在库里校验 → 界面显示一行点了选不中的分类
 *   - `filled` 把中转量也算上 → 界面报「AI 填了 N 项」，可有一项找不到对应的行
 *   - 到期日从「保质期 N 个月」推错 → 凭空多出一条用户没确认过的日期
 * 所以逐条钉。
 *
 * 两个模块都不碰 expo / react-native / db，可以在 node:test 里直接 import。
 * 网络在 client.ts、渲染在 app/ai.tsx 与 app/ask.tsx，不在本文件射程里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVisionPrompt,
  buildVoicePrompt,
  EMPTY_FIELDS,
  extractJson,
  LOW_CONFIDENCE_HINT,
  parseExtract,
} from '../src/lib/ai/extract.ts';

import {
  ANSWER_MAX_CHARS,
  buildAnswerPrompt,
  buildMatchPrompt,
  FOLLOW_UP_QUESTIONS,
  MATCH_MAX_ITEMS,
  matchFact,
  parseAnswer,
  parseMatch,
  shouldFullMatch,
  SUGGESTED_QUESTIONS,
} from '../src/lib/ai/answer.ts';

import { classify, retrieve } from '../src/lib/ai/retrieve.ts';

/** 固定「今天」，否则所有跟「保质期 N 个月」有关的断言会随时间漂移 */
const TODAY = '2026-10-08';
/** 库里真实存在的分类名 —— parseExtract 只认这份清单里的分类 */
const CATS = ['食品', '数码', '清洁', '运动户外'];

const ctx = { today: TODAY, categories: CATS };

/* ============================================================ extractJson */
/* 三家模型的「听话程度」不一样，三层兜底就是为这个写的 */

test('extractJson：标准 JSON 直接过', () => {
  assert.deepEqual(extractJson('{"name":"牛肉面"}'), { name: '牛肉面' });
});

test('extractJson：包在 ```json 围栏里也能救回来', () => {
  const raw = '好的。\n```json\n{"name":"牛肉面","brand":"康师傅"}\n```\n以上。';
  assert.deepEqual(extractJson(raw), { name: '牛肉面', brand: '康师傅' });
});

test('extractJson：不带 json 标记的围栏同样认', () => {
  assert.deepEqual(extractJson('```\n{"name":"x"}\n```'), { name: 'x' });
});

test('extractJson：前面带一句「这是结果：」时，取首个 { 到末个 }', () => {
  assert.deepEqual(extractJson('这是结果：{"name":"牛肉面"} 请查收'), { name: '牛肉面' });
});

test('extractJson：包在数组里也能救回来（第三层兜底会把外层剥掉）', () => {
  // 有些模型会把单个对象再套一个数组。第 ③ 层「首个 { 到末个 }」正好把它剥出来 ——
  // 这是想要的救援，不是漏判，所以这里钉的是「救得回来」
  assert.deepEqual(extractJson('[{"name":"x"}]'), { name: 'x' });
});

test('extractJson：数组里多个对象救不回来，当解析失败', () => {
  assert.equal(extractJson('[{"name":"x"},{"name":"y"}]'), null);
});

test('extractJson：彻底读不出来时返回 null，**不抛错**', () => {
  assert.equal(extractJson('我不知道该怎么回答'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson(undefined), null);
  assert.doesNotThrow(() => extractJson('{ 半截的'));
});

/* =========================================================== parseExtract */

test('parseExtract：一份完整的回复要落到对字段上', () => {
  const r = parseExtract(
    {
      name: '康师傅老陈醋酸辣牛肉面',
      brand: '康师傅',
      model: '大食袋',
      category: '食品',
      quantity: 5,
      expireDate: '2026-12-31',
      tags: ['泡面', '宵夜'],
      note: '放在最上层',
      confidence: 0.9,
    },
    ctx,
  );

  assert.equal(r.fields.name, '康师傅老陈醋酸辣牛肉面');
  assert.equal(r.fields.brand, '康师傅');
  assert.equal(r.fields.model, '大食袋');
  assert.equal(r.fields.categoryName, '食品');
  assert.equal(r.fields.quantity, 5);
  assert.equal(r.fields.expireDate, '2026-12-31');
  assert.deepEqual(r.fields.tags, ['泡面', '宵夜']);
  assert.equal(r.confidence, 0.9);
});

test('parseExtract：购买日期与价格也要落上', () => {
  const r = parseExtract({ name: '电脑', purchaseDate: '2026-10-01', price: 5000 }, ctx);
  assert.equal(r.fields.purchaseDate, '2026-10-01');
  assert.equal(r.fields.price, 5000);
  assert.ok(r.filled.includes('purchaseDate'));
  assert.ok(r.filled.includes('price'));
});

test('价格：字符串与带符号都能读出来（让模型只输出数字是一句愿望，不是保证）', () => {
  assert.equal(parseExtract({ name: 'x', price: '28' }, ctx).fields.price, 28);
  assert.equal(parseExtract({ name: 'x', price: '¥1,999' }, ctx).fields.price, 1999);
  assert.equal(parseExtract({ name: 'x', price: '18.5元' }, ctx).fields.price, 18.5);
});

test('★ 价格：0 与离谱的大数一律当没填 —— 它会进档案、还参与日均成本', () => {
  /* 静默的成本：填错了用户不会去看那个字段，而日均成本会跟着一起错。
     宁可留空让他点一下补上。 */
  assert.equal(parseExtract({ name: 'x', price: 0 }, ctx).fields.price, null);
  assert.equal(parseExtract({ name: 'x', price: -5 }, ctx).fields.price, null);
  assert.equal(parseExtract({ name: 'x', price: 99999999 }, ctx).fields.price, null);
  assert.equal(parseExtract({ name: 'x', price: '不知道' }, ctx).fields.price, null);
});

test('购买日期：格式不对就当没填（不能把一个半截日期写进库）', () => {
  assert.equal(parseExtract({ name: 'x', purchaseDate: '昨天' }, ctx).fields.purchaseDate, null);
  assert.equal(parseExtract({ name: 'x', purchaseDate: '2026-13-45' }, ctx).fields.purchaseDate, null);
});

test('★ 分类名必须能在库里找到，找不到就当它没填', () => {
  // 放行的话，界面会显示一行「食品」却点不中（库里没有这个分类）
  const r = parseExtract({ name: '牛肉面', category: '生鲜' }, ctx);
  assert.equal(r.fields.categoryName, null);
  assert.ok(!r.filled.includes('categoryName'), '找不到的分类名不该出现在 filled 里');
});

test('到期日两条来源：包装上印的优先于按保质期推算的', () => {
  const r = parseExtract({ name: '牛奶', expireDate: '2026-11-01', shelfLifeMonths: 6 }, ctx);
  assert.equal(r.fields.expireDate, '2026-11-01');
});

test('只有「保质期 N 个月」时，从今天往后推', () => {
  const r = parseExtract({ name: '牛奶', shelfLifeMonths: 6 }, ctx);
  assert.equal(r.fields.expireDate, '2027-04-08');
});

test('保质期认「半年」「一年半」中文写法（与语音共用一套数字规则）', () => {
  assert.equal(parseExtract({ name: '酱油', shelfLifeMonths: '半年' }, ctx).fields.expireDate, '2027-04-08');
  // 18 个月 —— 若 cnToNumber 没接住，「一年半」会退化成 12 个月且不报错
  assert.equal(parseExtract({ name: '酱油', shelfLifeMonths: '一年半' }, ctx).fields.expireDate, '2028-04-08');
});

test('写着「保质期到 2026年12月31日」这种整句也能抽出日期', () => {
  const r = parseExtract({ name: '牛奶', expireDate: '保质期到 2026年12月31日' }, ctx);
  assert.equal(r.fields.expireDate, '2026-12-31');
});

test('过期日期的两个来源都没给 → 留空，绝不替用户猜一个', () => {
  const r = parseExtract({ name: '牛奶' }, ctx);
  assert.equal(r.fields.expireDate, null);
  assert.equal(r.fields.shelfLifeMonths, null);
});

test('★ filled 里不能有 shelfLifeMonths —— 它只是推算到期日的中转量，表单里没有这一行', () => {
  const r = parseExtract({ name: '牛奶', shelfLifeMonths: 6 }, ctx);
  assert.ok(!r.filled.includes('shelfLifeMonths'), `filled 里混进了中转量：${r.filled.join(',')}`);
  assert.ok(r.filled.includes('expireDate'), '推出来的到期日应当算已填');
});

test('filled 只装真给了值的字段', () => {
  const r = parseExtract({ name: '牛肉面', confidence: 0.5 }, ctx);
  assert.deepEqual(r.filled.sort(), ['name']);
});

test('★ 一个字段都没读出来 → 返回 null（界面才好说「没读出来」）', () => {
  assert.equal(parseExtract({ confidence: 0.9 }, ctx), null);
  assert.equal(parseExtract({}, ctx), null);
});

test('模型把整个对象写成字符串也要认（有些模型会把 JSON 再包一层引号）', () => {
  const r = parseExtract('{"name":"牛肉面"}', ctx);
  assert.equal(r.fields.name, '牛肉面');
});

test('非对象输入一律当失败，别让它把 undefined 当成字段名', () => {
  assert.equal(parseExtract([], ctx), null);
  assert.equal(parseExtract(null, ctx), null);
  assert.equal(parseExtract('说不好', ctx), null);
});

test('数量：只收正整数；0 与负数等于没说', () => {
  assert.equal(parseExtract({ name: 'x', quantity: 3 }, ctx).fields.quantity, 3);
  assert.equal(parseExtract({ name: 'x', quantity: '2包' }, ctx).fields.quantity, 2);
  assert.equal(parseExtract({ name: 'x', quantity: 0 }, ctx).fields.quantity, null);
  assert.equal(parseExtract({ name: 'x', quantity: -1 }, ctx).fields.quantity, null);
});

test('标签：只收数组、单条不超过 12 字、最多 6 条', () => {
  const r = parseExtract(
    { name: 'x', tags: ['a', '', '这个标签实在是太长了超过十二个字了吧', 3, ...'bcdefgh'.split('')] },
    ctx,
  );
  assert.equal(r.fields.tags.length, 6);
  assert.ok(r.fields.tags.every((t) => t.length <= 12));
  assert.ok(r.fields.tags.includes('a'));
  // 数字会被转成字符串留下，空串被丢掉
  assert.ok(!r.fields.tags.includes(''));
});

test('confidence 一律钳到 0~1；读不出来就是 null（界面据此决定要不要说「把握不大」）', () => {
  assert.equal(parseExtract({ name: 'x', confidence: 1.5 }, ctx).confidence, 1);
  assert.equal(parseExtract({ name: 'x', confidence: -0.2 }, ctx).confidence, 0);
  assert.equal(parseExtract({ name: 'x', confidence: '0.8' }, ctx).confidence, 0.8);
  assert.equal(parseExtract({ name: 'x', confidence: '很有把握' }, ctx).confidence, null);
  assert.equal(parseExtract({ name: 'x' }, ctx).confidence, null);
});

/* ============================================================= 提示词 */

test('两个提示词共用同一段输出格式与同一套诚实规则', () => {
  const vision = buildVisionPrompt(CATS);
  const voice = buildVoicePrompt(CATS);

  for (const prompt of [vision, voice]) {
    // 反幻觉那四句是整段提示词里最值钱的部分，缺了它模型会替你猜保质期
    assert.ok(prompt.includes('绝对不要猜测或编造'), '缺了「不要编造」这条');
    assert.ok(prompt.includes('不要根据常识推测保质期'), '缺了「不要猜保质期」这条');
    // 输出形状必须一致，否则解析层要分叉
    assert.ok(prompt.includes('"shelfLifeMonths"'));
    assert.ok(prompt.includes('"category"'));
    assert.ok(prompt.includes(CATS.join('、')), '没把库里的分类名告诉模型');
  }
});

test('提示词里没有可选分类时不留一个空列表（那会让模型自己造分类）', () => {
  assert.ok(buildVisionPrompt([]).includes('（没有可选分类）'));
});

test('语音提示词要额外交代「别补充他没提到的」', () => {
  // 少了这句，模型容易把它当成商品检索词去补全，编出没说过的东西
  assert.ok(buildVoicePrompt(CATS).includes('不要补充他没提到的'));
  assert.ok(!buildVisionPrompt(CATS).includes('不要补充他没提到的'));
});

/* ============================================================ parseAnswer */

test('parseAnswer：正常的一句话原样通过，多余空白被压掉', () => {
  assert.equal(parseAnswer('  你的酸奶还剩 3 天，先喝它。  '), '你的酸奶还剩 3 天，先喝它。');
  assert.equal(parseAnswer('第一句。\n\n第二句。'), '第一句。 第二句。');
});

test('parseAnswer：带 markdown 结构的一律丢掉（说明它没照要求来）', () => {
  assert.equal(parseAnswer('- 酸奶还剩 3 天'), null);
  assert.equal(parseAnswer('* 酸奶还剩 3 天'), null);
  assert.equal(parseAnswer('# 总结\n酸奶快到期了'), null);
  // ★ 有序列表是最容易从缝里漏过去的一种：模型真要不听话，写的就是这个形式
  assert.equal(parseAnswer('1. 酸奶\n2. 牛肉面'), null);
  assert.equal(parseAnswer('2) 牛肉面'), null);
});

test('parseAnswer：句子里带「3 天」这种数字不算 markdown，别误伤', () => {
  assert.equal(parseAnswer('你的酸奶还剩 3 天'), '你的酸奶还剩 3 天');
  // 连字符在词中间（Type-C）也不该被当成列表符号
  assert.equal(parseAnswer('Type-C 数据线还有 2 根'), 'Type-C 数据线还有 2 根');
});

test('parseAnswer：太长的一律丢掉 —— 要滚动才能读完的「一句回答」已经跑偏', () => {
  assert.equal(parseAnswer('好'.repeat(ANSWER_MAX_CHARS + 1)), null);
  assert.equal(parseAnswer('好'.repeat(ANSWER_MAX_CHARS)), '好'.repeat(ANSWER_MAX_CHARS));
});

test('parseAnswer：空值与非字符串都返回 null', () => {
  assert.equal(parseAnswer(''), null);
  assert.equal(parseAnswer('   '), null);
  assert.equal(parseAnswer(null), null);
  assert.equal(parseAnswer(undefined), null);
  assert.equal(parseAnswer(42), null);
});

test('parseAnswer：代码块里的内容被剔掉后若什么都不剩，就算没用', () => {
  assert.equal(parseAnswer('```json\n{"a":1}\n```'), null);
});

/* ======================================================== 提示词组装 */

/** 造一份 retrieve 的结果，只关心 buildAnswerPrompt 怎么用它 */
function fakeRetrieval(over = {}) {
  return {
    question: '家里还有什么能吃的',
    intent: { kind: 'expiring', withinDays: Number.POSITIVE_INFINITY, food: true },
    items: [
      {
        id: 'b',
        name: '酸奶',
        brand: null,
        categoryName: '食品',
        cabinetName: '厨房',
        locationName: '橱柜2',
        expireDate: '2026-10-11',
        daysToExpiry: 3,
        quantity: null,
        tags: [],
        note: null,
        dailyCost: null,
        holdingDays: null,
        price: null,
        createdAt: 200,
      },
    ],
    total: 1,
    fact: '按保质期先后排了下，这几样先吃最划算：「酸奶」还剩 3 天，在厨房 · 橱柜2。',
    ...over,
  };
}

test('buildAnswerPrompt：反幻觉那几条一个字都不能少', () => {
  const { system } = buildAnswerPrompt('x', fakeRetrieval(), 7);
  assert.ok(system.includes('只能使用给定事实里出现过的信息'), '★ 这一条是整套可信度的支点');
  assert.ok(system.includes('照实说没找到'), '★ 没找到时不许安慰、不许编造');
  assert.ok(system.includes('不要用 markdown'));
});

test('★ 措辞松了，但「别把清单抄一遍」这条没松', () => {
  const { system } = buildAnswerPrompt('x', fakeRetrieval(), 7);

  /* 2026-10-09：原来写的是「不要列举物品清单」，把模型逼成了复读机 ——
     它只能说「有几件快到期」，不能说「酸奶和牛奶快到期了」。
     现在允许点名一两件，只禁止抄清单。下面两条一起钉住这个新口径。 */
  assert.ok(system.includes('最相关的一两件'), '要允许它点名，否则答案永远是「有几件…」');
  assert.ok(system.includes('不要把清单抄一遍'), '仍然不许把全部结果抄一遍 —— 界面已经用卡片展示了');

  /* 顺序与字数都放宽了，但都要有明确的边界，不能含糊 */
  assert.ok(/一到两句话/.test(system));
});

test('buildAnswerPrompt：事实与候选清单都要铺进 user，日期要写成中文口径', () => {
  const { user } = buildAnswerPrompt('家里还有什么能吃的', fakeRetrieval(), 7);
  assert.ok(user.includes('【已确定的事实】'));
  assert.ok(user.includes('还剩 3 天'));
  assert.ok(user.includes('厨房 · 橱柜2'));
  assert.ok(user.includes('共 7 件物品'), '要告诉模型库里一共有多少件，它说话才有分寸');
  assert.ok(user.includes('家里还有什么能吃的'));
});

test('buildAnswerPrompt：没命中任何物品时明说，免得模型自己补一个', () => {
  const { user } = buildAnswerPrompt('x', fakeRetrieval({ items: [], total: 0 }), 7);
  assert.ok(user.includes('本次没有命中任何物品'));
});

/* ================================================ 空白态那几条必须真能用 */
/* ★ 这一组是整份文件里最有价值的：建议是给用户点的，点下去若落进
   「没太听懂」或「没找到」，用户会认为整个 AI 是坏的 —— 而它不报错。 */

/** 一册刚好装得下这些问题的库 */
const LIB = [
  {
    id: 'b',
    name: '酸奶',
    brand: null,
    categoryName: '食品',
    cabinetName: '厨房',
    locationName: '橱柜2',
    expireDate: '2026-10-11',
    daysToExpiry: 3,
    quantity: null,
    tags: [],
    note: null,
    dailyCost: null,
    holdingDays: null,
    price: null,
    createdAt: 200,
  },
  {
    id: 'e',
    name: '充电线',
    brand: null,
    categoryName: '数码',
    cabinetName: '书桌',
    locationName: '抽屉',
    expireDate: null,
    daysToExpiry: null,
    quantity: null,
    tags: [],
    note: null,
    dailyCost: 0.5,
    holdingDays: 78,
    price: 39,
    createdAt: 500,
  },
  {
    id: 'd',
    name: '帐篷',
    brand: null,
    categoryName: '运动户外',
    cabinetName: '储物间',
    locationName: null,
    expireDate: null,
    daysToExpiry: null,
    quantity: null,
    tags: [],
    note: null,
    dailyCost: null,
    holdingDays: null,
    price: null,
    createdAt: 400,
  },
  {
    id: 'f',
    name: '纸巾',
    brand: null,
    categoryName: '清洁',
    cabinetName: '阳台',
    locationName: null,
    expireDate: null,
    daysToExpiry: null,
    quantity: 0,
    tags: [],
    note: null,
    dailyCost: null,
    holdingDays: null,
    price: null,
    createdAt: 600,
  },
];

test('★ 空白态的四条建议，每一条都要落到一个真意图上（不能是 unknown）', () => {
  for (const q of SUGGESTED_QUESTIONS) {
    const intent = classify(q, LIB);
    assert.notEqual(intent.kind, 'unknown', `建议「${q}」被判成了听不懂`);
  }
});

test('★ 空白态的四条建议，每一条都要能命中库里真有的东西', () => {
  for (const q of SUGGESTED_QUESTIONS) {
    const r = retrieve(q, LIB, TODAY);
    assert.ok(r.items.length > 0, `建议「${q}」没命中任何物品：${r.fact}`);
    assert.ok(!r.fact.includes('没找到'), `建议「${q}」回了没找到：${r.fact}`);
  }
});

test('★ 回答后的三条跟随建议同样要真能用', () => {
  for (const q of FOLLOW_UP_QUESTIONS) {
    const intent = classify(q, LIB);
    assert.notEqual(intent.kind, 'unknown', `跟随建议「${q}」被判成了听不懂`);

    const r = retrieve(q, LIB, TODAY);
    assert.ok(!r.fact.includes('没找到'), `跟随建议「${q}」回了没找到：${r.fact}`);
  }
});

test('★「找一下我的充电线」要能真的找到那根线（动词得剥干净）', () => {
  const r = retrieve('找一下我的充电线', LIB, TODAY);
  assert.ok(
    r.items.some((it) => it.name === '充电线'),
    `抽出来的查询词带着动词，匹配不上：${r.fact}`,
  );
});

test('★ 库空时那几条建议仍然不该崩，只是照实说「先记几件」', () => {
  for (const q of SUGGESTED_QUESTIONS) {
    const r = retrieve(q, [], TODAY);
    assert.equal(r.items.length, 0);
    assert.ok(typeof r.fact === 'string' && r.fact.length > 0);
  }
});

test('EMPTY_FIELDS 与 LOW_CONFIDENCE_HINT 是给调用方用的公开出口', () => {
  /* compose.tsx 在「照片落盘了但没读出字段」时要把一个空的 fields 交回去。
     ★ 这一条是**字段集合的快照**：往 ExtractedFields 加字段时它会红，
     那是故意的 —— 提醒你回来看一眼「新字段在这里该不该是空」。 */
  assert.deepEqual(EMPTY_FIELDS, {
    name: null,
    brand: null,
    model: null,
    categoryName: null,
    quantity: null,
    purchaseDate: null,
    price: null,
    expireDate: null,
    shelfLifeMonths: null,
    tags: [],
    note: null,
  });
  assert.ok(LOW_CONFIDENCE_HINT.length > 0);
});

/* ============================================================ 全量对账兜底 */
/* 本地检索零命中时，把全库清单发给模型**挑序号**。模型只做语义匹配，
   数字、排序、措辞全在本机 —— 所以这里钉的是三件事：
   提示词只准它输出编号数组 / 编号要经校验 / 什么时候才值得走这条路。 */

const MATCH_LIB = [
  { id: 'a1', name: '摇粒绒外套', brand: '优衣库', categoryName: '服饰', cabinetName: '卧室衣柜', locationName: '挂衣区', expireDate: null, daysToExpiry: null, quantity: null, tags: [], note: null, dailyCost: null, holdingDays: null, price: 199, createdAt: 100 },
  { id: 'a2', name: '格纹衬衫', brand: '优衣库', categoryName: '服饰', cabinetName: '卧室衣柜', locationName: '顶层收纳', expireDate: null, daysToExpiry: null, quantity: null, tags: [], note: null, dailyCost: null, holdingDays: null, price: 149, createdAt: 200 },
  { id: 'a3', name: 'Type-C 数据线', brand: null, categoryName: '数码', cabinetName: '书桌', locationName: '抽屉', expireDate: null, daysToExpiry: null, quantity: null, tags: [], note: null, dailyCost: null, holdingDays: null, price: 39, createdAt: 300 },
];

test('buildMatchPrompt：全库都进清单、每件带序号，且只准模型输出编号数组', () => {
  const p = buildMatchPrompt('我有几件衣服', MATCH_LIB);
  assert.ok(p.user.includes('【物品清单】（共 3 件）'), p.user);
  assert.ok(p.user.includes('1. 摇粒绒外套｜服饰｜卧室衣柜 · 挂衣区'), p.user);
  assert.ok(p.system.includes('只准输出一个 JSON 编号数组'), '系统提示词必须把输出形式焊死');
  assert.ok(p.system.includes('对不上任何条目就输出 []'), '零命中也要有明确出口');
});

test('parseMatch：正常编号通过，序号转成从 1 起的下标语义', () => {
  assert.deepEqual(parseMatch('[1,3]', 3), [1, 3]);
  assert.deepEqual(parseMatch('好的：[2]', 3), [2], '模型夹带的前缀文字要能剥掉');
});

test('★ parseMatch：越界、重复、编造、非数组一律拦掉', () => {
  assert.deepEqual(parseMatch('[1, 4]', 3), [1], '越界编号丢弃');
  assert.deepEqual(parseMatch('[1,1,2]', 3), [1, 2], '重复丢弃');
  assert.deepEqual(parseMatch('[1, "x", true]', 3), [1], '非编号元素丢弃');
  assert.deepEqual(parseMatch('我觉得应该是衣服那几件', 3), [], '没给数组就全部丢弃');
  assert.deepEqual(parseMatch(null, 3), []);
  assert.deepEqual(parseMatch('[0, -1]', 3), [], '序号从 1 起，0 和负数无效');
});

test('shouldFullMatch：只兜「找 / 数」类零命中，正当的「没有」不再花钱问模型', () => {
  assert.equal(shouldFullMatch({ kind: 'search', query: '潮牌' }, 96), true);
  assert.equal(shouldFullMatch({ kind: 'location', query: '充电线', categoryName: null }, 96), true);
  assert.equal(shouldFullMatch({ kind: 'count', subject: '潮牌', categoryName: null }, 96), true);
  assert.equal(shouldFullMatch({ kind: 'count', subject: null, categoryName: null }, 96), false, '全库总账本地答得出');
  assert.equal(shouldFullMatch({ kind: 'expiring', withinDays: 30, food: false }, 96), false, '「没有到期的」是正当答案');
  assert.equal(shouldFullMatch({ kind: 'lowStock' }, 96), false);
  assert.equal(shouldFullMatch({ kind: 'unknown' }, 96), false);
  assert.equal(shouldFullMatch({ kind: 'search', query: 'x' }, 0), false, '空库没有可对账的');
  assert.equal(shouldFullMatch({ kind: 'search', query: 'x' }, MATCH_MAX_ITEMS + 1), false, '超大库不做全量，清单太长模型挑漏');
});

test('matchFact：措辞由本机写，模型一个字的事实都不进答案', () => {
  const items = [MATCH_LIB[0], MATCH_LIB[1]];
  const fact = matchFact(items);
  assert.ok(fact.includes('对出 2 件'), fact);
  assert.ok(fact.includes('摇粒绒外套'), fact);
  assert.equal(matchFact([]), '你的库里没有对得上的东西。');
});
