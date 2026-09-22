/**
 * 格物 · 设计令牌
 *
 * 从界面视觉稿提取，与 `收纳柜App界面视觉稿.html` 的 CSS 变量一一对应。
 * 所有页面与组件只允许从本文件取色/取字级，不允许硬编码色值。
 */

import { Platform } from 'react-native';

/* ------------------------------------------------------------------ 色彩 · 主题名录 */

/**
 * 五套主题，沿「纸的温度 × 墨的色相」两条轴设计。
 *
 * 四条准入规则（改任何一套前先读）：
 *   1. 语义三色是红线 —— sage / amber / clay 永远锁在绿黄红三系，
 *      主题只许微调明度，不许改色相。用户靠色相分辨状态，
 *      一旦品牌色侵占语义区，状态提示就失效了。
 *   2. brand 只管「可点」与「需注意」，不承担状态含义。
 *   3. 对比度是准入条件，不是事后优化。正文 ≥ 4.5，大字 ≥ 3.0。
 *   4. 深色不是浅色取反 —— 卡片要比背景亮才浮得起来，
 *      分隔线要比背景亮才看得见，语义色要整体提亮。玄夜是按深色逻辑单独配的。
 *
 * 四套浅色由用户任选，玄夜跟随系统深色自动生效，不出现在选择列表里。
 */
export type ThemeKey = 'sujian' | 'dianqing' | 'qingci' | 'zhusha' | 'xuanye';

export type TokenName =
  /* 面 */
  | 'paper'
  | 'canvas'
  | 'surface'
  | 'surface2'
  | 'inset'
  /* 字 */
  | 'ink'
  | 'ink2'
  | 'ink3'
  | 'ink4'
  /* 线 */
  | 'line'
  | 'line2'
  | 'line3'
  /* 品牌 */
  | 'brand'
  | 'brandDeep'
  | 'brandBg'
  /* 语义 */
  | 'sage'
  | 'sageBg'
  | 'amber'
  | 'amberBg'
  | 'clay'
  | 'clayBg'
  /* 中立 */
  | 'pure'
  | 'onAccent'
  /* 交互态 */
  | 'ripple'
  | 'rippleOnAccent'
  | 'scrim'
  | 'shadow';

export type Tokens = Record<TokenName, string>;

export interface ThemeDef {
  name: string;
  /** 设置页里的一句话说明，讲这套主题的取向 */
  note: string;
  mode: 'light' | 'dark';
  tokens: Tokens;
}

/** 四套浅色，顺序即设置页里的展示顺序 */
export const LIGHT_THEME_KEYS = ['sujian', 'dianqing', 'qingci', 'zhusha'] as const;
/** 深色档，跟随系统深色自动生效 */
export const DARK_THEME_KEY: ThemeKey = 'xuanye';
/** 无偏好时的缺省 */
export const DEFAULT_THEME_KEY: ThemeKey = 'sujian';

