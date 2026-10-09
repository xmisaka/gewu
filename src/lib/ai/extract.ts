/**
 * 格物 · 从模型输出里抽物品字段（纯函数）
 *
 * 识物预填与「语音 AI 补全」共用这一个模块 —— 两条路问的是同一个问题
 * （「这段话/这张图里有哪些能填进表单的信息」），提示词与解析自然只该有一份实现。
 * 分开写两份的结果是可以预见的：改了一处措辞、另一处悄悄跟不上。
 *
 * ── 与 voice-parse 的分工 ──────────────────────────────────────
 * `voice-parse.ts` 是**规则**解析：本地、免费、瞬时，覆盖绝大多数说法，
 * 覆盖不了的它诚实地留空。这里是**模型**解析：慢、要联网、要花 token，
 * 但能理解「这包是上次去成都带回来的酸辣粉，柜子里还有三包」这种没有句式的表达。
 * 规则先行、模型兜底 —— 所以这里的定位是「补全 voice-parse 没填上的字段」，
 * 而不是替换它。
 *
 * 不 import expo / react-native / db，纯进纯出，交给 tests/ai-parse.test.mjs 钉住。
 */

import { addMonths } from '../date';
import type { DateString } from '../types';
import { cnToNumber } from './voice-parse';

/* ------------------------------------------------------------------ 结果形状 */

/** 模型能填的字段。**刻意比表单窄**：照片、位置、购买日期、排序值都不在射程里 */
export interface ExtractedFields {
  name: string | null;
  brand: string | null;
  model: string | null;
  /** 模型给的中文分类名，由调用方映射到库里的分类实体 */
  categoryName: string | null;
  quantity: number | null;
  /** 购买日期。用户说「昨天买的」这类相对说法时才由模型给出 */
  purchaseDate: DateString | null;
  /** 单价（元）。**只在明确说了价格时填**，拿不准一律 null */
  price: number | null;
  /** 包装上直接印着的到期日 */
  expireDate: DateString | null;
  /** 只写了「保质期 6 个月」时，按这个月数从今天推 */
  shelfLifeMonths: number | null;
  tags: string[];
  note: string | null;
}

export type ExtractedKey = keyof ExtractedFields;

export interface ExtractResult {
  fields: ExtractedFields;
  /** 模型**真的给出了值**的字段。界面只给这些挂 AI 标记 */
  filled: ExtractedKey[];
  /** 模型自报的把握程度 0~1；拿不到就是 null（界面不显示这句提示） */
  confidence: number | null;
}

/**
 * 全空的字段集。导出是因为调用方有一个真实场景要用它：
 * 照片已经落盘、只是没读出字段时，仍然要把照片交回表单 ——
 * 那时需要一个「合法但空」的 fields 陪它一起返回。
 */
export const EMPTY_FIELDS: ExtractedFields = {
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
};

/* ------------------------------------------------------------------ 提示词 */

/**
 * 输出格式的约定。**同一段文字被两个提示词共用** ——
 * 识图与语音的差别只在「看什么」，输出形状必须完全一致，否则解析层要分叉。
 */
const OUTPUT_SCHEMA = `只输出一个 JSON 对象，不要输出任何解释、不要用 markdown 代码块。字段如下：
{
  "name": 物品名称（字符串，尽量完整，含品牌与口味；看不清就 null）,
  "brand": 品牌（字符串或 null）,
  "model": 型号规格（字符串或 null）,
  "category": 从下面这份清单里挑一个最贴近的分类名（挑不出就 null）,
  "quantity": 数量（整数或 null）,
  "purchaseDate": 购买日期，格式 YYYY-MM-DD（只在明确说了"昨天买的""上个月买的"这类时间时填，否则 null）,
  "price": 单价（数字或 null）。只在明确说了价格时填；说"一共""总共"且数量大于 1 时填 null —— 那是总价不是单价，不要自己除,
  "expireDate": 到期日，格式 YYYY-MM-DD（只在明确读到日期时填，否则 null）,
  "shelfLifeMonths": 保质期月数（只在明确写了"保质期 N 个月"这类字样时填数字，否则 null）,
  "tags": 字符串数组（没有就给 []）,
  "note": 补充说明（字符串或 null）,
  "confidence": 你对这次识别的把握，0 到 1 之间的小数
}`;

