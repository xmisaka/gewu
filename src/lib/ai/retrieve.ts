/**
 * 格物 · 问一问的本地检索层（纯函数）
 *
 * 「冰箱里还有什么能吃的」→ 意图 = 按到期排序的食品，候选 = 三条泡面与底料。
 *
 * ── 为什么这一层必须单独存在、而且必须是纯函数 ──────────────────
 *
 * 方案页把「接了本地库」与「通用聊天机器人」的分界线画在这里：
 * **事实全部来自 SQL 查询结果，模型只负责把话说顺**。
 * 所以「哪些东西该出现在答案里」这个决定不能交给模型 —— 它一旦猜错，
 * 用户看到的是一本正经的胡说，而且没法核实。
 *
 * 又因为这一层的每一条错误都是**静默**的（意图判错就选错候选、
 * 排序反了就给出最不该先吃的那样），它不 import expo / react-native / db，
 * 纯进纯出，交给 tests/retrieve.test.mjs 逐条钉住。
 *
 * 网络、渲染、读库分别在 `client.ts` / `app/ask.tsx` / `lib/db` 里。
 */

import { SOON_THRESHOLD_DAYS } from '../date';
import { formatDailyCost, formatMoney, formatMoneyCompact } from '../format';
import type { DateString, ItemView } from '../types';

/* ------------------------------------------------------------------ 快照 */

/**
 * 喂给检索与模型的物品摘要。
 *
 * 刻意不是 `ItemView`：那一堆派生字段（cover_thumb / photo_count…）
 * 对问答毫无用处，而把它们带上会让提示词白白变长、也更容易让模型
 * 把「照片数量」当成事实写进答案。**这个类型就是模型能看到的世界。**
 */
export interface AiItemSnapshot {
  id: string;
  name: string;
  brand: string | null;
  categoryName: string | null;
  cabinetName: string | null;
  locationName: string | null;
  expireDate: DateString | null;
  daysToExpiry: number | null;
  quantity: number | null;
  tags: string[];
  note: string | null;
  dailyCost: number | null;
  holdingDays: number | null;
  price: number | null;
  createdAt: number;
}

/** ItemView → 快照。用窄类型是为了让「模型能看到什么」这件事只由这一个函数决定 */
export function toSnapshot(view: ItemView): AiItemSnapshot {
  return {
    id: view.id,
    name: view.name,
    brand: view.brand,
    categoryName: view.categoryName,
    cabinetName: view.cabinetName,
    locationName: view.locationName,
    expireDate: view.expireDate,
    daysToExpiry: view.daysToExpiry,
    quantity: view.quantity,
    tags: view.tags,
    note: view.note,
    dailyCost: view.dailyCost,
    holdingDays: view.holdingDays,
    price: view.price,
    createdAt: view.createdAt,
  };
}

/* ------------------------------------------------------------------ 意图 */

export type AiIntent =
  /** 到期类。`food` 为真时只挑吃的，且不设天数上限（「还能吃的」= 全部食品按新鲜度排） */
  | { kind: 'expiring'; withinDays: number; food: boolean }
  /** 位置类：「X 放哪了」。`categoryName` 命中同义词表时优先按分类找 */
  | { kind: 'location'; query: string; categoryName: string | null }
  /** 成本类 */
  | { kind: 'cost'; metric: 'daily' | 'price' }
  /** 补货类：启用了库存且余量见底 */
  | { kind: 'lowStock' }
  /** 规模类。`subject` 非空时是「几件 X」的带主体清点，按分类或名字数，不再笼统报总数 */
  | { kind: 'count'; subject: string | null; categoryName: string | null }
  /** 兜底：当成搜索用 */
  | { kind: 'search'; query: string }
  /** 实在听不懂 */
  | { kind: 'unknown' };

/* ------------------------------------------------------------------ 词表 */

/** 成本类。★ 放在最前面判：它出现的词最具体，不会被别的意图抢走 */
const COST_CUES = [
  '日均成本', '每天多少钱', '一天多少钱', '最贵', '最烧钱', '最花钱', '花了多少',
  '总价值', '值多少钱', '性价比', '单价最高', '回本',
];

