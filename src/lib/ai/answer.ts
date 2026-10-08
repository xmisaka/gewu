/**
 * 格物 · 问一问的提示词与答案清洗（纯函数）
 *
 * 这一层只做两件事：把**已经确定的事实**交给模型，再把它的回复收拾干净。
 * 它不负责决定答案里出现哪些物品 —— 那是 `retrieve.ts` 的事，
 * 也正是「接了本地库」与「通用聊天」的分界线。
 *
 * 提示词里那句「只依据给定事实改写」是整个功能可信度的支点：
 * 一旦允许模型自己组织事实，它就会在你问「家里还有什么能吃的」时
 * 顺手补上一条你并没有的泡面 —— 而答案底下那几张卡片对不上它的话，
 * 用户会先怀疑数据坏了，再怀疑这个功能。
 *
 * ── 2026-10-09：松了一次「不许点名」 ────────────────────────────
 * 原来写的是「不要列举物品清单，清单会由界面以卡片形式展示」。
 * 那条把模型逼成了复读机：它只能说「有几件快到期」，
 * 不能说「酸奶和牛奶快到期了」—— 用户读到的就是一句正确但没用的废话。
 * 现在允许它点名**最相关的一两件**，只禁止「把清单抄一遍」。
 * 反幻觉那几条一个字没松，松的只是措辞。
 */

import type { Retrieval } from './retrieve';
import { place } from './retrieve';

/** 提示词里最多铺几条候选给模型看 */
const MAX_CONTEXT_ITEMS = 12;

export interface AnswerPrompt {
  system: string;
  user: string;
}

/**
 * 组装提示词。
 *
 * `librarySize` 只用于让模型说话时有分寸（「你的 328 件物品里…」），
 * 它不是一个可以被引用的事实来源 —— 具体有几条候选，看下面那份清单。
 */
export function buildAnswerPrompt(question: string, retrieval: Retrieval, librarySize: number): AnswerPrompt {
  const system = [
    '你是「格物」这个收纳记录 App 里的问一问助手。用户问的都是「我这堆东西里……」这类问题。',
    '下面会给你【已确定的事实】与【候选物品清单】，它们全部来自用户本机的数据库。',
    '',
    '把事实说成一句像人话的回答 —— 像一个记性很好的朋友在帮你回忆，不是播报数据。',
    '',
    '硬性要求（这几条不能碰）：',
    '1. 只能使用给定事实里出现过的信息。不得补充任何物品、数字、日期或品牌。',
    '2. 不要安慰、不要编造。事实为空或表示“没找到”时，照实说没找到。',
    '3. 不要用 markdown、不要用列表符号、不要分点。',
    '',
    '措辞上（这才是你该花力气的地方）：',
    '4. 可以点名**最相关的一两件**（「酸奶和牛奶这两天到期」比「有几件快到期」有用得多），',
    '   但不要把清单抄一遍 —— 全部结果会由界面以卡片形式列在下面，重复是多余的。',
    '5. 一到两句话，口语一点。用「你」称呼，别用「用户」。',
    '6. 问「放哪了」就直接说位置；问「还剩多少」就直接说数量；别绕。',
  ].join('\n');

  const lines: string[] = [`【已确定的事实】\n${retrieval.fact}`, '', `【候选物品清单】（共 ${librarySize} 件物品，以下为命中的若干条）`];

  if (retrieval.items.length === 0) {
    lines.push('（本次没有命中任何物品）');
  } else {
    for (const it of retrieval.items.slice(0, MAX_CONTEXT_ITEMS)) {
      const days =
        it.daysToExpiry == null
          ? '未记到期'
          : it.daysToExpiry < 0
            ? `已过期 ${Math.abs(it.daysToExpiry)} 天`
            : `还剩 ${it.daysToExpiry} 天`;
      lines.push(
        `- ${it.name}｜${it.categoryName ?? '未分类'}｜${place(it)}｜${days}｜${it.quantity != null ? `剩 ${it.quantity}` : '单件'}`,
      );
    }
  }

  lines.push('', `【用户的问题】\n${question}`, '', '请只输出改写后的那一句中文，不要输出其它任何内容。');

  return { system, user: lines.join('\n') };
}

/**
 * markdown 结构的行首标记：标题、无序列表、有序列表。
 *
 * ★ 有序列表那一段（`\d+[.)]`）是补上的：原来只认「数字 + 空白」，
 *   而模型真要不听话时写的多半是「1. 酸奶」这种带点的形式 ——
 *   它正好从缝里漏过去，被当成一句普通回答显示出来。
 *   注意不能把单独的「3 天」也算进去，所以必须要求那个点或右括号。
 */
const MARKDOWN_LINE = /^\s*(?:#{1,6}|[*+-]|\d+[.)])\s/m;

/**
 * 答案里最多几个字。超了宁可丢掉模型这句、用本地那句事实。
 *
 * 120 → 200：提示词已经放宽到「一到两句话、可以点名一两件」，
 * 还卡着 120 字就会把恰好达标的好答案也一并丢掉 —— 那比不生成还伤，
 * 用户会觉得「我问了半天它在装死」。200 字仍能拦住真正的跑偏（成段输出）。
 */
export const ANSWER_MAX_CHARS = 200;

/**
 * 清洗模型回复。
 *
 * 只做「明显不可用就丢掉」这一件事，不做语义校验 —— 语义那关由
 * 「事实只来自 retrieve」在结构上守住了：模型就算乱说，界面下面挂的
 * 仍是真实卡片，用户一眼能看出对不上。
 *
 * 丢掉的情形：
 *   - 空串
 *   - 带 markdown 结构（列表、标题、代码块）—— 说明它没照要求来，多半也夹带了编造内容
 *   - 超过 ANSWER_MAX_CHARS —— 一条要滚动才能读完的「一句回答」已经跑偏了
 */
export function parseAnswer(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (MARKDOWN_LINE.test(text)) return null;
  if (text.length > ANSWER_MAX_CHARS) return null;
  return text;
}

/** 空白态的灵感问题。**全部指向库内数据**，不出现「怎么收纳更好」这类通用问题 */
export const SUGGESTED_QUESTIONS: readonly string[] = [
  '家里还有什么能吃的',
  '这个月有哪些东西要到期',
  '哪件东西日均成本最高',
  '露营装备都放在哪了',
];

/** 回答之后接着问的建议 */
export const FOLLOW_UP_QUESTIONS: readonly string[] = [
  '一共有多少件东西',
  '有什么该补货了',
  '找一下我的充电线',
];
