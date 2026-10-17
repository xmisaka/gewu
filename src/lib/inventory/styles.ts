/**
 * 格物 · 财产清册 · 三套版式参数
 *
 * ── 为什么是「一份模板 + 三组 token」，而不是三份模板 ──────────────
 * 三份平行模板意味着以后加一列要改三处；忘掉一处的后果不是报错，而是
 * **某套样式少一列**、打出来才发现。项目里 AI 四入口的文案已经踩过这个坑
 * （四处各写一遍，改一处必看另外三处），这里从一开始就只留一份 HTML 模板
 * （见 `html.ts`），三套的差异全部收敛到本文件的数值与颜色。
 *
 * ── 打印物为什么不跟 App 七主题 ────────────────────────────────
 * 七主题是给屏幕的：素笺的暖白是因为背光，玄夜是为了夜里不刺眼。
 * 纸上没有背光，也没有深色墨水；而且用户换了皮肤，去年归档的册子不该跟着变样。
 * 所以这里的色值**故意写死**，与 `constants/theme.ts` 无关 ——
 * 「色彩只用 theme.ts」那条不变量管的是界面，导出文档是另一套命名空间。
 *
 * ── 行距为什么带小数 ──────────────────────────────────────────
 * ★★★ 声明 `td { height: 7mm }` 时，`border-collapse` 的边框会**额外**占掉
 * 1px（≈0.264mm），实测渲染出来的行距是 7.264mm。页眉、表头同样各有 +0.13~0.26mm。
 * 按纸面整数算分页，每页会多排两行，然后被 `.page` 的 `overflow:hidden`
 * **静默切掉**（2026-10-17 打样实测：声明 7mm → 实测 7.264mm → 33 行计划只装得下 31 行）。
 * 所以 `header / thead / row` 一律记**含边框的实测值**，并额外留 `SAFETY_MM`。
 * 宁可每页少排两行（多出一页），也不能切掉半行。
 */

/** A4 纸面，单位 mm。页高取 296.5 而不是 297：见 `pageMetrics` 的注释 */
export const PAPER = { width: 210, height: 296.5 } as const;

/**
 * 传给 `printToFileAsync` 的页面尺寸，单位是 **72 PPI 的像素**。
 *
 * ★★★ 这两个数必须显式传。expo-print 安卓侧的默认值是 `612 × 792`（美国 Letter），
 * 漏传会让每页纵向少 50px ≈ 17.6mm，最后一两行被切在页外，**且页数照样对、不报错**。
 * A4 = 210mm × 297mm @72PPI = 595 × 842。
 */
export const PRINT_SIZE = { width: 595, height: 842 } as const;

export type InventoryStyleKey = 'dossier' | 'ledger' | 'binder';

export interface InventoryStyle {
  key: InventoryStyleKey;
  /** 面板上的中文名 */
  name: string;
  /** 面板上的一句话用途 */
  tagline: string;
  /** 样本缩略图的形态，纯给 RN 端画小图用 */
  family: 'serif' | 'sans';
  pad: { top: number; right: number; bottom: number; left: number };
  /** 页眉高（含下边框，实测值） */
  header: number;
  /** 表头高（含下边框，实测值） */
  thead: number;
  /** 行距（含行底边框，实测值） */
  row: number;
  /** 正文字号 pt */
  fontSize: number;
  /** 末页附页的形态：签署栏 / 高价值品登记 / 位置汇总 */
  extra: 'signature' | 'register' | 'locations';
  ink: string;
  ink2: string;
  accent: string;
  rule: string;
  tint: string;
  /** 朱印（只有账簿版的封面会画）。三套都留着这个字段，类型才不用做联合 */
  seal: string;
}

/** 表头与页眉之间的空隙、页脚预留、兜底余量，单位 mm */
const TABLE_GAP_MM = 2;
const FOOTER_RESERVE_MM = 9;
const SAFETY_MM = 3;

export const INVENTORY_STYLES: Record<InventoryStyleKey, InventoryStyle> = {
  dossier: {
    key: 'dossier',
    name: '卷宗',
    tagline: '正式、可归档、带签署栏',
    family: 'serif',
    pad: { top: 22, right: 20, bottom: 20, left: 22 },
    header: 12.3,
    thead: 8.2,
    row: 7.3,
    fontSize: 8.6,
    extra: 'signature',
    ink: '#1F1B17', // theme-color-ok
    ink2: '#5C534A', // theme-color-ok
    accent: '#3A2E24', // theme-color-ok
    rule: '#3A2E24', // theme-color-ok
    tint: '#F2EDE5', // theme-color-ok
    seal: '#9E3B2E', // theme-color-ok
  },
  ledger: {
    key: 'ledger',
    name: '账簿',
    tagline: '行距宽，留白给人手写',
    family: 'serif',
    pad: { top: 24, right: 20, bottom: 22, left: 20 },
    header: 12.3,
    thead: 8.2,
    // 10.4mm 的「手写行高」是账簿版的全部意义：印出来要能拿笔往上补
    row: 10.7,
    fontSize: 8.8,
    extra: 'register',
    ink: '#3A2E24', // theme-color-ok
    ink2: '#6E5C4A', // theme-color-ok
    accent: '#8C5A34', // theme-color-ok
    rule: '#C9B49B', // theme-color-ok
    tint: '#FBF6EE', // theme-color-ok
    seal: '#9E3B2E', // theme-color-ok
  },
  binder: {
    key: 'binder',
    name: '活页',
    tagline: '最紧凑，附位置索引与应急联',
    family: 'sans',
    pad: { top: 18, right: 18, bottom: 18, left: 20 },
    header: 10.3,
    thead: 7.2,
    row: 6.3,
    fontSize: 8.2,
    extra: 'locations',
    ink: '#23262B', // theme-color-ok
    ink2: '#5B626B', // theme-color-ok
    accent: '#35506B', // theme-color-ok
    rule: '#9AA7B4', // theme-color-ok
    tint: '#F4F6F8', // theme-color-ok
    seal: '#9E3B2E', // theme-color-ok
  },
};

export const INVENTORY_STYLE_ORDER: readonly InventoryStyleKey[] = ['dossier', 'ledger', 'binder'];

export interface PageMetrics {
  /** 正文可用宽度 mm（左右白边已扣除） */
  contentWidth: number;
  /** 明细页每页能排几行（含分组标题行） */
  rowsPerPage: number;
}

/**
 * 每页能排几行。
 *
 * 页高 296.5 而不是 297：页容器高度正好等于纸高时，Chromium 的取整会把它
 * 挤到下一页，凭空多出一堆空白页（打样时 297mm 会得到「页数 + 若干」）。
 * 少这 0.5mm 由页内白边吃掉，看不出来。
 */
export function pageMetrics(style: InventoryStyle): PageMetrics {
  const usable =
    PAPER.height -
    style.pad.top -
    style.pad.bottom -
    style.header -
    TABLE_GAP_MM -
    style.thead -
    FOOTER_RESERVE_MM -
    SAFETY_MM;
  return {
    contentWidth: PAPER.width - style.pad.left - style.pad.right,
    // 下限 8 行：再挤就该换样式，而不是把行压到看不清
    rowsPerPage: Math.max(8, Math.floor(usable / style.row)),
  };
}

/** 末页附页的数量（签署栏 1 页；登记 + 异动 2 页；位置汇总 + 应急联 2 页） */
export function extraPageCount(style: InventoryStyle): number {
  return style.extra === 'signature' ? 1 : 2;
}