export const THEMES: Record<ThemeKey, ThemeDef> = {
  sujian: {
    name: '素笺',
    note: '暖米白配赭石棕，稿纸的温度',
    mode: 'light',
    tokens: {
      paper: '#F7F4EF',
      canvas: '#FBF9F6',
      surface: '#FFFFFF',
      surface2: '#FDFCFA',
      inset: '#F2EDE5',

      ink: '#2B241F',
      ink2: '#6B6055',
      ink3: '#9A8D80',
      ink4: '#C9BEB0',

      line: '#E3DCD1',
      line2: '#EBE5DB',
      line3: '#F1ECE4',

      brand: '#8C5A34',
      brandDeep: '#6B4224',
      brandBg: '#F3E9DE',

      sage: '#5F7355',
      sageBg: '#EDF1E9',
      amber: '#926521',
      amberBg: '#FBF1DF',
      clay: '#AA523D',
      clayBg: '#F9EAE5',

      pure: '#FFFFFF',
      onAccent: '#FFFFFF',

      ripple: 'rgba(43,36,31,0.05)',
      rippleOnAccent: 'rgba(255,255,255,0.22)',
      scrim: 'rgba(43,36,31,0.32)',
      shadow: '#2B241F',
    },
  },

  dianqing: {
    name: '靛青',
    note: '冷灰白配蓝黑，像钢笔墨水',
    mode: 'light',
    tokens: {
      paper: '#F2F4F8',
      canvas: '#F7F9FB',
      surface: '#FFFFFF',
      surface2: '#FBFCFE',
      inset: '#EAEEF4',

      ink: '#1C2330',
      ink2: '#576073',
      ink3: '#868FA3',
      ink4: '#BFC6D4',

      line: '#DAE0EA',
      line2: '#E5E9F1',
      line3: '#EEF1F6',

      brand: '#2C5282',
      brandDeep: '#1D3A5F',
      brandBg: '#E4EBF5',

      sage: '#4C7358',
      sageBg: '#E9F0EA',
      amber: '#8B671C',
      amberBg: '#F8F0DC',
      clay: '#A64C44',
      clayBg: '#F7E7E4',

      pure: '#FFFFFF',
      onAccent: '#FFFFFF',

      ripple: 'rgba(28,35,48,0.05)',
      rippleOnAccent: 'rgba(255,255,255,0.22)',
      scrim: 'rgba(28,35,48,0.32)',
      shadow: '#1C2330',
    },
  },

  qingci: {
    name: '青瓷',
    note: '淡青白配黛青，器物本色',
    mode: 'light',
    tokens: {
      paper: '#F1F4F2',
      canvas: '#F6F9F7',
      surface: '#FFFFFF',
      surface2: '#FBFDFC',
      inset: '#E8EFEC',

      ink: '#1F2825',
      ink2: '#58635E',
      ink3: '#87928C',
      ink4: '#C1C9C5',

      line: '#D9E2DE',
      line2: '#E4EBE8',
      line3: '#EDF2EF',

      brand: '#35605A',
      brandDeep: '#22423E',
      brandBg: '#E2EDEA',

      sage: '#587442',
      sageBg: '#EBF0E2',
      amber: '#8A6821',
      amberBg: '#F8F0DC',
      clay: '#A8503F',
      clayBg: '#F8E8E3',

      pure: '#FFFFFF',
      onAccent: '#FFFFFF',

      ripple: 'rgba(31,40,37,0.05)',
      rippleOnAccent: 'rgba(255,255,255,0.22)',
      scrim: 'rgba(31,40,37,0.32)',
      shadow: '#1F2825',
    },
  },

  zhusha: {
    name: '朱砂',
    note: '暖粉白配朱红，像盖了一枚印',
    mode: 'light',
    tokens: {
      paper: '#F9F3F0',
      canvas: '#FCF8F6',
      surface: '#FFFFFF',
      surface2: '#FEFCFB',
      inset: '#F4EAE4',

      ink: '#2E211D',
      ink2: '#6B5A53',
      ink3: '#9C8A82',
      ink4: '#CBC0B9',

      line: '#E7DAD3',
      line2: '#EFE4DE',
      line3: '#F4ECE8',

      brand: '#A8372C',
      brandDeep: '#7E251C',
      brandBg: '#F7E5E0',

      sage: '#5A7350',
      sageBg: '#EDF1E9',
      amber: '#90651D',
      amberBg: '#FBF0DC',
      clay: '#A45536',
      clayBg: '#F9E9E1',

      pure: '#FFFFFF',
      onAccent: '#FFFFFF',

      ripple: 'rgba(46,33,29,0.05)',
      rippleOnAccent: 'rgba(255,255,255,0.22)',
      scrim: 'rgba(46,33,29,0.32)',
      shadow: '#2E211D',
    },
  },

  xuanye: {
    name: '玄夜',
    note: '墨底配暖金，系统深色时自动启用',
    mode: 'dark',
    tokens: {
      paper: '#16140F',
      canvas: '#1C1A15',
      surface: '#242118',
      surface2: '#2A2620',
      inset: '#302C23',

      ink: '#F2EBDF',
      ink2: '#B5AA99',
      ink3: '#8A7F6E',
      ink4: '#5E5648',

      line: '#3A352B',
      line2: '#332F26',
      line3: '#2C2821',

      brand: '#C9985C',
      brandDeep: '#E0B47C',
      brandBg: '#3A2F20',

      sage: '#8FA87C',
      sageBg: '#2A3326',
      amber: '#D9A94E',
      amberBg: '#3A3020',
      clay: '#D57C61',
      clayBg: '#3B2822',

      pure: '#FFFFFF',
      /* 暖金品牌色偏亮，上面压白字只有 2.6 —— 必须用深墨，不能沿用浅色档的白 */
      onAccent: '#1C1A15',

      ripple: 'rgba(242,235,223,0.07)',
      rippleOnAccent: 'rgba(28,26,21,0.16)',
      scrim: 'rgba(0,0,0,0.60)',
      shadow: '#000000',
    },
  },
};

