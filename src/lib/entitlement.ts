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
export type SupporterFeature = 'theme' | 'ai' | 'stats';

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
    freeSide: '素笺、靛青、青瓷三套免费，日常记录够用',
    proSide: '再解锁朱砂、藕荷、胭脂',
    sheetTitle: '支持者功能',
    sheetBody:
      '六套浅色主题全部解锁，含后续新增。免费档保留「素笺」「靛青」「青瓷」三套，日常记录完全够用；系统深色时的「玄夜」照旧，不受影响。',
  },
  ai: {
    name: 'AI 功能',
    tagline: '少打字 —— 拍一张、选一批、说一句就能入库',
    freeSide: '逐条手工录入照旧，字段一个不少',
    proSide: '拍照识物、批量识图、问一问、语音录入四个入口',
    sheetTitle: '支持者功能',
    /* ★ 「四个入口」是刻意数出来的：识物 / 批量识图 / 问一问 / 语音。
       漏掉批量识图会让用户以为它不在权益里 —— 而它恰恰是最省事的那个。
       改动时连同 `pro.tsx` 的 `AI_ENTRY_HINT` 与官网 `rc.py` 的 `PLAN` 一起看。 */
    sheetBody:
      '识物入库、批量识图、问一问与语音录入：拍一张、一次选一批、或者说一句，就能带出名称、分类和规格，省掉手工敲字。批量识图一次能选最多 9 张照片，逐张识别后在清单里核对、一次入库。免费档不受影响，逐条手工录入照旧，功能一个不少；Key 由你自己申请、调用量记在你自己的账号上，格物不代出 Key、也不按量收费。',
  },
  stats: {
    name: '统计洞察',
    tagline: '看懂家底 —— 钱花在哪、柜子塞到几成',
    freeSide: '列表、到期提醒、库存照常',
    proSide: '总价值、日均持有成本、分类分布、柜子占用、入库趋势',
    sheetTitle: '支持者功能',
    sheetBody:
      '总价值、日均持有成本、分类价值分布、柜子占用与近半年入库趋势，一页看完。免费档的录入、到期提醒、库存、照片与备份全部照旧，功能一个不少。',
  },
};

/**
 * 免费档的基础能力 —— 说明页两栏对比里的左栏。
 *
 * ★ 刻意**正面列出**，而不是写成「支持者档有这些、免费档没有」的反面清单。
 *   这一版要修的问题就是「权益看不见」，但修法不能是把免费档说残 ——
 *   它是完整版，只是没有那三样锦上添花的东西。少写这一栏，用户会默认
 *   「免费=试用版」，那比现在更糟。
 */
export const FREE_BASELINE: readonly string[] = [
  '物品录入 · 编辑 · 搜索',
  '分类与标签',
  '到期提醒',
  '库存与数量',
  '照片与备份恢复',
  '回收站与批量整理',
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
