/**
 * 格物 · 标签的纯逻辑
 *
 * 标签**不是一等实体**：它只活在 `items.tags` 那个 JSON 字符串里 —— 没有自己的表、
 * 没有 id、没有 seed、没有排序字段。所以「库里有哪些标签」永远是**算出来的**，
 * 不是查出来的。
 *
 * 这是刻意的：分类是实体（有 14 个内置、有 sort_order、「未分类」兜底、备份包里按
 * UUID 判重），标签是自由文本的副产品。给副产品建表，就得把它当实体来伺候 ——
 * 孤儿标签怎么处理、删标签要不要连带删物品上的、备份包怎么合并去重，全是要写文档
 * 的裁决点。聚合方案没有这些问题：没人用它，它自己就从候选里消失了。
 *
 * 这个模块不 import expo / react-native / db —— 与 entitlement、ai/* 同一约定，
 * 好让 node:test 直接加载（`.mjs` 里 import 不了原生模块）。
 */

export interface TagCount {
  /** 展示用的写法：同一个标签在库里可能有大写/空格差异，取第一次出现的原文 */
  tag: string;
  /** 用了这个标签的物品**件数**（同一件物品里写两遍只算一次） */
  count: number;
}

/* ------------------------------------------------------------ 归一化 */

/**
 * 归一化的**唯一入口**，做三件事：
 *
 * 1. 去首尾空白 —— 「办公 」与「办公」是同一个标签。
 * 2. 内部连续空白折成一个空格 —— 「智能 家居」与「智能  家居」同一个。
 * 3. **去掉 ASCII 双引号**。
 *
 * 第 3 条不是洁癖，是硬约束：标签在库里是 JSON 数组的一段，形如 `["办公","备用"]`，
 * 而「按标签筛选」走的是 `tags LIKE '%"办公"%'`。标签里带 `"` 会让这个定界失效，
 * 结果是**筛选静默返回空**（不报错）—— 比多一个空格难查得多。
 *
 * ★ 只在**写入路径**上调用。读库时不归一化：悄悄改写用户已有的数据比留着多一个
 *   空格更糟，而且用户下次看到标签「自己变了」只会更困惑。
 */
