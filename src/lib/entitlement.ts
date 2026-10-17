/**
 * 格物 · 支持者档权益（纯逻辑）
 *
 * 这一层**不碰数据库、不碰 React**，只有三件事：
 *   ① 把一串激活码折算成权益态；
 *   ② 把「哪个功能要支持者」这张表收在一处；
 *   ③ 定义档位与失败结果的形状。
 *
 * 拆出来的理由很实际：`@/lib/db` 依赖 expo-sqlite，在 `node:test` 里根本加载不了，
 * 一旦本文件 import 它，这里的判断就全都没法测。存取在 `lib/db/license.ts`，
 * React 运行时在 `lib/store/entitlement.tsx` —— 三件事各归各的。
 *
 * 一个刻意的取舍：**不缓存解出来的档位，每次都重新验签**（Ed25519 一次约 1ms）。
 * 这样「换公钥」会自动生效 —— 老库里存着的码验不过就自然降为免费档，
 * 不会留下一份与公钥对不上的陈旧授权。
 */

import type { ThemeKey } from '@/constants/theme';
// 刻意用相对路径：`@/` 别名只在 bundler / tsconfig 里成立，
// Node 原生跑测试时解析不了 —— 而这个文件必须能被测试直接 import。
import {
  describeLicenseFailure,
  normalizeLicenseCode,
  verifyLicenseCode,
  type LicenseFailureReason,
  type LicensePayload,
} from './license';

export type Edition = 'free' | 'sup';

export interface Entitlement {
  edition: Edition;
  /** 规范化后的激活码（去空白）；未激活为 null */
  code: string | null;
  /** 载荷里的签发日期 yyyy-mm-dd */
  issuedOn: string | null;
  /** 载荷里的标识：邮箱或订单号，没有就是 null */
  label: string | null;
  /** 是否已解锁支持者功能。与 `edition === 'sup'` 等价，但读起来更直白 */
  entitled: boolean;
}

export const FREE_ENTITLEMENT: Entitlement = {
  edition: 'free',
  code: null,
  issuedOn: null,
  label: null,
  entitled: false,
};

/** 把一份已验通的载荷 + 原始码折成权益态。 */
export function entitlementFrom(payload: LicensePayload, code: string): Entitlement {
  return {
    edition: 'sup',
    code,
    issuedOn: payload.issuedAt || null,
    label: payload.subject || null,
    entitled: true,
  };
}

/**
 * 从一串码推出权益态。
 * 验不过一律返回免费档 —— 权益方向上的默认值只能是「不给」。
 *
 * 第二参可覆盖公钥，与 `verifyLicenseCode` 保持同一个逃生口：
 * 测试用假密钥签的码，以及将来真换公钥时都用得上。
 */
export function entitlementFromCode(
  code: string | null | undefined,
  publicKeyB64Url?: string,
): Entitlement {
  const normalized = normalizeLicenseCode(code ?? '');
  if (!normalized) return FREE_ENTITLEMENT;
  const result = verifyLicenseCode(normalized, publicKeyB64Url);
  if (!result.ok) return FREE_ENTITLEMENT;
  return entitlementFrom(result.payload, normalized);
}

export type ActivationCheck =
  | { kind: 'ok'; entitlement: Entitlement }
  /** 拒绝，并带上可以直接显示给用户的一句话 */
  | { kind: 'rejected'; reason: LicenseFailureReason; message: string };

/**
 * 校验一串码。**只校验、不落盘** —— 落库是调用方的事，
 * 而且顺序必须是「先验通、再落库」：反过来会让「存进去了但没生效」
 * 变成一个需要排查的状态，而激活码是不可编辑的长字符串，
 * 用户很难自己看出来哪一位粘错了。
 */
export function checkActivation(code: string, publicKeyB64Url?: string): ActivationCheck {
  const normalized = normalizeLicenseCode(code ?? '');
  const result = normalized
    ? verifyLicenseCode(normalized, publicKeyB64Url)
    : ({ ok: false, reason: 'empty' } as const);

  if (!result.ok) {
    return { kind: 'rejected', reason: result.reason, message: describeLicenseFailure(result.reason) };
  }

  return { kind: 'ok', entitlement: entitlementFrom(result.payload, normalized) };
}

