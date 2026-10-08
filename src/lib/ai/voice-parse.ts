/**
 * 格物 · 语音文本的结构化解析
 *
 * 「厨房橱柜二放了一包牛肉面，保质期到年底」
 *   → 名称 牛肉面 · 位置 厨房/橱柜2 · 到期 当年 12-31
 *
 * ── 两条设计原则 ───────────────────────────────────────────────
 *
 * 1. **纯函数**：不 import expo、react-native、db，`today` 与位置表都从参数进来。
 *    语音识别本身没法在测试里跑，但「一段文本 → 三个字段」可以，
 *    而这一段恰恰是最容易悄悄错掉的地方（错了不报错，只是记错东西）。
 *
 * 2. **保守优先**：没把握的字段一律留空，交给用户在确认页补。
 *    空白是「我没听懂」，用户一秒就能填；猜错是「它听成别的了」，
 *    用户得先发现、再改、还得回头怀疑另外两个字段对不对。宁可少解析。
 *
 * 识别本来就有误差，所以 05 屏的约定是「结构化预览 + 待确认」，
 * 解析质量不构成落库风险 —— 但也正因如此，更不该为了「看起来聪明」而乱猜。
 */

import { addMonths, parseDate, toDateString } from '../date';
import type { DateString } from '../types';

/* ------------------------------------------------------------ 类型 */

/** 位置匹配用的瘦身版，只留解析需要的东西 */
export interface VoiceLocationHint {
  id: string;
  name: string;
  /** 格位所属柜子的名字；柜子本身传 null */
  parentName: string | null;
}

export interface VoiceParseContext {
  locations: VoiceLocationHint[];
  /**
   * 今天，`YYYY-MM-DD`。**从参数进来而不是内部取** ——
   * 否则所有跟「年底」「下个月」有关的用例都会随时间漂移，
   * 测出来的绿是假的。
   */
  today: DateString;
}

export interface VoiceParseResult {
  /** 剥掉位置与保质期片段、再去掉口头语之后的物品名 */
  name: string;
  locationId: string | null;
  /** 命中的位置原文，用于界面回显「听成了哪个位置」 */
  locationText: string | null;
  expireDate: DateString | null;
  /** 命中的到期原文 */
  expireText: string | null;
}

const EMPTY: VoiceParseResult = {
  name: '',
  locationId: null,
  locationText: null,
  expireDate: null,
  expireText: null,
};

export function emptyParseResult(): VoiceParseResult {
  return { ...EMPTY };
}

/* ------------------------------------------------------------ 中文数字 */

const CN_DIGIT: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

const CN_UNIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 把一小段数字（阿拉伯或中文）转成数值；认不出来返回 null */
export function cnToNumber(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  if (t === '十') return 10;
  if (t === '半') return 0.5;

  let m = /^十([一二三四五六七八九])$/.exec(t);
  if (m) return 10 + CN_DIGIT[m[1]];
  m = /^([一二三四五六七八九])十([一二三四五六七八九])$/.exec(t);
  if (m) return CN_DIGIT[m[1]] * 10 + CN_DIGIT[m[2]];
  m = /^([一二三四五六七八九])十$/.exec(t);
  if (m) return CN_DIGIT[m[1]] * 10;
  if (t.length === 1 && CN_DIGIT[t] != null) return CN_DIGIT[t];
  return null;
}