export function isDarkTheme(key: ThemeKey): boolean {
  return THEMES[key].mode === 'dark';
}

/* ------------------------------------------------------------------ 色彩 · 运行时 */

/**
 * 当前生效的主题。只有 ThemeProvider 有权改它 —— 其它地方一律只读。
 *
 * 为什么用模块级变量而不是 Context：样式的构建发生在 React 渲染之外
 * （`StyleSheet.create` 在 `makeStyles` 里被调用），拿不到 Context。
 * 这个值与 Provider 的 state 在同一个渲染周期内同步推进，
 * 由 Provider 在渲染阶段写入，保证子组件读到的永远是本次渲染对应的主题。
 */
let activeKey: ThemeKey = DEFAULT_THEME_KEY;

/** @internal 仅供 ThemeProvider 调用 */
export function setActiveThemeKey(key: ThemeKey): void {
  activeKey = key;
}

export function getActiveThemeKey(): ThemeKey {
  return activeKey;
}

export function activeTokens(): Tokens {
  return THEMES[activeKey].tokens;
}

/**
 * 渲染期读取当前主题令牌。
 *
 * 这是代理对象：每次属性访问都实时解析当前主题，所以写在 JSX 里的
 * `Palette.brand` 不需要任何改造就能跟随换肤。
 *
 * **但它不建立订阅** —— 组件仍然需要从 `useTheme()` / `useStyles()` 里
 * 拿到订阅关系，否则主题变化时它不会重渲染，读到的新值也没机会上屏。
 *
 * 另注：模块加载期读取（如 `const C = Palette.brand` 这种顶层常量）
 * 会固化成当时的主题，务必避免 —— 这类值应写进 `makeStyles` 回调里。
 */
