/**
 * 语音结构化解析的测试。
 *
 * 这一层的每一条错误都是**静默**的：名称多剥两个字、到期少算一个月、
 * 把「三年前」当成保质期 —— 都不抛异常、不红屏，用户只会发现
 * 「记下来的东西不对」，然后不再用语音。所以逐条钉。
 *
 * 只 import `src/lib/ai/voice-parse.ts`（纯函数，不碰 expo / react-native / db）。
 * 识别本身（asr.ts）不在本文件射程里：它要真机才能跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cnToNumber, parseVoiceInput, toLocationHints } from '../src/lib/ai/voice-parse.ts';

/** 固定「今天」，否则所有跟年底 / 下个月有关的断言会随时间漂移 */
const TODAY = '2026-10-08';

const KITCHEN = { id: 'c-kitchen', name: '厨房', parentId: null };
const SLOT = { id: 's-cab2', name: '橱柜2', parentId: 'c-kitchen' };
const DESK = { id: 'c-desk', name: '书桌', parentId: null };
const DRAWER = { id: 's-drawer', name: '抽屉', parentId: 'c-desk' };

const ctx = (locations = [KITCHEN, SLOT, DESK, DRAWER]) => ({
  locations: toLocationHints(locations),
  today: TODAY,
});

/* ------------------------------------------------------- 05 屏那句原话 */

test('设计稿原句：位置、名称、到期三样都要对', () => {
  const r = parseVoiceInput('厨房橱柜二放了一包牛肉面，保质期到年底', ctx());

  assert.equal(r.name, '牛肉面');
  // 库里存的是「橱柜2」，人说的是「橱柜二」—— 这一条要是挂了，
  // 等于只有把位置名念成阿拉伯数字的人才能用语音
  assert.equal(r.locationId, SLOT.id);
  assert.equal(r.locationText, '厨房橱柜二');
  assert.equal(r.expireDate, '2026-12-31');
});

test('名称里不能残留「保质期到」这类残缺片段', () => {
  const r = parseVoiceInput('厨房橱柜二放了一包牛肉面，保质期到年底', ctx());
  assert.ok(!r.name.includes('保质期'), `名称里混进了线索词：${r.name}`);
  assert.ok(!r.name.includes('年到'), `名称里混进了残缺片段：${r.name}`);
});

/* ------------------------------------------------------------- 位置 */

test('最长的位置优先：有「厨房橱柜2」就不该被「厨房」抢走', () => {
  const r = parseVoiceInput('厨房橱柜二放了一包牛肉面', ctx());
  assert.equal(r.locationId, SLOT.id);
});

test('只说柜子层级也能命中（不强迫用户非要说到格位）', () => {
  const r = parseVoiceInput('厨房里放了一包牛肉面', ctx());
  assert.equal(r.locationId, KITCHEN.id);
});

test('库里存中文数字、人念阿拉伯数字，同样要命中', () => {
  const hints = toLocationHints([{ id: 's-2', name: '橱柜二', parentId: null }]);
  const r = parseVoiceInput('橱柜2里有一包牛肉面', { locations: hints, today: TODAY });
  assert.equal(r.locationId, 's-2');
});

test('位置表为空时不能崩，也不能凭空编一个 id 出来', () => {
  const r = parseVoiceInput('厨房橱柜二放了一包牛肉面', { locations: [], today: TODAY });
  assert.equal(r.locationId, null);
  assert.equal(r.locationText, null);
  assert.ok(r.name.length > 0, '名称不能因为没匹配到位置就变空');
});

test('位置表为空时，位置名会留在名称里（宁可留着让用户删，也不要偷偷丢掉）', () => {
  const r = parseVoiceInput('厨房放了一包牛肉面', { locations: [], today: TODAY });
  assert.ok(r.name.includes('厨房'), `名称：${r.name}`);
});

/* ------------------------------------------------------------- 到期 */

const expiryOf = (text) => parseVoiceInput(text, ctx()).expireDate;

test('完整年月日：三种分隔符都认', () => {
  assert.equal(expiryOf('牛奶保质期到 2026-12-31'), '2026-12-31');
  assert.equal(expiryOf('牛奶保质期到 2026/12/31'), '2026-12-31');
  assert.equal(expiryOf('牛奶2026年12月31日到期'), '2026-12-31');
});