/** 规模类 */
const COUNT_CUES = ['多少件', '几件', '一共多少', '总共多少', '有多少件', '多少样', '库存总数'];

/**
 * 规模类问法里要剥掉的词，抽出「数的到底是什么」。
 *
 * ★「我有几件衣服」曾经被规模意图整句吞掉：intent 只剩 count、
 *   「衣服」两个字被丢弃，模型手里只有一条「库里共 96 件」的总账 ——
 *   它没被允许提衣服，只能答「没搜到」。这张表就是为那个缺口补的。
 * ★ 顺序即优先级，长的写前面（与 SUBJECT_STOP 同一个道理）。
 * ★ 刻意**不含**光杆「有」——「有机棉」这类词名里就带着它。
 */
const COUNT_STOP = [
  '一共有多少件', '一共有多少', '一共多少件', '一共多少',
  '总共多少件', '总共多少',
  /* ★「我有 / 家里有」必须排在「有几件」之前 ——
     「我有几件衣服」若先被「有几件」命中，会剥剩一个「我」字挂在物品名前头。 */
  '我有', '家里有', '库里有',
  '有多少件', '有多少',
  '有几件', '有几样', '有几个', '有几',
  '多少件', '多少样', '多少', '几件', '几样', '几个',
  '一共', '总共', '库存总数', '库存',
];

/** 「几件 X」→ X。先剥规模词，再走一遍通用剥词 */
export function extractCountSubject(question: string): string {
  let s = question;
  for (const word of COUNT_STOP) s = s.split(word).join('');
  return extractSubject(s);
}

/** 补货类 */
const LOW_STOCK_CUES = ['该买', '要买', '该补货', '要补货', '快用完', '用完了', '不够用', '见底', '该囤'];

/** 吃的。★ 「能吃」这类要先于「到期」判 —— 它同时含「能」与吃，语义更具体 */
const FOOD_CUES = ['能吃', '可以吃', '能喝的', '吃的', 'food', '零食', '食材', '喝什么'];

/** 到期类 */
const EXPIRY_CUES = [
  '到期', '过期', '保质期', '临期', '失效', '坏了', '变质', '该吃', '赶紧用',
  '赶紧吃', '还有多久', '什么时候过期', '什么时候到期', '能用多久',
];

/** 位置类 */
const LOCATION_CUES = [
  '放哪', '放在哪', '放到哪', '收哪', '存在哪', '在哪', '哪儿', '哪里',
  '什么位置', '哪个柜子', '哪个抽屉', '怎么找', '找到',
  /* ★ 清点类问法：「…里有什么 / 放了什么 / 有哪些」。
     原表里全是「放哪 / 在哪 / 哪个柜子」这类**找单件东西**的说法，没有一种是
     **问一个柜子里都有什么**的。缺了这一族，「客厅电视柜里有什么」会被判成普通搜索，
     整句拿去和物品字段做子串匹配 —— 柜子里明明有 8 件，却答「没找到」。
     判定顺序上它们是安全的：补货 ③、吃的 ④、到期 ⑤ 都在位置 ⑥ 之前，
     所以「有什么该补货了」「家里还有什么能吃的」仍被更具体的意图接走。 */
  '里有什么', '里有哪些', '里放了什么', '里放了哪些', '里都有什么', '里有啥',
  '有什么东西', '有哪些东西', '放了什么东西', '装了什么', '装的什么',
  '有什么', '有哪些', '放了什么', '放了哪些', '都有什么', '有啥', '放了啥',
];

/**
 * 问题里的口语词，抽「问的是什么东西」时要剥掉。
 * 顺序即优先级，长的写前面 —— 与 voice-parse 的 HEAD_PATTERNS 同一个道理。
 */
