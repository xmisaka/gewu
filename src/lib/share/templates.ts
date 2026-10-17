/**
 * 格物 · 海报模板目录
 *
 * ── 为什么模板是「骨架 + 皮」，而不是四份模板 ──────────────────
 * 清册已经写过这条：三份平行模板意味着加一列要改三处，而漏掉一处的后果
 * 不是报错，是**某套模板少一行**、发出去才发现（见 `lib/inventory/styles.ts` 头注释）。
 *
 * 海报的差异比清册大（竖排和网格真不是同一张表），所以分两层：
 *   · 骨架 layout —— 槽位结构与排布：single（一物）/ grid（多件）/ stat（数字）
 *   · 皮 skin     —— 底色、字体、边距、装饰、照片形态
 * 加第五套模板 = 在下表加一个对象，**不碰任何渲染代码**。
 *
 * ── 为什么海报不跟七主题 ─────────────────────────────────────
 * 七主题是给屏幕的，海报是给「发出去」的。用户换了皮肤，去年发的那张不该跟着变样，
 * 否则「我的格物」就不成为系列，只是一堆随机配色。
 * 所以这里的色值**故意写死**，与 `constants/theme.ts` 无关 ——
 * 与清册「色彩只用 theme.ts 那条不变量管界面，导出文档是另一套命名空间」同一条理由。
 * 唯一的接口是 `accent`：组件允许调用方把它换成当前皮肤的 brand，做一点归属感。
 */

/** 海报骨架。只增不改：组件按它分支，改名等于四套模板一起消失 */
export type PosterLayout = 'single' | 'grid' | 'stat';

export type PosterSkinKey = 'sujian' | 'chenlie' | 'yizhang' | 'anfang';

/** 照片怎么用。none 纯文字 / inset 卡内小图 / full 满幅出血 */
export type PhotoMode = 'none' | 'inset' | 'full';

export interface PosterSkin {
  key: PosterSkinKey;
  /** 模板名，两个字。界面上只有这么宽 */
  name: string;
  /** 一句话用途，给模板条的长按提示与方案稿对照用 */
  tagline: string;
  layout: PosterLayout;
  photoMode: PhotoMode;
  /** 底色。深色皮只有暗房一套 */
  paper: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  accent: string;
  /** 画布内边距（360dp 宽基准） */
  pad: number;
  titleFont: 'serif' | 'sans';
  metaFont: 'serif' | 'sans';
}

/**
 * 首批四套。
 *
 * 顺序＝模板条上的顺序。素笺排第一：它不需要照片，永远可用，
 * 是「没有照片的新用户」唯一能发出去的一张。
 *
 * ★ 加模板前先读一遍第 04 节的提醒：六套里真正会被用第二次的大概只有两套。
 *   模板越多，选模板的时间越长，反而越不容易发出去。
 *
 * ★★ 下面每个色值都带 `theme-color-ok`：它们**故意不取自 theme.ts**。
 *   理由在文件头 —— 海报是发出去的作品，不该随用户换皮肤而变样。
 *   深浅两套的对比度手工核过（正文 ≥ 4.5，大字 ≥ 3.0），改色时请重新核。
 */
export const SKINS: readonly PosterSkin[] = [
  {
    key: 'sujian',
    name: '素笺',
    tagline: '纯文字，靠留白撑',
    layout: 'single',
    photoMode: 'none',
    paper: '#F7F4EF', // theme-color-ok
    ink: '#241D18', // theme-color-ok
    ink2: '#7A6C5E', // theme-color-ok
    ink3: '#9A8D80', // theme-color-ok
    line: '#E3DCD1', // theme-color-ok
    accent: '#B79C7E', // theme-color-ok
    pad: 32,
    titleFont: 'serif',
    metaFont: 'sans',
  },
  {
    key: 'chenlie',
    name: '陈列',
    tagline: '多件摆开看',
    layout: 'grid',
    photoMode: 'inset',
    paper: '#FFFFFF', // theme-color-ok
    ink: '#2B241F', // theme-color-ok
    ink2: '#5E5245', // theme-color-ok
    ink3: '#A2907C', // theme-color-ok
    line: '#F1ECE4', // theme-color-ok
    accent: '#8C5A34', // theme-color-ok
    pad: 28,
    titleFont: 'serif',
    metaFont: 'sans',
  },
  {
    key: 'yizhang',
    name: '一页账',
    tagline: '数字当主角',
    layout: 'stat',
    photoMode: 'none',
    paper: '#F2EDE5', // theme-color-ok
    ink: '#241D18', // theme-color-ok
    ink2: '#6B6055', // theme-color-ok
    ink3: '#A29084', // theme-color-ok
    line: '#DED5C7', // theme-color-ok
    accent: '#8C5A34', // theme-color-ok
    pad: 32,
    titleFont: 'serif',
    metaFont: 'sans',
  },
  {
    key: 'anfang',
    name: '暗房',
    tagline: '照片当主角',
    layout: 'single',
    photoMode: 'full',
    paper: '#171310', // theme-color-ok
    ink: '#F6EFE4', // theme-color-ok
    ink2: 'rgba(246,239,228,0.62)', // theme-color-ok
    ink3: 'rgba(246,239,228,0.40)', // theme-color-ok
    line: 'rgba(246,239,228,0.18)', // theme-color-ok
    accent: '#F6EFE4', // theme-color-ok
    pad: 28,
    titleFont: 'serif',
    metaFont: 'sans',
  },
];

/** 内容形态。与骨架同名但不同义：kind 讲「这批数据是什么」，layout 讲「怎么排」 */
export type PosterKind = 'single' | 'multi' | 'stat';

/**
 * 当前内容能用的模板。
 *
 * 三条过滤规则：
 *   ① 暗房是「照片满出血」，没有照片时它就是一整块墨 —— 不出现在列表里，
 *      而不是让人选了才发现是空的。
 *   ② 一页账只吃统计数字，单件/多选时没有它要的字段。
 *   ③ 其余都可跨 single / multi（素笺在多件时把标题换成位置名，见 model.ts）。
 */
export function skinsFor(kind: PosterKind, hasPhoto: boolean): PosterSkin[] {
  return SKINS.filter((s) => {
    /* 统计内容只认一页账：别的骨架要的是「一件东西」或「一批东西」的字段，
       它们在统计模式下拿不到，硬套出来是一张只有标题的空海报 */
    if (kind === 'stat') return s.layout === 'stat';
    if (s.layout === 'stat') return false;
    if (s.photoMode === 'full') return kind === 'single' && hasPhoto;
    return true;
  });
}

/** 按 key 取。找不到时回落到第一套 —— 存档的 skinKey 不该让页面白屏 */
export function skinOf(key: string): PosterSkin {
  return SKINS.find((s) => s.key === key) ?? SKINS[0];
}