export const Palette: Tokens = new Proxy({} as Tokens, {
  get: (_target, prop) => (activeTokens() as Record<string | symbol, unknown>)[prop],
  has: (_target, prop) => prop in activeTokens(),
  ownKeys: () => Reflect.ownKeys(activeTokens()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

/* ------------------------------------------------------------------ 色彩 · 语义色 */

/** 物品到期状态 → 配色三元组 */
export type StatusTone = {
  fg: string;
  bg: string;
  label: string;
};

const STATUS_LABELS = {
  fine: '正常',
  soon: '即将到期',
  overdue: '已过期',
  none: '未设置',
} as const;

function buildStatusTones(t: Tokens): Record<keyof typeof STATUS_LABELS, StatusTone> {
  return {
    fine: { fg: t.sage, bg: t.sageBg, label: STATUS_LABELS.fine },
    soon: { fg: t.amber, bg: t.amberBg, label: STATUS_LABELS.soon },
    overdue: { fg: t.clay, bg: t.clayBg, label: STATUS_LABELS.overdue },
    none: { fg: t.ink3, bg: t.inset, label: STATUS_LABELS.none },
  };
}

/* ------------------------------------------------------------------ 色彩 · 阴影 */

export interface ShadowTokens {
  card: {
    shadowColor: string;
    shadowOpacity: number;
    shadowRadius: number;
    shadowOffset: { width: number; height: number };
    elevation: number;
  };
  raised: {
    shadowColor: string;
    shadowOpacity: number;
    shadowRadius: number;
    shadowOffset: { width: number; height: number };
    elevation: number;
  };
}

function buildShadow(t: Tokens): ShadowTokens {
  return {
    card: {
      shadowColor: t.shadow,
      shadowOpacity: 0.05,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2,
    },
    raised: {
      shadowColor: t.shadow,
      shadowOpacity: 0.12,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
  };
}

/**
 * 按当前主题解析的派生值缓存。
 * 同一个主题内引用保持稳定，换肤时整体替换 —— 这样
 * `...Shadow.card` 展开进样式表时既拿到新主题，又不会每次生成新对象。
 */
function memoByTheme<T>(build: (t: Tokens) => T): () => T {
  let cachedKey: ThemeKey | null = null;
  let cached: T;
  return () => {
    if (cachedKey !== activeKey) {
      cached = build(activeTokens());
      cachedKey = activeKey;
    }
    return cached;
  };
}

const shadowOf = memoByTheme(buildShadow);
const statusTonesOf = memoByTheme(buildStatusTones);

export const Shadow = {
  get card() {
    return shadowOf().card;
  },
  get raised() {
    return shadowOf().raised;
  },
};

export const StatusTones = {
  get fine() {
    return statusTonesOf().fine;
  },
  get soon() {
    return statusTonesOf().soon;
  },
  get overdue() {
    return statusTonesOf().overdue;
  },
  get none() {
    return statusTonesOf().none;
  },
};

/* ------------------------------------------------------------------ 字体 */

export const Fonts = Platform.select({
  ios: { serif: 'ui-serif', sans: 'system-ui', mono: 'ui-monospace' },
  android: { serif: 'serif', sans: 'sans-serif', mono: 'monospace' },
  default: { serif: 'serif', sans: 'normal', mono: 'monospace' },
})!;

/* ------------------------------------------------------------------ 字级 */

export const Type = {
  /**
   * 页面主标题，衬线。
   *
   * 字号收小、字距拉开（26/0.6 → 23/2）：标题大多是 2～4 个字，
   * 26px 撑不满一行、字又挤在一起，显得空而硬；拉开字距之后就透气了。
   * 顺带算一下宽度：4 个字从 106px 变成 100px，长名字反而更不容易折行。
   */
  display: { fontFamily: Fonts.serif, fontSize: 23, lineHeight: 32, letterSpacing: 2 },
  /** 区块标题，衬线 */
  title: { fontFamily: Fonts.serif, fontSize: 20, lineHeight: 28, letterSpacing: 0.5 },
  /** 小标题，无衬线中等 */
  heading: { fontFamily: Fonts.sans, fontSize: 15, fontWeight: '600' as const, lineHeight: 22 },
  /** 条目名 */
  item: { fontFamily: Fonts.sans, fontSize: 16, fontWeight: '500' as const, lineHeight: 22 },
  /** 正文说明 */
  body: { fontFamily: Fonts.sans, fontSize: 14, lineHeight: 22 },
  /** 次级信息 */
  meta: { fontFamily: Fonts.sans, fontSize: 13, lineHeight: 19 },
  /** 标签 / 角标 */
  label: { fontFamily: Fonts.sans, fontSize: 11.5, lineHeight: 16 },
  /** 全大写小标 */
  eyebrow: {
    fontFamily: Fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 2,
    textTransform: 'uppercase' as const,
  },
  /** 大号数字，等宽对齐 */
  num: {
    fontFamily: Fonts.sans,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '500' as const,
    letterSpacing: -0.3,
    fontVariant: ['tabular-nums'],
  },
  /** 中号数字 */
  numSm: {
    fontFamily: Fonts.sans,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '500' as const,
    fontVariant: ['tabular-nums'],
  },
} as const;

/* ------------------------------------------------------------------ 间距 */

export const Space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/** 页面左右统一边距（视觉稿为 17） */
export const GUTTER = 17;

/* ------------------------------------------------------------------ 圆角 */

export const Radius = {
  tag: 6,
  thumb: 9,
  chip: 999,
  input: 11,
  button: 12,
  card: 14,
  sheet: 20,
  phone: 32,
} as const;

/* ------------------------------------------------------------------ 动效 */

export const Motion = {
  fast: 150,
  base: 240,
} as const;

/* ------------------------------------------------------------------ 兼容旧模板 */

/** @deprecated 模板遗留，新代码请使用 Palette */
export const Colors = {
  light: {
    text: Palette.ink,
    background: Palette.canvas,
    backgroundElement: Palette.inset,
    backgroundSelected: Palette.line2,
    textSecondary: Palette.ink2,
  },
  dark: {
    text: Palette.ink,
    background: Palette.canvas,
    backgroundElement: Palette.inset,
    backgroundSelected: Palette.line2,
    textSecondary: Palette.ink2,
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Spacing = Space;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