const SUBJECT_STOP = [
  '请问一下', '请问', '帮我', '麻烦', '我想知道', '我想问', '你知道',
  '都放在哪里了', '都放在哪了', '都放哪了', '都放在哪里', '放在哪里了', '放在哪了',
  '都放在哪里', '放在哪里', '放在哪', '放到哪里', '放到哪', '收在哪里', '收在哪',
  '都在哪里', '都在哪', '在什么地方', '在哪儿', '在哪里', '在哪', '哪去了', '去哪了',
  '在哪个柜子', '哪个柜子', '哪个抽屉', '什么位置', '在哪放着', '放哪儿',
  /* ★ 清点类问法的尾巴，与 LOCATION_CUES 里补的那一族配套 ——
     只补意图、不补剥词，query 会剩一整句「客厅电视柜里有什么」，拿去匹配照样落空。
     ★ 长的必须写在前面：这里是逐个 `split().join('')` 做全量替换，
       先删掉短的会把长的拆散（删了「有什么」，「里面有什么」就再也匹配不上）。 */
  '里面有什么东西', '里面有哪些东西', '里面放了什么东西',
  '里面有什么', '里面有哪些', '里面放了什么', '里面放了哪些', '里面都有什么', '里面装了什么',
  '里有什么东西', '里有哪些东西', '里放了什么东西',
  '里有什么', '里有哪些', '里放了什么', '里放了哪些', '里都有什么', '里装了什么', '里都有啥',
  '有什么东西', '有哪些东西', '放了什么东西',
  '都放了什么', '都放了哪些', '都装了什么', '都有什么',
  '有什么', '有哪些', '放了什么', '放了哪些', '装了什么', '装的什么',
  '里有啥', '放了啥', '有啥',
  /* ★ 下面这几个是补上的，缺了它们最自然的那几种问法会整句被当成物品名：
     「数据线放哪了」剥剩「数据线放哪」→ 拿它去匹配必然落空 → 明明库里有却答「没找到」。
     这类问题的共同点是口语里省掉了「在」，只留一个光秃秃的「放哪 / 搁哪」；
     后半组是「找一下 / 查一下」这类动词 —— 空白态给的那条跟随建议
     「找一下我的充电线」正好踩在它上面，点一下必然回「没找到」。 */
  '放哪儿了', '放哪了', '放哪', '搁哪儿', '搁哪', '怎么找', '找不到',
  '找一下', '找找', '查一下', '搜一下', '看一下', '帮找',
  '我的', '我家', '家里的', '家里', '这些', '那些', '东西', '物品', '的都', '都',
  '了吗', '呢', '的', '了', '?', '？', '。', '！', '!', '，', ',', ' ',
];

/**
 * 问题里的口语词，抽「问的是哪一类」时也要剥 —— 与 SUBJECT_STOP 分开是有原因的：
 * 这里要剥掉的是时间词（「这个月」「今天」），而时间词在位置类问题里
 * 恰恰可能是物品名的一部分（「今天的报纸」）。两套词表各管一段，不互相牵连。
 */
const TIME_STOP = ['这个月', '本月', '这一个月', '这周', '本周', '今天', '今日', '最近', '接下来', '近期'];

/**
 * 口语化的一类东西 → 库里的分类名。
 *
 * 用户不会说「运动户外」，他说「露营装备」。这张表的作用就是
 * 把生活用词翻译成分类名 —— 不命中就退回按名字做子串匹配，两条路都走得通。
 */
const QUERY_TO_CATEGORY: Record<string, string> = {
  露营: '运动户外', 装备: '运动户外', 户外: '运动户外', 运动: '运动户外', 健身: '运动户外',
  药: '药品', 药品: '药品', 医药: '药品', 感冒药: '药品', 急救: '药品', 医疗: '药品',
  吃的: '食品', 喝: '食品', 喝的: '食品', 食品: '食品', 零食: '食品', 食材: '食品', 食物: '食品',
  工具: '工具', 五金: '五金', 螺丝: '五金', 零件: '五金',
  数码: '数码', 电子: '数码', 电子产品: '数码', 电脑: '数码', 充电: '数码',
  厨具: '厨房', 厨房: '厨房', 餐具: '厨房',
  清洁: '清洁', 洗护: '清洁', 日化: '清洁', 打扫: '清洁',
  个护: '个护', 护肤: '个护', 化妆: '个护', 洗漱: '个护',
  衣服: '服饰', 服饰: '服饰', 穿的: '服饰', 鞋: '服饰',
  文具: '文具', 学习: '文具', 办公: '文具',
  书: '图书', 图书: '图书', 读书: '图书',
  宠物: '宠物', 猫: '宠物', 狗: '宠物',
  家具: '家居', 家居: '家居', 日用: '家居',
};