/* ------------------------------------------------------------ 门控表 */

/**
 * 需要支持者档的功能。**这张表是唯一的真相** ——
 * 界面不要自己写 `entitled && xxx`，否则以后漏掉一处就是一道暗门。
 */
/**
 * ★ 2026-10-17 起 `'ai'` **不再是**「整个 AI 一族」：
 *   单张识物与语音录入放开到免费档，只留批量识图与问一问收费，键名同步改成 `'aiPro'`。
 *   保留 `'ai'` 会让人以为它还是全家桶 —— 而这个错误的代价是有人把门控加回录入页。
 */
export type SupporterFeature = 'theme' | 'aiPro' | 'stats' | 'inventory';

/** 门控浮层的标题与正文用得到；文案放在这儿，三处入口才不会各说各话 */
export interface SupporterFeatureCopy {
  /** 短名。门控浮层的标题与说明页的卡片标题共用同一个 —— 两处叫不同的名字，
   *  用户会以为是两样东西 */
  name: string;
  /** 说明页卡片副标题：一句话说清这一项换来了什么 */
  tagline: string;
  /** 说明页「免费档」一侧：不买这边是什么体验 */
  freeSide: string;
  /** 说明页「支持者档」一侧：多出来的具体是什么 */
  proSide: string;
  /** 门控浮层的标题 */
  sheetTitle: string;
  /**
   * 门控浮层的正文。
   *
   * 与 `tagline` 是**两种场合的同一件事**，不是重复：浮层是「你刚被挡住」的语境，
   * 需要立刻交代边界（你不会失去什么）；说明页是「我在看值不值」的语境，
   * 只需要一句话讲清收益。两份语气都有存在的理由，但**事实只有一个** ——
   * 改任何一处都得同时看另一处。
   */
  sheetBody: string;
}

export const SUPPORTER_FEATURES: Record<SupporterFeature, SupporterFeatureCopy> = {
  theme: {
    name: '主题皮肤',
    tagline: '六套浅色，换一种纸的质地',
    freeSide: '素笺、靛青、青瓷三套免费',
    proSide: '再解锁朱砂、藕荷、胭脂',
    sheetTitle: '支持者功能',
    sheetBody: '六套浅色全部解锁，含后续新增。免费档的三套照旧可用，深色下仍自动用玄夜。',
  },
  aiPro: {
    name: 'AI 进阶',
    tagline: '批量识图、问一问',
    freeSide: '单张识物与语音录入已经免费',
    proSide: '批量识图（一次 9 张）、问一问',
    sheetTitle: '支持者功能',
    /* ★ 「批量识图」四个字必须留在 proSide 与 sheetBody 里：
       它是最省事的那一项，漏了会让人以为它不在权益里。`tests/pro-page.test.mjs` 钉着。
       ★ 2026-10-17 起这一项只包含批量识图与问一问 —— 单张识物、语音录入已放开到免费档，
       文案里不许再出现「四个入口」。 */
    sheetBody:
      '批量识图一次可选 9 张，逐张入库；问一问按你库里的记录回答。单张识物与语音录入免费档已有。',
  },
  stats: {
    name: '统计洞察',
    tagline: '钱花在哪，柜子塞到几成',
    freeSide: '清单、到期提醒、库存照常',
    proSide: '总价值、日均持有成本、分类分布、柜子占用、入库趋势',
    sheetTitle: '支持者功能',
    sheetBody:
      '总价值、日均成本、分类分布、柜子占用与入库趋势。免费档的清单与提醒照旧。',
  },
  inventory: {
    name: '家庭财产清册',
    tagline: 'A4 排版，可直接打印',
    freeSide: 'CSV 导出照旧',
    proSide: '三种版式，一次生成 PDF 与 HTML',
    sheetTitle: '支持者功能',
    sheetBody:
      '卷宗、账簿、活页三种版式，一次生成 PDF 与 HTML。免费档的 CSV 导出与备份照旧。',
  },
};