test('只给到年月时，取该月最后一天', () => {
  assert.equal(expiryOf('牛奶保质期到 2027年2月'), '2027-02-28');
  assert.equal(expiryOf('牛奶保质期到 2026年12月'), '2026-12-31');
});

test('相对时长：天 / 月 / 年 / 半年 / 一年半', () => {
  assert.equal(expiryOf('牛奶保质期还有三天'), '2026-10-11');
  assert.equal(expiryOf('牛奶保质期还有三个月'), '2027-01-08');
  assert.equal(expiryOf('电池保质期两年'), '2028-10-08');
  assert.equal(expiryOf('药保质期半年'), '2027-04-08');
  assert.equal(expiryOf('药保质期一年半'), '2028-04-08');
});

test('年底 / 明年 X 月 / 月底', () => {
  assert.equal(expiryOf('牛肉面保质期到年底'), '2026-12-31');
  assert.equal(expiryOf('牛肉面保质期到明年底'), '2027-12-31');
  assert.equal(expiryOf('牛肉面保质期到明年三月'), '2027-03-31');
  assert.equal(expiryOf('牛肉面保质期到下个月底'), '2026-11-30');
});

test('只说月份：已经过去的月份顺延到明年', () => {
  // 今天是 10 月，所以「9 月」只能是明年 9 月
  assert.equal(expiryOf('牛肉面保质期到9月'), '2027-09-30');
  assert.equal(expiryOf('牛肉面保质期到11月'), '2026-11-30');
});

test('月日：今年还没到就用今年，已经过了就顺延', () => {
  assert.equal(expiryOf('牛肉面保质期到12月31日'), '2026-12-31');
  assert.equal(expiryOf('牛肉面保质期到3月8日'), '2027-03-08');
});

/* -------------------------------------------------- 不该乱认的一些话 */

test('★ 「三年前买的」不能被当成保质期', () => {
  assert.equal(expiryOf('我三年前买的相机'), null);
});

test('★ 没有保质期线索时，「三月的机票」不解析成到期', () => {
  assert.equal(expiryOf('我买了三月的机票'), null);
});

test('★ 「年底搬家的箱子」不解析成到期（哪怕字面跟「保质期到年底」一样）', () => {
  assert.equal(expiryOf('年底搬家的收纳箱'), null);
});

test('没有可辨认的到期信息时，三个字段都留空而不是硬凑', () => {
  const r = parseVoiceInput('博世冲击钻', ctx());
  assert.equal(r.expireDate, null);
  assert.equal(r.expireText, null);
  assert.equal(r.locationId, null);
  assert.equal(r.name, '博世冲击钻');
});

/* ------------------------------------------------------------- 名称 */

test('★ 「放大镜」不能被剥成「大镜」（单字动词不做头部剥离）', () => {
  const r = parseVoiceInput('放大镜放在书桌抽屉里', ctx());
  assert.equal(r.name, '放大镜');
  assert.equal(r.locationId, DRAWER.id);
});

test('★ 「收纳盒」「装箱单」这类词头同样不能被吃', () => {
  assert.equal(parseVoiceInput('收纳盒', ctx()).name, '收纳盒');
  assert.equal(parseVoiceInput('装箱单', ctx()).name, '装箱单');
});

test('★ 「一次性手套」不能被当成「一 + 量词」剥掉一个字', () => {
  assert.equal(parseVoiceInput('一次性手套', ctx()).name, '一次性手套');
});

test('数量 + 量词要剥掉：一包牛肉面 → 牛肉面', () => {
  const r = parseVoiceInput('书桌抽屉里放了一包牛肉面', ctx());
  assert.equal(r.name, '牛肉面');
  assert.equal(r.locationId, DRAWER.id);
});

test('★ 位置后面的方位词不能粘进名称（「抽屉里」的「里」）', () => {
  assert.equal(parseVoiceInput('书桌抽屉里放了一包牛肉面', ctx()).name, '牛肉面');
  assert.equal(parseVoiceInput('厨房里有一包牛肉面', ctx()).name, '牛肉面');
});

test('「有」后面的数量词也要能剥掉（有一包牛肉面 → 牛肉面）', () => {
  const hints = toLocationHints([{ id: 's-2', name: '橱柜二', parentId: null }]);
  const r = parseVoiceInput('橱柜2里有一包牛肉面', { locations: hints, today: TODAY });
  assert.equal(r.locationId, 's-2');
  assert.equal(r.name, '牛肉面');
});