/** 吃的东西的判断：分类名命中，或名字里带这些字 */
const FOOD_CATEGORIES = new Set(['食品', '药品', '宠物']);

/**
 * 明确的非食品分类。
 *
 * ★ 名字线索是很粗的启发式，光靠它会把一堆东西算成吃的：
 *     数据线 1 米 → 「米」   洗衣粉 → 「粉」   面膜 → 「面」
 *     墨水 / 水龙头 → 「水」  机油 → 「油」
 *   而用户自己已经把东西归进这些分类了 —— 那份判断比「名字里撞上一个字」
 *   可信得多。所以带这些分类的一律不算吃的；自定义分类不在表里，仍按名字判。
 *
 *   这条「分类优先」本来就是 isFood 注释里写的口径，之前只是没真的实现：
 *   缺了它，「家里还有什么能吃的」会把数据线和洗衣粉一并列出来，
 *   而这种错法看起来一本正经，用户只会觉得这个功能在胡说。
 */
const NON_FOOD_CATEGORIES = new Set([
  '数码', '工具', '五金', '个护', '清洁', '厨房', '家居', '服饰', '文具', '运动户外', '图书',
]);

/** 名字里带这些字就当吃的 */
const FOOD_NAME_HINTS = [
  '面', '米', '油', '奶', '肉', '菜', '果', '零食', '罐头', '饮料', '水', '茶', '咖啡',
  '酒', '糖', '盐', '酱', '醋', '粉', '糕', '饼', '巧克力', '蜂蜜', '麦片', '粮', '药',
];

/**
 * 数字（含中文数字）+ 可选空格结尾 —— 出现在这后面的「米」是量词，不是大米。
 * 「数据线 1 米」「网线两米」都不该因为一个「米」字被算成吃的。
 */
const MEASURE_TAIL = /[\d〇零一二三四五六七八九十百两]\s*$/;

/** 名字里是否出现某个食品线索字（跳过被量词领着的那些） */
function hintHit(name: string, hint: string): boolean {
  let from = 0;
  for (;;) {
    const at = name.indexOf(hint, from);
    if (at < 0) return false;
    if (!MEASURE_TAIL.test(name.slice(0, at))) return true;
    from = at + 1;
  }
}

/* ------------------------------------------------------------------ 分类判定 */

function hit(text: string, cues: readonly string[]): boolean {
  return cues.some((c) => text.includes(c));
}

/** 「这个月」这类时间范围 → 天数。默认 30 天（与「即将到期」的口径一致） */
export function expiryWindow(question: string): number {
  if (/今天|今日/.test(question)) return 0;
  if (/这周|本周|这个星期|最近几天/.test(question)) return 7;
  return SOON_THRESHOLD_DAYS;
}

/**
 * 剥掉口语词，捞出「问的是什么东西」。
 *
 * ★ 用 `split().join()` 而不是正则替换：这些词里有 `?` `(` 这类
 *   正则元字符，逐个转义不如直接当纯字符串处理。**纯字符串替换不会踩元字符的坑。**
 */
export function extractSubject(question: string): string {
  let s = question;
  for (const word of SUBJECT_STOP) s = s.split(word).join('');
  return s.trim();
}

export function classify(question: string, items: AiItemSnapshot[] = []): AiIntent {
  const q = (question ?? '').trim();
  if (q.length < 2) return { kind: 'unknown' };

  // ① 成本：词最具体，先判，免得「日均成本最高」被「最高」之外的词抢走
  if (hit(q, COST_CUES)) {
    const metric: 'daily' | 'price' = /日均|每天|一天|回本/.test(q) ? 'daily' : 'price';
    return { kind: 'cost', metric };
  }

  // ② 规模。「几件 X」要保住 X ——「我有几件衣服」不该被吞成一句全库总账
  if (hit(q, COUNT_CUES)) {
    const subject = extractCountSubject(q);
    return { kind: 'count', subject: subject || null, categoryName: categoryOf(subject, items) };
  }

  // ③ 补货
  if (hit(q, LOW_STOCK_CUES)) return { kind: 'lowStock' };

  /* ④ 吃的。★ 必须排在到期之前 —— 「还有能吃的吗」含「能吃」，
     若先判到期，「吃」的限定就丢了，答案会混进洗衣液。 */
  if (hit(q, FOOD_CUES)) return { kind: 'expiring', withinDays: Number.POSITIVE_INFINITY, food: true };

  // ⑤ 到期
  if (hit(q, EXPIRY_CUES)) return { kind: 'expiring', withinDays: expiryWindow(q), food: false };

  // ⑥ 位置
  if (hit(q, LOCATION_CUES)) {
    const query = extractSubject(stripTime(q));
    return { kind: 'location', query, categoryName: categoryOf(query, items) };
  }

  // ⑦ 兜底：把问题当搜索词
  return { kind: 'search', query: extractSubject(q) || q };
}