/**
 * 免费档的物品数量上限。
 *
 * ★ 2026-10-17 定的一版权益：免费档**不再是无上限**，改为 150 件。
 *   挑 150 的理由：普通家庭记到 150 件已经算勤，而拿它当仓库系统用的人会远超这条线 ——
 *   挡的是后者，不是前者。
 * ★★ 到顶**只挡新增**：查、改、删、导出、备份、清册全部照旧；
 *   已经超过 150 件的老用户不回溯、不锁库。否则升级一次就等于让老用户没法用。
 */
export const FREE_ITEM_LIMIT = 150;

/** 允许的物品总数；`null` = 不限 */
export function itemLimit(entitled: boolean): number | null {
  return entitled ? null : FREE_ITEM_LIMIT;
}

/** 还能再记几件；不限时返回 `null` */
export function quotaLeft(used: number, entitled: boolean): number | null {
  const limit = itemLimit(entitled);
  return limit === null ? null : Math.max(0, limit - used);
}

/** 到顶了没有。★ 老用户超额（used > limit）也算到顶 —— 只挡新增，不动存量 */
export function isQuotaFull(used: number, entitled: boolean): boolean {
  const left = quotaLeft(used, entitled);
  return left !== null && left <= 0;
}

/** 新增物品的配额判定结果 */
export interface QuotaVerdict {
  ok: boolean;
  /** 还能再记几件；不限时为 `null` */
  left: number | null;
  /** 不通过时给用户的一句话；通过时为 `null` */
  message: string | null;
}

/**
 * 能不能再记 `want` 件。
 *
 * ★ 判据是「这一次要存的件数」而不是「有没有满」：批量识图一次可能选 9 张，
 *   还剩 3 件时半推半就地存进去一半（而且不报错），用户只会看到「存了 9 件」的提示
 *   而列表里只多了 3 件。要么整批过、要么整批挡住。
 * ★ 提示里**必须**先讲「已有的不受影响」：付费墙的话术先讲限制，用户第一反应是
 *   「我的东西会不会被锁 / 被删」，而这里两者都不会发生。
 */
export function checkNewItems(used: number, want: number, entitled: boolean): QuotaVerdict {
  const left = quotaLeft(used, entitled);
  if (left === null) return { ok: true, left: null, message: null };
  if (want <= left) return { ok: true, left, message: null };

  const head =
    left <= 0
      ? `免费档最多记 ${FREE_ITEM_LIMIT} 件，已经满了。`
      : `免费档最多记 ${FREE_ITEM_LIMIT} 件，还剩 ${left} 件，这次要存 ${want} 件。`;
  return {
    ok: false,
    left,
    message: `${head}已记下的照旧能查、能改、能导出。想再记新的，删掉几件不要的，或激活支持者档。`,
  };
}

/**
 * 免费档的基础能力 —— 说明页两栏对比里的左栏。
 *
 * ★ 刻意**正面列出**，而不是写成「支持者档有这些、免费档没有」的反面清单。
 *   这一版要修的问题就是「权益看不见」，但修法不能是把免费档说残 ——
 *   它是完整版，只是没有那三样锦上添花的东西。少写这一栏，用户会默认
 *   「免费=试用版」，那比现在更糟。
 */
export const FREE_BASELINE: readonly string[] = [
  `物品 ${FREE_ITEM_LIMIT} 件`,
  '录入 · 编辑 · 搜索',
  '分类与标签',
  '到期提醒',
  '库存与数量',
  '照片与备份恢复',
  '回收站与批量整理',
  '单张识物 · 语音录入',
] as const;

/**
 * 需要支持者档才能选的浅色主题。
 *
 * **素笺、靛青、青瓷三套免费** —— 免费档有三套可用，是刻意留的余量：
 * 只给一套的话，界面在「我能不能换个颜色」这件事上完全没有商量余地，
 * 而换肤本来就不该是付费墙的第一道。
 *
 * 玄夜（`xuanye`）不在这张表里，也不在选择器里 ——
 * 它是系统深色时的自动接管，锁住它等于让深色模式用户没有主题可用，
 * 那不是一个「权益」，是坏掉的功能。
 */
export const SUPPORTER_THEME_KEYS: readonly ThemeKey[] = ['zhusha', 'ouhe', 'yanzhi'] as const;

export function isThemeLocked(key: ThemeKey, entitled: boolean): boolean {
  if (entitled) return false;
  return (SUPPORTER_THEME_KEYS as readonly string[]).includes(key);
}