test('★ 「有机食品」里的「有」不能被当成口头语剥掉', () => {
  assert.equal(parseVoiceInput('有机食品', ctx()).name, '有机食品');
});

test('多层口头语一次剥干净', () => {
  const r = parseVoiceInput('我把新买的黑色耳机放到书桌抽屉里了', ctx());
  assert.equal(r.name, '黑色耳机');
  assert.equal(r.locationId, DRAWER.id);
});

test('名称剥空时要有兜底，绝不能返回空串（名称是必填字段）', () => {
  const r = parseVoiceInput('保质期到年底', ctx());
  assert.ok(r.name.length > 0, '剥成空之后必须回退到原文');
  assert.equal(r.expireDate, '2026-12-31');
});

test('空串与纯空白不崩，返回全空', () => {
  /* ★ 同样是**字段集合的快照**：加字段时它会红，提醒你确认新字段的「空」长什么样。 */
  for (const input of ['', '   ']) {
    const r = parseVoiceInput(input, ctx());
    assert.deepEqual(r, {
      name: '',
      locationId: null,
      locationText: null,
      expireDate: null,
      expireText: null,
      price: null,
      priceText: null,
      purchaseDate: null,
      purchaseText: null,
      quantity: null,
      quantityText: null,
    });
  }
});

/* ------------------------------------------------------------ 工具函数 */

test('cnToNumber 覆盖个位、十位、二十几与「两」', () => {
  assert.equal(cnToNumber('三'), 3);
  assert.equal(cnToNumber('两'), 2);
  assert.equal(cnToNumber('十'), 10);
  assert.equal(cnToNumber('十二'), 12);
  assert.equal(cnToNumber('二十'), 20);
  assert.equal(cnToNumber('二十五'), 25);
  assert.equal(cnToNumber('12'), 12);
  assert.equal(cnToNumber('半'), 0.5);
  assert.equal(cnToNumber('火锅'), null);
});

test('toLocationHints 把格位挂到柜子名上', () => {
  const hints = toLocationHints([KITCHEN, SLOT]);
  assert.deepEqual(hints, [
    { id: 'c-kitchen', name: '厨房', parentName: null },
    { id: 's-cab2', name: '橱柜2', parentName: '厨房' },
  ]);
});

test('位置表的顺序不能影响结果（先出现的短名不许抢长的）', () => {
  const reversed = toLocationHints([SLOT, KITCHEN]);
  const r = parseVoiceInput('厨房橱柜二放了一包牛肉面', { locations: reversed, today: TODAY });
  assert.equal(r.locationId, SLOT.id);
});

/* ================================================== 价格 / 购买日期 / 库存 */

/*
 * 这一组是照真机反馈补的：用户说「客厅有一台电脑价格5000元」，
 * 名称成了整句话 —— 因为这三项在语音链路里**根本不存在**，整段都被当成名称。
 *
 * ★★ 而它们的共同风险是**静默出错**：
 *   价格与数量写错会直接进档案（价格还参与日均成本），
 *   用户要过很久才可能发现。所以下面每一条「不该认」的用例，
 *   与「该认」的一样重要。
 */

test('★ 用户那句原话：名称/位置/价格三样都要对', () => {
  /* 位置要在表里才认得出 —— 客厅是用户自己建的柜子，这里临时加一个 */
  const LIVING = { id: 'c-living', name: '客厅', parentId: null };
  const r = parseVoiceInput('客厅有一台电脑价格5000元', ctx([LIVING, KITCHEN]));

  assert.equal(r.name, '电脑');
  assert.equal(r.locationId, 'c-living');
  assert.equal(r.price, 5000);
});

test('价格：线索词后面接中文数字也认', () => {
  assert.equal(parseVoiceInput('花了两千买了个电脑', ctx()).price, 2000);
  assert.equal(parseVoiceInput('花了五千买了个电脑', ctx()).price, 5000);
  assert.equal(parseVoiceInput('电脑价格三千五', ctx()).price, 3500);
});

test('价格：无线索词时，阿拉伯数字 + 元/块也认', () => {
  assert.equal(parseVoiceInput('电脑5000元', ctx()).price, 5000);
  assert.equal(parseVoiceInput('买了一台电脑，5000块', ctx()).price, 5000);
  assert.equal(parseVoiceInput('¥1999 耳机', ctx()).price, 1999);
});

test('价格：「18块5」＝18.5（口语里的角）', () => {
  assert.equal(parseVoiceInput('洗衣液18块5', ctx()).price, 18.5);
});