/** 去掉时间词，位置类问题里这些只会污染「问的是什么东西」 */
function stripTime(question: string): string {
  let s = question;
  for (const word of TIME_STOP) s = s.split(word).join('');
  return s;
}

/**
 * 「露营装备」→ `运动户外`。
 *
 * 两条路：先按同义词表整体命中；不中再对**库里的分类名**做子串匹配 ——
 * 后者是为了让用户自定义的分类（「渔具」「手办」）也能被问到。
 * 都命中不了返回 null，调用方会退回按名字搜。
 */
export function categoryOf(query: string, items: AiItemSnapshot[]): string | null {
  const q = query.trim();
  if (!q) return null;

  for (const [word, category] of Object.entries(QUERY_TO_CATEGORY)) {
    if (q.includes(word)) return category;
  }

  const seen = new Set<string>();
  for (const it of items) {
    if (it.categoryName) seen.add(it.categoryName);
  }
  for (const name of seen) {
    if (q.includes(name) || name.includes(q)) return name;
  }
  return null;
}

/**
 * 是不是吃的东西。
 *
 * 两条口径，顺序不能反（见 NON_FOOD_CATEGORIES 的注释）：
 *   ① 分类明确说是食品（或药品、宠物）→ 是；
 *   ② 分类明确说不是（数码、清洁、个护…）→ 不是，**不再看名字**；
 *   ③ 没有分类或分类是用户自定义的 → 才退回按名字里的字判。
 */
export function isFood(item: AiItemSnapshot): boolean {
  if (item.categoryName) {
    if (FOOD_CATEGORIES.has(item.categoryName)) return true;
    if (NON_FOOD_CATEGORIES.has(item.categoryName)) return false;
  }
  return FOOD_NAME_HINTS.some((h) => hintHit(item.name, h));
}

/* ------------------------------------------------------------------ 检索 */

export interface Retrieval {
  question: string;
  intent: AiIntent;
  /** 命中并排好序的候选。界面直接照着渲染物品卡片 */
  items: AiItemSnapshot[];
  /** 库里符合条件的总数（可能多于 items.length，界面写「共 N 条」） */
  total: number;
  /**
   * **确定性的一句话事实。**
   *
   * 模型能拿到它、也只能改写它 —— 它绝不由模型产生。
   * 模型不可用时这句话就是最终答案（本地优先的底线：AI 挂了这个功能还在）。
   */
  fact: string;
}

/** 一次最多往答案里放几条。多了屏幕放不下，也超出「一眼看完」的限度 */
export const MAX_ANSWER_ITEMS = 8;

/** 排序：快到期 / 已过期的在前，没填到期时间的沉底 */
function byUrgency(a: AiItemSnapshot, b: AiItemSnapshot): number {
  const x = a.daysToExpiry;
  const y = b.daysToExpiry;
  if (x == null && y == null) return b.createdAt - a.createdAt;
  if (x == null) return 1;
  if (y == null) return -1;
  return x - y;
}

function byCreatedDesc(a: AiItemSnapshot, b: AiItemSnapshot): number {
  return b.createdAt - a.createdAt;
}