/**
 * 反幻觉指令。
 *
 * ★ 这三句是整段提示词里最值钱的部分。模型对「包装上大概率写了保质期」
 *   这件事有很强的先验，不明确禁止它就会**替你把保质期猜出来** ——
 *   而一条猜出来的到期日会一路走进提醒里，用户还不一定发现。
 *   宁可少填一个字段：留空用户一秒就能补，猜错他得先发现再怀疑别的字段。
 */
const HONESTY_RULES = `重要规则：
1. 看不出来、不确定的字段一律填 null，绝对不要猜测或编造。
2. 不要根据常识推测保质期。只有图上有明确的日期或"保质期"字样时才填。
3. 不要编造品牌与型号。包装上没写就填 null。
4. 名称只写你在图里/话里真实看到或听到的东西。`;

/** 识图提示词 */
export function buildVisionPrompt(categories: readonly string[]): string {
  const list = categories.length > 0 ? categories.join('、') : '（没有可选分类）';
  return [
    '你是一个收纳整理助手。用户拍了一张物品（多半是包装盒、包装袋或实物）的照片。',
    '请从照片里读出能填进物品档案的字段，然后按约定输出 JSON。',
    `可选分类：${list}`,
    '',
    OUTPUT_SCHEMA,
    '',
    HONESTY_RULES,
  ].join('\n');
}

/**
 * 语音补全提示词。
 *
 * 传入的是一句**口头描述**，不是图片。所以额外交代一句「用户是在说自己家里的东西」——
 * 否则模型容易把它当成商品检索词去补全，进而编出一堆没说过的东西。
 */
export function buildVoicePrompt(categories: readonly string[]): string {
  const list = categories.length > 0 ? categories.join('、') : '（没有可选分类）';
  return [
    '你是一个收纳整理助手。用户说了一句话，描述他刚记下来的一件物品。',
    '请从这句话里读出能填进物品档案的字段，然后按约定输出 JSON。',
    `可选分类：${list}`,
    '',
    OUTPUT_SCHEMA,
    '',
    HONESTY_RULES,
    '',
    '注意：用户说的是他家里已有的东西，不要补充他没提到的品牌、型号或数量。',
  ].join('\n');
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 从模型回复里抠出 JSON。
 *
 * 三层兜底，因为各家模型的「听话程度」不一样：
 *   ① 直接 JSON.parse —— 最理想
 *   ② 剥掉 ```json 围栏 —— 最常见的不听话形式
 *   ③ 取第一个 `{` 到最后一个 `}` —— 前面带一句「好的，这是结果：」时也能救回来
 *
 * 三层都失败返回 null。**不抛错**：解析不了等价于「这次没帮上忙」，
 * 而它上游的定位本来就只是「兜底」，失败不该打断任何主流程。
 */
export function extractJson(text: string): unknown {
  const raw = (text ?? '').trim();
  if (!raw) return null;

  const attempts: string[] = [raw];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced?.[1]) attempts.push(fenced[1].trim());

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(raw.slice(start, end + 1));

  for (const candidate of attempts) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 试下一种
    }
  }
  return null;
}

function toText(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** 数量：只收正整数字符串或数字；`'6个月'` 这类先取数字部分 */
/**
 * 金额。
 *
 * 与 `format.ts` 的 `parseMoneyInput` 同口径（元、两位小数），
 * 但这里面对的是模型返回的 JSON，所以额外容忍字符串形式与「¥28」这类写法 ——
 * 让模型「只输出数字」是一句愿望，不是保证。
 *
 * ★ 上限只是防呆：模型偶尔会把「5000」写成「500000」这种量级的笔误，
 *   记进档案后会一路影响日均成本。宁可留空让用户补。
 */
function toMoney(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    const m = /(\d+(?:\.\d+)?)/.exec(v.replace(/[,¥￥\s]/g, ''));
    if (m) n = Number(m[1]);
  }
  if (n == null || !Number.isFinite(n) || n <= 0 || n > 10_000_000) return null;
  return Math.round(n * 100) / 100;
}

function toCount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  if (typeof v === 'string') {
    const m = /(\d+(?:\.\d+)?)/.exec(v);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }
  }
  return null;
}

/**
 * 保质期月数：数字 / `"6个月"` / `"半年"` / `"一年半"` 都认。
 * 复用 voice-parse 的 `cnToNumber`，与语音那条路保持同一套中文数字规则 ——
 * 否则「一年半」在语音里是 18 个月、在补全里是 null，用户会当成 bug。
 */
function toMonths(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;

  const arabic = /(\d+(?:\.\d+)?)/.exec(t);
  if (arabic) {
    const n = Number(arabic[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (t.includes('年半')) {
    const head = /([〇零一二三四五六七八九十两]+)年半/.exec(t);
    const n = head ? cnToNumber(head[1]) : null;
    return (n == null ? 1 : n) * 12 + 6;
  }
  if (t.includes('半年')) return 6;
  const cn = /([〇零一二三四五六七八九十两]+)\s*(?:个月|月|年)/.exec(t);
  if (cn) {
    const n = cnToNumber(cn[1]);
    if (n != null && n > 0) return t.includes('年') ? n * 12 : n;
  }
  return null;
}

/** 到期日：只认 `YYYY-MM-DD` 与 `YYYY/M/D`、`YYYY年M月D日` */
function toDate(v: unknown): DateString | null {
  const t = toText(v);
  if (!t) return null;
  const m = /(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/.exec(t);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${year}-${pad(month)}-${pad(day)}`;
}

function toTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => toText(x))
    .filter((x): x is string => x != null && x.length <= 12)
    .slice(0, 6);
}

/**
 * 解析模型输出 → 表单字段。
 *
 * `categories` 是**库里真实存在的分类名**：模型给出的分类名要在这里面找得到才算数，
 * 找不到就当它没填 —— 让一个不存在的分类名漏进界面，用户会看到一行
 * 点了却选不中的「食品」，而录入表单只会显示「未分类」。
 *
 * 返回 null 表示「这份回复没法用」，调用方应当静默退回本地规则的结果。
 */
export function parseExtract(raw: unknown, ctx: { today: DateString; categories: readonly string[] }): ExtractResult | null {
  const obj = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const src = obj as Record<string, unknown>;

  const name = toText(src.name);
  const brand = toText(src.brand);
  const model = toText(src.model);
  const rawCategory = toText(src.category);
  const categoryName = rawCategory && ctx.categories.includes(rawCategory) ? rawCategory : null;
  const quantity = toCount(src.quantity);
  const purchaseDate = toDate(src.purchaseDate);
  const price = toMoney(src.price);
  const directDate = toDate(src.expireDate);
  const shelfLifeMonths = toMonths(src.shelfLifeMonths);
  const tags = toTags(src.tags);
  const note = toText(src.note);

  /* 到期日两条来源，优先用包装上直接印的那个（更准），
     没有才拿「保质期 N 个月」从今天推 —— 后者是估算，但比留空有用，
     而且界面上它会带 AI 标记，用户看得见这是猜的。 */
  const expireDate = directDate ?? (shelfLifeMonths != null ? addMonths(ctx.today, Math.round(shelfLifeMonths)) : null);

  const fields: ExtractedFields = {
    ...EMPTY_FIELDS,
    name,
    brand,
    model,
    categoryName,
    quantity,
    purchaseDate,
    price,
    expireDate,
    shelfLifeMonths,
    tags,
    note,
  };

  /* `shelfLifeMonths` 不进 filled：它只是推算到期日的中转量，表单里没有这一行。
     把它报上去，界面要么找不到对应的行、要么得为它写一处特判。 */
  const filled = (Object.keys(EMPTY_FIELDS) as ExtractedKey[]).filter((key) => {
    if (key === 'shelfLifeMonths') return false;
    const v = fields[key];
    if (Array.isArray(v)) return v.length > 0;
    return v != null;
  });

  /* 一个字段都没读出来 → 当作没帮上忙。返回一个「空但合法」的结果会让界面
     显示「AI 已填 0 项」，那比直接说「没读出来」更让人摸不着头脑。 */
  if (filled.length === 0) return null;

  const confidenceRaw = src.confidence;
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : typeof confidenceRaw === 'string' && /^\d*\.?\d+$/.test(confidenceRaw.trim())
        ? Math.min(1, Math.max(0, Number(confidenceRaw)))
        : null;

  return { fields, filled, confidence };
}

/**
 * 模型自报把握不大时给用户的一句话。
 * 只在真拿到 confidence 且偏低时说 —— 编不出把握的时候不该假装有。
 */
export const LOW_CONFIDENCE_HINT = '这次识别把握不大，保存前请对照实物看一眼。';