test('★★ 不能把量词当钱 —— 这是这一组里最重要的三条', () => {
  /* 「一块牛肉面」里的「一块」是量词。一旦被当成 1 元，价格会静默写进档案，
     而用户完全不会去看那个字段。同样的形状还有「两块巧克力」「三包抽纸」。 */
  assert.equal(parseVoiceInput('一块牛肉面', ctx()).price, null);
  assert.equal(parseVoiceInput('买了两块巧克力', ctx()).price, null);
  assert.equal(parseVoiceInput('三包抽纸', ctx()).price, null);

  /* 而且这些量词要从名称里剥掉（本来就在做，这里一并钉住） */
  assert.equal(parseVoiceInput('一块牛肉面', ctx()).name, '牛肉面');
  assert.equal(parseVoiceInput('买了两块巧克力', ctx()).name, '巧克力');
});

test('库存：≥2 才算「还有几件」', () => {
  assert.equal(parseVoiceInput('厨房放了两瓶酱油', ctx()).quantity, 2);
  assert.equal(parseVoiceInput('三包抽纸', ctx()).quantity, 3);
  assert.equal(parseVoiceInput('买了5个鸡蛋', ctx()).quantity, 5);
});

test('★ 库存：1 不填 —— 「一包牛肉面」说的是量词，不是「我还有一包」', () => {
  /* 数据层里 null ＝ 单件物品，不启用库存胶囊。
     把 1 写进去会让每一条语音记录都挂上「剩 1」。 */
  assert.equal(parseVoiceInput('厨房放了一包牛肉面', ctx()).quantity, null);
  assert.equal(parseVoiceInput('买了一台电脑', ctx()).quantity, null);
});

test('数量与价格互不干扰：「两瓶酱油，一共28块」', () => {
  const r = parseVoiceInput('厨房放了两瓶酱油，一共28块', ctx());
  assert.equal(r.quantity, 2, '两瓶是数量');
  assert.equal(r.price, 28, '28块是价格');
  assert.equal(r.name, '酱油');
});

test('★ 购买日期：要有线索词才认（否则「昨天」可能是在说到期）', () => {
  const bought = parseVoiceInput('昨天买的洗衣液', ctx());
  assert.equal(bought.purchaseDate, '2026-10-07');
  assert.equal(bought.name, '洗衣液', '「买的」不能留在名称里');

  /* 没有线索词 → 不填。购买日期留空等于「今天」，本来就是对的；
     而猜错一个到期日会一路走进提醒里，用户还不一定发现。 */
  assert.equal(parseVoiceInput('昨天要过期的牛奶', ctx()).purchaseDate, null);
});

test('购买日期：大前天要排在「前天」前面认', () => {
  /* 「大前天」含「前天」—— 顺序错了会得到早三天的日期，而且不报错 */
  assert.equal(parseVoiceInput('大前天买的', ctx()).purchaseDate, '2026-10-05');
  assert.equal(parseVoiceInput('前天买的', ctx()).purchaseDate, '2026-10-06');
  assert.equal(parseVoiceInput('五天前买的', ctx()).purchaseDate, '2026-10-03');
  assert.equal(parseVoiceInput('上个月买的', ctx()).purchaseDate, '2026-09-08');
});

test('六个属性一起来', () => {
  const r = parseVoiceInput('昨天买的，厨房放了两瓶酱油，价格28块，保质期到明年三月', ctx());
  assert.equal(r.name, '酱油');
  assert.equal(r.locationId, 'c-kitchen');
  assert.equal(r.purchaseDate, '2026-10-07');
  assert.equal(r.quantity, 2);
  assert.equal(r.price, 28);
  assert.equal(r.expireDate, '2027-03-31');
});

test('中文数字：带百千万也要算对', () => {
  /* ★ 「一千零五」= 1005 不是 1500，「三千五」= 3500 不是 3005 ——
     口语里这两种省略与补零都极常见，而算错了不会报错。 */
  assert.equal(cnToNumber('一千零五'), 1005);
  assert.equal(cnToNumber('三千五'), 3500);
  assert.equal(cnToNumber('一万二'), 12000);
  assert.equal(cnToNumber('一百二十三'), 123);
  assert.equal(cnToNumber('三十万'), 300000);
  /* 原有的小数字不能因为这次扩展而回归 */
  assert.equal(cnToNumber('十五'), 15);
  assert.equal(cnToNumber('二十三'), 23);
});