export function retrieve(question: string, items: AiItemSnapshot[], _today: DateString): Retrieval {
  const intent = classify(question, items);
  const top = (list: AiItemSnapshot[]) => list.slice(0, MAX_ANSWER_ITEMS);

  switch (intent.kind) {
    case 'expiring': {
      const pool = intent.food ? items.filter(isFood) : items.filter((it) => it.daysToExpiry != null);
      const matched = pool
        .filter((it) =>
          intent.food
            ? true
            : intent.withinDays === Number.POSITIVE_INFINITY || (it.daysToExpiry ?? 0) <= intent.withinDays,
        )
        .sort(byUrgency);

      if (items.length === 0) {
        return { question, intent, items: [], total: 0, fact: '库里还是空的，先记几件东西再来问吧。' };
      }
      if (matched.length === 0) {
        return {
          question,
          intent,
          items: [],
          total: 0,
          fact: intent.food ? '库里暂时没有能吃的东西。' : '接下来这段时间没有到期的东西。',
        };
      }

      const soonest = matched[0];
      const lead = intent.food
        ? '按保质期先后排了下，这几样先吃最划算'
        : `接下来有一批要到期了，共 ${matched.length} 件`;
      return {
        question,
        intent,
        items: top(matched),
        total: matched.length,
        fact: `${lead}：${describe(soonest)}。`,
      };
    }

    case 'location': {
      /* ★ 问的若是**库里的位置名**，就别再改按分类过滤。
         「厨房吊柜里有什么」里的「厨房」会命中同义词表（厨房 → 分类「厨房」），
         一旦按分类过滤，吊柜里的食品与清洁用品全被漏掉，只剩分类恰好叫「厨房」的那几件 ——
         而用户问的是那个柜子，不是那个分类。
         判据取**精确相等**：textMatch 那条路本来就能靠子串命中位置名
         （「电视柜」命中「客厅电视柜」），这里只需要在分类那条路上设一道闸。 */
      const isPlace = items.some(
        (it) => it.locationName === intent.query || it.cabinetName === intent.query,
      );
      const matched =
        intent.categoryName && !isPlace
          ? items.filter((it) => it.categoryName === intent.categoryName)
          : items.filter((it) => textMatch(it, intent.query));
      const sorted = matched.sort(byCreatedDesc);

      if (sorted.length === 0) {
        return {
          question,
          intent,
          items: [],
          total: 0,
          fact: intent.query ? `没找到和「${intent.query}」对得上的东西。` : '没听清你要找什么，换个说法试试。',
        };
      }

      const places = new Set(
        sorted.map((it) => it.locationName ?? it.cabinetName).filter((x): x is string => !!x),
      );
      const where = sorted.find((it) => it.locationName ?? it.cabinetName);
      return {
        question,
        intent,
        items: top(sorted),
        total: sorted.length,
        fact: where
          ? `共 ${sorted.length} 件，分在 ${places.size} 个地方；先从「${where.name}」看：它在${place(where)}。`
          : `共 ${sorted.length} 件，但都还没记位置。`,
      };
    }

    case 'cost': {
      const key = intent.metric === 'daily' ? 'dailyCost' : 'price';
      const matched = items
        .filter((it) => (it[key] ?? 0) > 0)
        .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));

      if (matched.length === 0) {
        return {
          question,
          intent,
          items: [],
          total: 0,
          fact: '库里还没有填了价格的物品，算不出花费。',
        };
      }

      const first = matched[0];
      const fact =
        intent.metric === 'daily'
          ? `日均成本最高的是「${first.name}」，${formatDailyCost(first.dailyCost)}/天（持有 ${first.holdingDays ?? 0} 天）。`
          : `单价最高的是「${first.name}」，${formatMoney(first.price)}。`;
      return { question, intent, items: top(matched), total: matched.length, fact };
    }

    case 'lowStock': {
      const matched = items
        .filter((it) => it.quantity != null && it.quantity <= 1)
        .sort((a, b) => (a.quantity ?? 0) - (b.quantity ?? 0));

      if (matched.length === 0) {
        return { question, intent, items: [], total: 0, fact: '暂时没有该补货的东西。' };
      }
      const empty = matched.filter((it) => it.quantity === 0).length;
      return {
        question,
        intent,
        items: top(matched),
        total: matched.length,
        fact: `有 ${matched.length} 件该补货了${empty > 0 ? `，其中 ${empty} 件已经用完` : ''}。`,
      };
    }

    case 'count': {
      /* ★「几件 X」是带主体的清点：按分类（「衣服」→服饰）或名字匹配来数，
         并把这几件以卡片列出 —— 只报一句全库总账，正是「明明有 7 件衣服
         却答没搜到」的根源。 */
      let scoped: AiItemSnapshot[] | null = null;
      if (intent.categoryName) {
        scoped = items.filter((it) => it.categoryName === intent.categoryName);
      } else if (intent.subject) {
        const subject = intent.subject;
        const hits = items.filter((it) => textMatch(it, subject));
        if (hits.length > 0) scoped = hits;
      }

      /* ★ 有主体却一件都没对上：如实说没找到，**不能拿全库总账充数** ——
         那是「问 A 答 B」。这里交出的零命中还有一次全量对账兜底的机会（answer.ts）。 */
      if (intent.subject && scoped === null) {
        return {
          question,
          intent,
          items: [],
          total: 0,
          fact: `没找到和「${intent.subject}」对得上的东西。`,
        };
      }

      const matched = scoped ?? items;
      const value = matched.reduce((sum, it) => sum + (it.price ?? 0), 0);
      const expiring = matched.filter((it) => it.daysToExpiry != null && it.daysToExpiry <= SOON_THRESHOLD_DAYS).length;
      const scopeLabel = intent.categoryName ?? intent.subject;
      return {
        question,
        intent,
        items: scoped ? top([...scoped].sort(byCreatedDesc)) : [],
        total: matched.length,
        fact: scopeLabel
          ? `${scopeLabel}共有 ${matched.length} 件，总价值 ${formatMoneyCompact(value)}，其中 ${expiring} 件一个月内到期。`
          : `库里共 ${items.length} 件，总价值 ${formatMoneyCompact(value)}，其中 ${expiring} 件一个月内到期。`,
      };
    }

    case 'search': {
      const matched = items.filter((it) => textMatch(it, intent.query)).sort(byCreatedDesc);
      if (matched.length === 0) {
        return {
          question,
          intent,
          items: [],
          total: 0,
          fact: `没找到和「${intent.query}」相关的记录。换个词，或者先记下来。`,
        };
      }
      return {
        question,
        intent,
        items: top(matched),
        total: matched.length,
        fact: `找到 ${matched.length} 条和「${intent.query}」相关的记录。`,
      };
    }

    case 'unknown':
    default:
      return {
        question,
        intent: { kind: 'unknown' },
        items: [],
        total: 0,
        fact: '这句没太听懂。可以试试：「家里还有什么能吃的」「这个月哪些要到期」「露营装备放哪了」「一共多少件东西」。',
      };
  }
}

