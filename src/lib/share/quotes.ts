/**
 * 格物 · 海报题语
 *
 * 海报上那句话是整个功能的情绪支点。模板只决定「好看」，题语决定
 * 「有没有话说」—— 人发朋友圈从来不是因为图好看，是因为有话要说。
 *
 * 三条规矩：
 *   ① 每条都在 20 字以内。海报题语区只有两行，超了就挤掉落款。
 *   ② 分三组：认领（这东西是我的）/ 年岁（用了多久）/ 生活（过日子的态度）。
 *      不分组的「金句库」最后一定会变成一堆同质的鸡汤。
 *   ③ 按 seed 稳定选取，**不用 Math.random()**。同一件东西每次进来
 *      应该看到同一句 —— 换一句会让人以为上次那句丢了，而且没法写测试。
 */

export type QuoteGroup = '认领' | '年岁' | '生活';

export interface PosterQuote {
  text: string;
  group: QuoteGroup;
}

/**
 * 默认题语池。
 *
 * ★ 加一条之前先看：这句话放在「我妈问我充电线在哪」的场景里会不会显得矫情。
 *   海报的默认语气是「安静地陈述」，不是抒情。
 */
export const POSTER_QUOTES: readonly PosterQuote[] = [
  { text: '它一直在那儿，只是我忘了。', group: '认领' },
  { text: '找东西这件事，终于不用靠记性。', group: '认领' },
  { text: '每一个都有自己的位置。', group: '认领' },
  { text: '第五年了，还在用。', group: '年岁' },
  { text: '买的时候心疼，用久了就值了。', group: '年岁' },
  { text: '有些东西，用旧了才像自己的。', group: '年岁' },
  { text: '把日子过成一格一格的样子。', group: '生活' },
  { text: '东西少了，心就宽了。', group: '生活' },
];

/** 题语为空时的兜底：不写「未设置」，那是一句界面话，不该出现在海报上 */
export const QUOTE_FALLBACK = POSTER_QUOTES[0].text;

/**
 * 稳定散列（djb2）。
 *
 * 只用来「从固定的几条里挑一条」，不做安全用途。
 * 取 `>>> 0` 是为了避免 32 位溢出成负数，导致下标为负。
 */
function hash(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/**
 * 按 seed 挑一条题语。同一 seed 永远同一条。
 *
 * seed 用物品 id 或「选中的第一个 id」—— 多件海报也保持稳定。
 */
export function pickQuote(seed: string): string {
  if (POSTER_QUOTES.length === 0) return QUOTE_FALLBACK;
  return POSTER_QUOTES[hash(seed) % POSTER_QUOTES.length].text;
}

/** 按组取，给题语面板分组展示用 */
export function quotesOf(group: QuoteGroup): PosterQuote[] {
  return POSTER_QUOTES.filter((q) => q.group === group);
}

/** 题语面板的分组顺序（固定，不依赖对象键顺序） */
export const QUOTE_GROUPS: readonly QuoteGroup[] = ['认领', '年岁', '生活'];