export function normalizeTag(raw: string): string {
  return raw.replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 判重键。归一化之后再折叠大小写 —— 「Tag」与「tag」算同一个标签。
 * 折叠只影响**判重**，展示仍然用第一次出现的原文。
 */
export function tagKey(raw: string): string {
  return normalizeTag(raw).toLowerCase();
}

/* ------------------------------------------------------------ 文本 ↔ 标签 */

/**
 * 分隔符：顿号、中英文逗号、任意空白 —— 与改版前完全一致。
 *
 * 不擅自加 `;` `/` 之类：加了会把「24/7」这种标签切坏，而收益近乎零。
 * 用户在一个输入框里手打的时候，顿号是他本来就用的那个键。
 */
const TAG_SEPARATORS = /[\s、,，]+/;

/** 归一化 + 去空 + 按 key 去重（保留第一次出现的写法与顺序） */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const tag = normalizeTag(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** 把输入框里的一行文本切成标签 */
export function splitTagsText(text: string): string[] {
  return normalizeTags(text.split(TAG_SEPARATORS));
}

/** 写回输入框的文本形式（顿号分隔，与用户的手输习惯一致） */
export function joinTagsText(tags: readonly string[]): string {
  return normalizeTags(tags).join('、');
}

/** 并集：把选中的候选并进已选（自动去重，已选的排前面） */
export function addTags(current: readonly string[], incoming: readonly string[]): string[] {
  return normalizeTags([...current, ...incoming]);
}

/** 从已选里摘掉一个（按 key 比对，「Tag」能摘掉「tag」） */
export function removeTag(current: readonly string[], target: string): string[] {
  const key = tagKey(target);
  return current.filter((t) => tagKey(t) !== key);
}

/* ------------------------------------------------------------ 排序 */

/**
 * 中文排序用拼音。SQLite 的 BINARY 比较按 UTF-8 码位走，对汉字等于随机顺序；
 * 而这里其实是**内存里排**，但同一个道理 —— 直接比字符串会得到「一坨看不出规律」
 * 的顺序，所以交给 Collator。
 *
 * Hermes 在 Android 上带 Intl（走平台 ICU）；万一是没实现的环境，退回
 * localeCompare 也不至于崩。
 */
const tagCollator = (() => {
  try {
    return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  } catch {
    return null;
  }
})();

export function compareTags(a: string, b: string): number {
  return tagCollator ? tagCollator.compare(a, b) : a.localeCompare(b);
}

/**
 * 候选列表的排序：**频次降序**，同频次再按拼音。
 *
 * ★ 不能按字典序排 —— 常用的标签会被埋到后面，等于没做。用户要的是
 *   「我最常用的那几个一眼就能点到」。
 */
export function sortTagCounts(list: readonly TagCount[]): TagCount[] {
  return [...list].sort((a, b) => b.count - a.count || compareTags(a.tag, b.tag));
}

/* ------------------------------------------------------------ 聚合 */

/**
 * 把「一堆物品各自的标签」聚成候选列表。
 *
 * 入参刻意只要 `{ tags }`：既能喂 ItemView，也能在测试里喂字面量。
 * 同一件物品里重复写了两次同名标签只算一次（`seen`）——否则一件东西重复键一次，
 * 计数就被灌水，排序跟着失真。
 */
export function aggregateTagCounts(source: readonly { tags: readonly string[] }[]): TagCount[] {
  const map = new Map<string, TagCount>();
  for (const row of source) {
    const seen = new Set<string>();
    for (const raw of row.tags) {
      const tag = normalizeTag(raw);
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = map.get(key);
      if (hit) hit.count += 1;
      else map.set(key, { tag, count: 1 });
    }
  }
  return sortTagCounts([...map.values()]);
}

/* ------------------------------------------------------------ 匹配 */

/**
 * 筛选匹配：**含任一所选标签即命中**（OR）。
 *
 * ★ 为什么是 OR 而不是 AND：「一个都不选 = 全部」是自然的，但选了多个之后，
 *   稀疏打标签的库里按 AND 十次有九次是空屏 —— 用户会以为筛选坏了、东西丢了。
 *   OR 最坏情况只是多给一点，不会给出一个看起来像故障的空白页。
 *   界面上有「含任一所选」的提示把口径说清楚，不靠用户猜。
 */
export function matchesAnyTag(itemTags: readonly string[], selected: readonly string[]): boolean {
  if (selected.length === 0) return true;
  const keys = new Set(itemTags.map((tagKey)));
  return selected.some((t) => keys.has(tagKey(t)));
}

/* ------------------------------------------------------------ 全局改写 */

/**
 * 对整个库生效的标签改写。
 *
 * 「合并」不是单独一种操作 —— 它就是**改名到一个已经存在的标签**，
 * 改完之后原来那两个键自然合成一个，不需要另一套代码（也不需要另一个坑）。
 * `to` 归一化后为空字符串时，rename 退化成删除（逻辑上自洽，不用特判）。
 */
export type TagTransform =
  | { type: 'rename'; from: string; to: string }
  | { type: 'delete'; tag: string };

/**
 * 把一次全局改写作用到**一条**物品的标签数组上。
 *
 * 数据库侧和界面侧都调这一个函数：库里改完、表单里的值也要跟着改，
 * 两边各写一遍必然有一天只改一边（而且不报错）。
 */
export function applyTagTransform(tags: readonly string[], transform: TagTransform): string[] {
  if (transform.type === 'delete') return removeTag(tags, transform.tag);
  const key = tagKey(transform.from);
  const renamed = tags.map((tag) => (tagKey(tag) === key ? transform.to : tag));
  return normalizeTags(renamed);
}

/* ------------------------------------------------------------ 选择器用 */

/** 候选搜索：不区分大小写、子串匹配。留空 = 全部候选 */
export function filterTags(list: readonly TagCount[], query: string): TagCount[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((t) => t.tag.toLowerCase().includes(q));
}