/* ------------------------------------------------------------------ 文本匹配 */

/** 一条记录上所有可被搜到的文字 */
function haystack(item: AiItemSnapshot): string {
  return [
    item.name,
    item.brand ?? '',
    item.categoryName ?? '',
    item.cabinetName ?? '',
    item.locationName ?? '',
    item.note ?? '',
    item.tags.join(' '),
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * 按词组匹配。
 *
 * 除了整词命中，还认「词的每个字都出现过」这种松散情况 ——
 * 用户会说「露营的帐篷」，而库里那条只叫「帐篷」：整词对不上，
 * 但「露营」被同义词表接走了，这里主要兜住「数据线」对「类型-c 数据线」这类。
 * 松散匹配**只对长度 ≥ 2 的词生效**，单字匹配会把库翻得乱七八糟。
 */
export function textMatch(item: AiItemSnapshot, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const hay = haystack(item);
  if (hay.includes(q)) return true;
  return q.length >= 2 && [...q].every((ch) => hay.includes(ch));
}

/* ------------------------------------------------------------------ 排版小工具 */

function describe(item: AiItemSnapshot): string {
  const days = item.daysToExpiry;
  const when =
    days == null ? '没记到期时间' : days < 0 ? `已经过期 ${Math.abs(days)} 天` : `还剩 ${days} 天`;
  const at = place(item);
  return `「${item.name}」${when}，在${at}`;
}

/** 位置显示成「厨房 · 橱柜2」，只到柜子层级就只写柜子 */
export function place(item: AiItemSnapshot): string {
  if (item.cabinetName && item.locationName) return `${item.cabinetName} · ${item.locationName}`;
  return item.locationName ?? item.cabinetName ?? '还没记位置';
}