/** 数值 → 中文写法。只处理 0~99，位置名里的序号不会更大。 */
function numberToCn(n: number): string {
  if (n < 10) return CN_UNIT[n];
  if (n === 10) return '十';
  if (n < 20) return `十${CN_UNIT[n - 10]}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones === 0 ? `${CN_UNIT[tens]}十` : `${CN_UNIT[tens]}十${CN_UNIT[ones]}`;
}

/**
 * 一个数字 token 的所有可能写法。
 *
 * 位置名在库里可能存成「橱柜2」，而人说的是「橱柜二」（或反过来），
 * 所以两个方向都要生成。**只生成候选、不改写原文** ——
 * 改写整句会把「一块牛肉面」碰成「1块牛肉面」，名称就毁了。
 */
function numeralVariants(token: string): string[] {
  const out = new Set<string>([token]);
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    if (n >= 0 && n <= 99) {
      out.add(numberToCn(n));
      if (n === 2) out.add('两');
    }
  } else {
    const n = cnToNumber(token);
    if (n != null && Number.isInteger(n) && n > 0 && n <= 99) out.add(String(n));
  }
  return [...out];
}

/** 位置名的所有表面形式（含数字写法变体）。候选超过 12 种就放弃变体，只留原样。 */
function surfaceVariants(surface: string): string[] {
  const tokens = surface.match(/\d+|[〇零一二三四五六七八九十两]+/g);
  if (!tokens || tokens.length === 0) return [surface];

  /* 逐段拼接的候选串。flatMap 出来的是**扁平**列表 ——
     写成 string[][] 会编译不过，而写成 any 会在运行时得到一堆
     被拼成一串的数组，还照样跑得下去。 */
  let parts: string[] = [''];
  let cursor = 0;
  for (const token of tokens) {
    const at = surface.indexOf(token, cursor);
    const prefix = surface.slice(cursor, at);
    parts = parts.flatMap((p) => numeralVariants(token).map((a) => p + prefix + a));
    if (parts.length > 12) return [surface];
    cursor = at + token.length;
  }
  const tail = surface.slice(cursor);
  return [...new Set(parts.map((p) => p + tail))];
}

/* ------------------------------------------------------------ 到期 */

interface Span {
  start: number;
  end: number;
}

interface ExpiryHit extends Span {
  date: DateString;
  text: string;
}

/**
 * 保质期类线索词。
 *
 * 只有句子里出现它们，才认「年底」「三个月」「9 月」这类**含糊**表述 ——
 * 否则「我买了三月的机票」「年底搬家的箱子」都会被当成到期时间，
 * 而 05 屏根本没有「购买日期」这一行，错了也无处可改。
 *
 * 只有四位年份（2026-12-31）能绕过这道闸门，它本身就够明确。
 */
const EXPIRY_CUES = [
  '保质期', '保存期', '有效期', '到期', '过期', '失效', '截止',
  '能用到', '可以用到', '还能用', '用不完',
];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function makeDate(year: number, month: number, day: number): DateString | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  const last = daysInMonth(year, month);
  return `${year}-${pad(month)}-${pad(Math.min(Math.max(day, 1), last))}`;
}

function lastDay(year: number, month: number): DateString | null {
  return makeDate(year, month, 31);
}

/**
 * 找出句子里的到期时间。
 *
 * **按「越明确越优先」的顺序试，命中即返回** —— 不做「多命中取最晚」：
 * 一句话里出现两个日期时，先说的那条更可能是本意
 * （「保质期到年底，我是 3 月买的」）。
 */
function findExpiry(text: string, today: DateString): ExpiryHit | null {
  const base = parseDate(today);
  if (!base) return null;
  const y = base.getFullYear();
  const hasCue = EXPIRY_CUES.some((c) => text.includes(c));

  const hit = (m: RegExpExecArray, date: DateString | null): ExpiryHit | null =>
    date ? { date, start: m.index, end: m.index + m[0].length, text: m[0] } : null;

  // ① 完整年月日：2026-12-31 / 2026年12月31日 / 2026.12.31
  let m = /(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})\s*[日号]?/.exec(text);
  if (m) {
    const r = hit(m, makeDate(Number(m[1]), Number(m[2]), Number(m[3])));
    if (r) return r;
  }

  // ② 年月：2026年12月（日取该月最后一天）
  m = /(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*月/.exec(text);
  if (m) {
    const r = hit(m, lastDay(Number(m[1]), Number(m[2])));
    if (r) return r;
  }

  /*
   * 以下都需要线索词。四位年份本身就够明确，所以 ①② 排在闸门之前；
   * 「年底」「明年三月」「9 月」则不然 —— 脱离了「保质期」这层语境，
   * 「年底搬家的箱子」和「保质期到年底」在字面上没有任何区别，
   * 而猜错一条到期时间会一路错到提醒里去，用户还不一定发现。
   * 漏掉的代价只是点一下「到期」那一行自己选，比错小得多。
   */
  if (!hasCue) return null;

  /* ③ 年底：明年底 / 明年年底 / 今年年底 / 年底
   *
   * ★ 「明年底」是「明 + 年底」，不是「明年 + 年底」—— 少写一个「明」
   *   就会掉进下面那条「今年的年底」分支，默默给出一个早了一年的日期。
   *   这里靠正则回溯枚举，而不是靠拼接字符串去凑。 */
  m = /(?:明年|次年|明|次)(?:的)?(?:年底|年尾|年末|年终)/.exec(text);
  if (m) {
    const r = hit(m, makeDate(y + 1, 12, 31));
    if (r) return r;
  }
  m = /(?:今年)?(?:的)?(?:年底|年尾|年末|年终)/.exec(text);
  if (m) {
    const r = hit(m, makeDate(y, 12, 31));
    if (r) return r;
  }

  // ④ 明年 X 月
  m = /明年的?\s*([0-9一二三四五六七八九十]{1,3})\s*月/.exec(text);
  if (m) {
    const mo = cnToNumber(m[1]);
    const r = hit(m, mo == null ? null : lastDay(y + 1, mo));
    if (r) return r;
  }

  // ⑤ 月日：保质期到 12 月 31 日（年份取今年，已过去则顺延明年）
  m = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    let date = makeDate(y, mo, d);
    if (date && date < today) date = makeDate(y + 1, mo, d);
    const r = hit(m, date);
    if (r) return r;
  }

  // ⑥ 月底：下个月底 / 这个月底
  m = /下(?:个)?月(?:的)?(?:底|末)/.exec(text);
  if (m) {
    const next = parseDate(addMonths(`${y}-${pad(base.getMonth() + 1)}-01`, 1));
    const r = hit(m, next ? lastDay(next.getFullYear(), next.getMonth() + 1) : null);
    if (r) return r;
  }
  m = /(?:这个|本|当)?月(?:的)?(?:底|末)/.exec(text);
  if (m) {
    const r = hit(m, lastDay(y, base.getMonth() + 1));
    if (r) return r;
  }

  // ⑦ 只说月份：保质期到 9 月（已过去的月份顺延明年）
  m = /([0-9一二三四五六七八九十]{1,3})\s*月/.exec(text);
  if (m) {
    const mo = cnToNumber(m[1]);
    if (mo != null && mo >= 1 && mo <= 12) {
      let date = lastDay(y, mo);
      if (date && date < today) date = lastDay(y + 1, mo);
      const r = hit(m, date);
      if (r) return r;
    }
  }

  // ⑧ 相对时长
  m = /([0-9一二三四五六七八九十两]{1,3})\s*年半/.exec(text);
  if (m) {
    const n = cnToNumber(m[1]);
    const r = hit(m, n == null ? null : addMonths(today, Math.round(n * 12) + 6));
    if (r) return r;
  }
  m = /半年/.exec(text);
  if (m) {
    const r = hit(m, addMonths(today, 6));
    if (r) return r;
  }
  m = /([0-9一二三四五六七八九十两]{1,3})\s*个?\s*月/.exec(text);
  if (m) {
    const n = cnToNumber(m[1]);
    const r = hit(m, n == null ? null : addMonths(today, Math.round(n)));
    if (r) return r;
  }
  m = /([0-9一二三四五六七八九十两]{1,3})\s*[天日]/.exec(text);
  if (m) {
    const n = cnToNumber(m[1]);
    const r = hit(
      m,
      n == null ? null : toDateString(new Date(base.getFullYear(), base.getMonth(), base.getDate() + Math.round(n))),
    );
    if (r) return r;
  }
  m = /([0-9一二三四五六七八九十两]{1,3})\s*年/.exec(text);
  if (m) {
    const n = cnToNumber(m[1]);
    const r = hit(m, n == null ? null : addMonths(today, Math.round(n * 12)));
    if (r) return r;
  }

  return null;
}

/* ------------------------------------------------------------ 位置 */

/** 命中片段左边紧挨着的保质期类词，一并吃掉，免得残缺留在名称里 */
const EXPIRY_LEAD = [
  '保质期到', '保质期是', '保质期为', '保质期',
  '保存期到', '保存期', '有效期到', '有效期是', '有效期',
  '到期日', '过期日', '截止到', '截止', '到期', '过期', '失效',
  '还有', '还剩', '剩下', '剩', '到', '至', '在', '是', '为',
];

/*
 * 位置片段左右要连带的方位词与介词。
 *
 * 剪掉「书桌抽屉」之后如果不管，剩下的「里放了一包牛肉面」会把「里」
 * 粘到名称上；「放大镜放在书桌抽屉里」则会剩下「放大镜放在」。
 * 这些词紧贴着位置名，归属是确定的，所以**结构性扩张**比事后用
 * 头部剥离去猜安全得多 —— 后者不敢认单字「里」，因为「里程表」会被吃坏。
 */
const LOC_SUFFIX = [
  '里面', '里边', '里头', '里', '中', '内',
  '上面', '上边', '上', '下面', '下边', '下', '底下', '旁边',
];

const LOC_PREFIX = [
  '放在', '放到', '放进', '搁在', '搁到', '搁进', '摆在', '摆到',
  '挂在', '挂到', '收在', '收到', '收进', '存放在', '存到',
  '装进', '装入', '在', '从', '于',
];

/** 从 start 往前吃线索词，返回新的 start。最多吃 6 轮，防止正则意外时打转。 */
function eatLeft(text: string, start: number, words: string[]): number {
  let at = start;
  let moved = true;
  let guard = 0;
  while (moved && guard++ < 6) {
    moved = false;
    for (const w of words) {
      if (at - w.length >= 0 && text.slice(at - w.length, at) === w) {
        at -= w.length;
        moved = true;
        break;
      }
    }
  }
  return at;
}

/** 从 end 往后吃方位词，返回新的 end */
function eatRight(text: string, end: number, words: string[]): number {
  let at = end;
  let moved = true;
  let guard = 0;
  while (moved && guard++ < 6) {
    moved = false;
    for (const w of words) {
      if (text.startsWith(w, at)) {
        at += w.length;
        moved = true;
        break;
      }
    }
  }
  return at;
}

interface LocationHit extends Span {
  id: string;
  text: string;
}

function findLocation(text: string, locations: VoiceLocationHint[]): LocationHit | null {
  const candidates: { surface: string; id: string }[] = [];
  for (const loc of locations) {
    if (!loc.name) continue;
    for (const v of surfaceVariants(loc.name)) candidates.push({ surface: v, id: loc.id });
    // 「厨房橱柜2」这种父子连起来说的形式 —— 人几乎总是这么说话
    if (loc.parentName) {
      for (const v of surfaceVariants(`${loc.parentName}${loc.name}`)) {
        candidates.push({ surface: v, id: loc.id });
      }
    }
  }

  // 长表面优先：有「厨房橱柜2」就不该被「厨房」抢走
  candidates.sort((a, b) => b.surface.length - a.surface.length);

  for (const c of candidates) {
    const at = text.indexOf(c.surface);
    if (at >= 0) return { id: c.id, text: c.surface, start: at, end: at + c.surface.length };
  }
  return null;
}

/* ------------------------------------------------------------ 名称残余 */

/** 口头语与连接词，从头剥。**顺序即优先级，长的写前面。** */
const HEAD_PATTERNS: RegExp[] = [
  /^(?:我把|我买了|我刚买了|我新买了|这是我|这个是|我入手了|我买|我刚|我新买)/,
  /^(?:记录一下|帮我记一下|帮我记|记一下|记录|添加|新增|补充)/,
  /^(?:新买的|刚买的|刚入手的|新买|刚买|入手了|入了|购入|买了|买|添置)/,
  /^(?:放在|放进|放到|搁在|搁到|搁进|摆在|摆到|挂在|挂到|收在|收到|收进|存放在|存到|装进|装入)/,
  /^(?:放了|搁了|摆了|挂了|收了|存了|装了)/,
  /^(?:一共|总共|有些个)/,
  /* 方位词只剥多字形式，单字的交给位置片段的结构性扩张（见 LOC_SUFFIX） */
  /^(?:里面|里边|里头|上面|上边|下面|下边|底下|旁边)/,
  /*
   * 「有一包牛肉面」里的「有」。
   * 用前瞻要求后面紧跟数字，否则「有机食品」会被剥成「机食品」——
   * 这与不剥单字「放」是同一个理由。
   */
  /^有(?=[一二三四五六七八九十两半])/,
  /^(?:有个|有些|有几)/,
  /*
   * 数量 + 量词：一包牛肉面 → 牛肉面。
   * 量词是一张白名单，绝不用 `.` 偷懒 —— 否则「一次性手套」会被吃掉一个「次」。
   */
  /^[一二三四五六七八九十两半]\s*(?:个|只|支|枝|张|条|件|台|部|本|瓶|盒|包|袋|箱|罐|桶|块|把|副|双|对|套|顶|辆|架|根|片|枚|颗|粒|卷|束|柄|面|扇|盏|沓|摞|捆)/,
];

/** 口头语与方位词，从尾剥 */
const TAIL_PATTERNS: RegExp[] = [
  /(?:了|吧|啊|哦|嗯|呀|呢|谢谢|多谢|好的|好了|行了|一下|的话)$/,
  /(?:里边|里面|里头|里|中|内|上面|上边|上|下面|下边|下|底下|旁边)$/,
  /(?:放到|放在|搁到|搁在|摆在|挂在|收到|收在|存到|存进|放进|装进|装在)$/,
  /(?:保质期|保存期|有效期|到期|过期|失效|截止)$/,
  /(?:还有|还剩|剩下|剩|能用到|可以用到|能用|到|至|是|为|在)$/,
];

const NOISE = /[，。、；：！？,.;:!?~～"'“”‘’()（）【】\[\]]+/g;

/**
 * 剥口头语。
 *
 * 反复剥到不动为止，是因为「我把新买的黑色耳机…」这类句子要剥三层；
 * 但要设轮数上限 —— 正则与输入都是数据，任何一边出人意料时，
 * 死循环在这里比在用户手机上卡住更难查。
 *
 * ★ 单字动词（放 / 收 / 存 / 装 / 摆 / 挂）**一律不做头部剥离**：
 *   「放大镜」会被吃成「大镜」，「收纳盒」会变成「盒」。
 *   只认「放了 / 放在 / 收到…」这种带第二个字的形式。
 */
function peel(input: string): string {
  let s = input.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  let prev = '';
  let guard = 0;
  while (s && s !== prev && guard++ < 12) {
    prev = s;
    for (const re of HEAD_PATTERNS) s = s.replace(re, '').trim();
    for (const re of TAIL_PATTERNS) s = s.replace(re, '').trim();
    // 头部剥完可能又露出标点或多余空格，再清一遍
    s = s.replace(/^[\s，。、；：！？,.;:!?]+/, '').replace(/\s+/g, ' ').trim();
  }
  return s;
}

/* ------------------------------------------------------------ 主函数 */

/** 把命中的片段从原文里挖掉，剩下的留给名称。重叠的片段先合并。 */
function cutSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  let out = '';
  let cursor = 0;
  for (const s of merged) {
    out += `${text.slice(cursor, s.start)} `;
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

export function parseVoiceInput(raw: string, ctx: VoiceParseContext): VoiceParseResult {
  const text = (raw ?? '').trim();
  if (!text) return emptyParseResult();

  const expiry = findExpiry(text, ctx.today);
  const location = findLocation(text, ctx.locations);

  const spans: Span[] = [];
  if (location) {
    // 位置名前后的方位词与介词一起吃掉，免得残缺粘进名称
    spans.push({
      start: eatLeft(text, location.start, LOC_PREFIX),
      end: eatRight(text, location.end, LOC_SUFFIX),
    });
  }
  if (expiry) {
    // 把紧挨着的「保质期到」一并算进片段，否则它会残留在名称里
    spans.push({ start: eatLeft(text, expiry.start, EXPIRY_LEAD), end: expiry.end });
  }

  /*
   * 名称的三级兜底：
   *   ① 挖掉命中片段后剥口头语 —— 正常路径
   *   ② 剥成空 → 干脆不挖片段，整句当名称
   *   ③ 还是空 → 用原文
   * 任何一级都给得出非空结果：名称是必填字段，
   * 让它空着等于把用户扔回「你得自己重打一遍」。
   */
  let name = peel(cutSpans(text, spans));
  if (!name) name = peel(text);
  if (!name) name = text;

  return {
    name,
    locationId: location?.id ?? null,
    locationText: location?.text ?? null,
    expireDate: expiry?.date ?? null,
    expireText: expiry?.text ?? null,
  };
}

/** 把库里的位置表转成解析用的瘦身形式（柜子与格位都进来） */
export function toLocationHints(
  locations: { id: string; name: string; parentId: string | null }[],
): VoiceLocationHint[] {
  const byId = new Map(locations.map((l) => [l.id, l]));
  return locations.map((l) => ({
    id: l.id,
    name: l.name,
    parentName: l.parentId ? (byId.get(l.parentId)?.name ?? null) : null,
  }));
}
