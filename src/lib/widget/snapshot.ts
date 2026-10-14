/**
 * 格物 · 桌面小组件的「快照」
 *
 * 把「提醒页顶部那几行」压成一份小 JSON，交给 widget 去画。
 *
 * ★★ 为什么必须有一层快照，而不是让 widget 自己去查库：
 *   widget 的渲染发生在 launcher 进程 / 短命广播里（开机重建、被拖到桌面、
 *   系统每 30 分钟兜底重画）—— 那些时刻 App 的 JS 运行时未必在跑，
 *   更不该在那里现拉一次 SQLite。所以「算什么」留在 App 侧，
 *   落到磁盘一份 JSON，widget 只负责「怎么画」。
 *
 * ★★ 这个文件是**纯函数**：不 import expo / react-native / db / theme。
 *   理由和 `notify/plan.ts` 一模一样 —— 这一层算错了**不报错**，
 *   只是桌面上静静显示着一个错的数字，而用户会拿它去对 App 里的行数。
 *   纯函数才能被单测直接钉住。
 *
 * ★★ 口径一律复用现有纯函数，widget 里**绝不再算一遍**：
 *   `stockLabel` / `describeExpiryTag` / `locationPhrase`，以及调用方传进来的
 *   `attentionCount`（与标签栏角标、提醒页顶部同一口径，含跨组去重）。
 *   任何一处「在这里再算一次」都会长出第二套口径，而它们分叉时不会有任何提示。
 *
 * ★★★ **这里连「文案」一起算完，不只是数字。**
 *   原生侧用的是 RemoteViews —— 它**没有条件判断能力**，只能「取一份数据照着摆」。
 *   如果把「有待办 / 没有待办该说哪句话」留给原生，那条规则就会在 Kotlin 里长出
 *   第二份实现，而它与这里的副本分叉时同样不会报错。
 *   → 快照里带的是**已经算好的整句话**（`countLabel` / `emptyLead` / `footLeftByShownToday`…），
 *     原生只做 `setText()`。
 *
 * ★★ 例外一：「今天 / 不是今天」—— 那件事**在生成快照时根本不知道**。
 *   快照可能是昨天写的，而 widget 到明天才被系统重画 —— 若把整句
 *   「截至今天 09:12」焊进快照，那时候它就在说谎。而时间戳存在的**唯一理由**
 *   就是把「这份数据有多旧」暴露出来，写死等于把这个功能取消掉。
 *   → 所以这一句准备**两个完整版本**（`…Today` / `…Dated`），
 *     原生只做**一次同日比较**然后二选一，绝不在那边拼句子、更不格式化日期。
 *
 * ★★ 例外二：「这一屏画得下几行」—— 同样是生成时无从得知的一件事。
 *   widget 可以**长按拖动改尺寸**，而快照只在数据/主题变动时重写，
 *   所以「用户此刻把卡片拉到了多高」在写盘的那一刻根本不存在。
 *   原生拿到 `AppWidgetOptions` 才知道，由那边的一个纯算术
 *   （`GewuWidgetRender.rowsThatFit`）算出能画几行。
 *   难点在于：**行数会反过来改掉页脚那句话**（「还有 19 件」里的 19）。
 *   → 照例外一的办法办：把「按显示行数」分档的每一句**都算好带过去**，
 *     原生只做「按下标取一句」。`WIDGET_MAX_ROWS` 是档位数（备货上限），
 *     不是「桌面上一定显示这么多行」。
 */

import { describeExpiryTag, formatDateDayMonthCN, toDateString } from '../date';
import { locationPhrase } from '../notify/plan';
import { stockLabel, stockState } from '../stock';
import type { ExpiringGroup } from '../types';

/**
 * 快照的结构版本。原生侧只认这一个值，格式改了要一起改（两侧同版本发布，不做兼容）
 *
 * ★ v1 → v2（2026-10-14，为「长按改尺寸」而改）：
 *   页脚左句从**一句**变成了**按显示行数分档的数组**
 *   （`footLeftToday` → `footLeftByShownToday`），`restCount` 随之删掉 ——
 *   那个字段现在没有单一定义（「还剩几件」取决于画了几行）。
 *   版本号必须跟着升：旧版快照在新原生侧会被整份判为「不认识」退回提示态，
 *   而**这正好是想要的行为** —— 新 Kotlin 去读一个没有分档数组的 JSON，
 *   最好的结果也只是页脚一格空着，那看起来像样式坏了。
 *   升版本让它干脆退回「还没有快照」，一轮同步之后自愈。
 */
export const WIDGET_SNAPSHOT_VERSION = 2;

/** 快照在 App 私有目录里的文件名。原生侧 `GewuWidgetSnapshot` 里有一份同样的字面量，改一处要两处一起改 */
export const WIDGET_SNAPSHOT_FILE = 'widget-snapshot.json';

/**
 * 快照里最多带几行 —— 是**备货上限**，不是「桌面上一定显示几行」。
 *
 * ★ 真正画几行由原生按当前尺寸算（`GewuWidgetRender.rowsThatFit`）：
 *   卡片被拉高就多画几行，拉矮就少画几行，`shown = min(算出来的, 这里备的货)`。
 * ★ 取 8 是因为它对应卡片能拉出的最大高度：8 × 44 + 82 ≈ 434dp，
 *   而 `maxResizeHeight` 给的是 460dp —— 再往上加也没有更多内容可放了，
 *   富余的那 26dp 表现为页脚上方一点留白，是自然的分隔感，不是缺陷。
 * ★ 这个数只影响**快照多大**（8 行 JSON 约 1KB，可以忽略），
 *   把卡片拉爆也不会让桌面变慢。
 */
export const WIDGET_MAX_ROWS = 8;

/**
 * 状态色槽位。
 *
 * ★ 快照里存的是**槽位名**而不是色值：widget 要跟随 App 当前的主题
 *   （用户选了「靛青」就该画靛青），而色值随主题变、槽位语义不变。
 *   真正的色值由 `colors` 一并带过去，原生侧只做查表，不做判断。
 */
export type WidgetTone = 'clay' | 'amber';

export interface WidgetRow {
  itemId: string;
  name: string;
  /** 位置短语（「厨房吊柜 第三层」）；这件东西没登记位置时为 null */
  place: string | null;
  /** 状态胶囊文案；空串表示这一行不画胶囊 */
  statusText: string;
  tone: WidgetTone;
}

/**
 * widget 要用的色值，从**当前主题**取好一起带过去。
 *
 * 不在这个纯函数里读主题：`constants/theme.ts` 带着样式工厂，属于界面层；
 * 纯逻辑层拿到的应该已经是算好的值（映射函数见 `lib/widget/palette.ts`）。
 *
 * ★ 胶囊、圆点与卡片的**圆角**得在原生侧画位图 ——
 *   `setBackgroundColor` 只能给直角，而 RemoteViews 又没法引用一个
 *   「运行期才知道颜色」的 shape drawable。所以这里给的是**颜色**而不是资源名，
 *   原生按颜色现画。
 */
export interface WidgetColors {
  /** 卡片底色 */
  surface: string;
  /** 物品名 */
  ink: string;
  /** 位置行、页眉右侧件数 */
  ink3: string;
  /** 页脚（时间戳那一档） */
  ink4: string;
  /** 卡片内的分隔线 */
  line3: string;
  /** 页眉左侧标题、页脚右侧「打开格物」 */
  brand: string;
  /** 砖红：已过期 / 用完 */
  clay: string;
  clayBg: string;
  /** 琥珀：将到期 / 将见底 */
  amber: string;
  amberBg: string;
}

export interface WidgetNextExpiry {
  itemId: string;
  name: string;
  /** `YYYY-MM-DD` */
  date: string;
  /** 还有几天（>= 0）。算好带过来，原生侧不做日期算术 */
  days: number;
}

export interface WidgetSnapshot {
  v: number;
  /** 这一份是什么时候算的（毫秒）。**必须画在界面上** —— 见文件头的说明 */
  generatedAt: number;
  /** 主题 id，只用于排查（「为什么桌面是棕的而我选的是蓝的」） */
  themeId: string;
  colors: WidgetColors;

  /* ---------------- 呈现在卡片上的文案，全部在这里算完 ---------------- */

  /** 页眉右侧：正常态「共 4 件」，空态「0 件」 */
  countLabel: string;

  /**
   * 正常态页脚左句，**按「实际画了几行」分档**，索引 = 显示行数，值是整句。
   *
   * ★ 两套并列，是因为这里叠了**两个**「生成时不知道」的维度（见文件头）：
   *   档位（画了几行）×  日期（今天 / 隔日）。
   *   原生先按 `isStampToday` 选一套，再按下标取一句，全程不拼字符串。
   * ★ 长度恒为 `WIDGET_MAX_ROWS + 1`（下标 0…WIDGET_MAX_ROWS）。
   *   下标 0 那一档是给「一行都没画」占位的，正常态用不到（空态那几句走别的字段），
   *   但留着一个恒等长度的数组，比让原生去猜边界要好。
   */
  footLeftByShownToday: string[];
  footLeftByShownDated: string[];

  /** 空态主句（给结论） */
  emptyLead: string;
  /** 空态副句（给依据） */
  emptySub: string;
  /** 空态页脚左句「下一件 · 感冒灵颗粒 · 11 月 3 日」；没有下一件时为空串 */
  emptyNext: string;
  /** 空态页脚右句（时间戳），同样是两个完整版本 */
  stampToday: string;
  stampDated: string;

  rows: WidgetRow[];

  /* ---------------- 以下三项**不上屏**，只做审计 ---------------- */

  /**
   * 待办件数，与标签栏角标同一个口径（跨组去重后）。
   *
   * ★ 上屏的那句话是 `countLabel`，这里再带一份原始数字**不是为了显示**，
   *   而是为了让「桌面上写着共 22 件、却只画了 3 行」这类反馈能在
   *   不碰数据库的情况下先分辨：是**算错了**（原始数字就不对），
   *   还是**画得下但没有画**（数字对、`rows` 装得下却没画完）。
   *   这两件事的修法完全不同。
   * ★ 2026-10-14 那次「22 条只显示 3 条」的反馈，正是靠这个字段先排除掉了
   *   「数据没查全」——`attentionCount=22` 而 `rows.length=8`，
   *   说明取数是好的，问题在渲染层把行数写死了。
   */
  attentionCount: number;
  /** 库里未删除的物品总数，空态副句的依据 */
  totalItems: number;
  /** 未来最近的一件到期；库里没有带保质期的物品时为 null */
  nextExpiry: WidgetNextExpiry | null;
}

/**
 * 一件东西 → 一行。
 *
 * 文案与色调都由**它所在的那个组**决定，不在这里重新判断状态 ——
 * 「为什么这件显示『剩 1』而不是『6 天后到期』」的答案永远是「因为它被分进了
 * 『该补货了』那一组」，而这个分组是调用方用**跟提醒页同一个函数**算出来的。
 */
function rowOf(groupKey: ExpiringGroup['key'], item: ExpiringGroup['items'][number]): WidgetRow {
  const common = {
    itemId: item.id,
    name: item.name,
    /* 位置短语的拼法（柜子名与格位名相同时只说一次）与通知正文、详情页共用
       同一个 `locationPhrase`，不在这里另写一份 */
    place: locationPhrase(item.cabinetName, item.locationName),
  };

  if (groupKey === 'low') {
    /* 「该补货了」这一组看的是余量，所以胶囊说余量（「剩 1」/「用完了」）。
       色调跟着库存状态走：用完是砖红（该动手了），将见底是琥珀（留意） */
    return {
      ...common,
      statusText: stockLabel(item.quantity),
      tone: stockState(item.quantity) === 'empty' ? 'clay' : 'amber',
    };
  }

  return {
    ...common,
    statusText: describeExpiryTag(item.daysToExpiry),
    tone: groupKey === 'overdue' ? 'clay' : 'amber',
  };
}

/**
 * 把分组拍平成桌面上那几行。
 *
 * 三条规则，每一条都对应一个真会出问题的地方：
 *   ① **「更远」整组跳过** —— 三个月后才到期的酱油摆在桌面上只是噪音；
 *   ② **跨组去重**：一件过期的酱油同时「已过期」又「剩 1」，在提醒页里会分别
 *      出现在两组里（那是刻意的，用户要在两个语境下都看见它），但桌面上只有三行，
 *      同一件东西占两行是纯浪费。按**先出现的组**渲染，而分组顺序已经让
 *      「该补货了」排在最前，所以这类东西会以余量的样子出现；
 *   ③ **截断到 maxRows**：超出的不是丢了，页脚那句「还有 N 件」负责交代。
 */
export function buildWidgetRows(
  groups: ExpiringGroup[],
  maxRows: number = WIDGET_MAX_ROWS,
): WidgetRow[] {
  const rows: WidgetRow[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (group.key === 'later') continue;
    for (const item of group.items) {
      if (rows.length >= maxRows) break;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push(rowOf(group.key, item));
    }
    if (rows.length >= maxRows) break;
  }

  return rows;
}

/** 补零的两位数字（`9` → `09`）。不用 `toLocaleString`：它跟运行环境的 locale 走，结果不稳定 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `HH:mm`，取的是**本机时区**——快照与 widget 在同一台设备上，两者必然一致 */
function clockLabel(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 组装一整个快照。
 *
 * 入参全是「已经查好、已经算好」的东西：分组（与提醒页同一份）、待办件数、
 * 总数、最近到期、主题色。这里只做变换，不碰数据库、不读主题、不看时钟
 * （`generatedAt` 由调用方传入，所以「现在几点」这件事也是外面决定的）。
 */
export function buildWidgetSnapshot(input: {
  generatedAt: number;
  themeId: string;
  colors: WidgetColors;
  attentionCount: number;
  /** 与提醒页完全一致的分组数组（该补货了 在最前，含「更远」） */
  groups: ExpiringGroup[];
  totalItems: number;
  nextExpiry: WidgetNextExpiry | null;
  maxRows?: number;
}): WidgetSnapshot {
  const rows = buildWidgetRows(input.groups, input.maxRows);
  const { attentionCount, totalItems, nextExpiry } = input;

  const time = clockLabel(input.generatedAt);
  /* ★ 两个日期文案都是 `formatDateDayMonthCN` 的产品，但**服务的场合不同**，
     名字必须分开：`nextDateLabel` 是「下一件什么时候到期」，`stampDateLabel`
     是「这份快照是哪天算的」。写成同一个名字，将来改其中一处会静默改掉另一处 */
  const nextDateLabel = nextExpiry ? formatDateDayMonthCN(nextExpiry.date) : '';
  const stampDateLabel = formatDateDayMonthCN(toDateString(new Date(input.generatedAt)));

  /* 时间戳的两个完整版本。原生按「生成日是不是今天」二选一 ——
     见文件头：这个判断不能提前做，因为快照会在磁盘上躺到明天 */
  const stampToday = `截至今天 ${time}`;
  const stampDated = `截至 ${stampDateLabel} ${time}`;

  const empty = rows.length === 0;

  /* ★ 空态与正常态不是「两套模板」，是**同一件事的两种说法**，
     两者都必须能独立站住：空态的主句给结论、副句给依据 ——
     只有「都还好」而没有依据，用户分不清是真没事还是没数据。 */
  const countLabel = empty ? '0 件' : `共 ${attentionCount} 件`;

  /* ★★ 页脚左句**按「画了几行」分档**，每一档都是一个完整句子。
     为什么不能只算一句：画几行取决于用户把卡片拉到了多高，
     而那是**写这份快照时不存在的信息**（见文件头的「例外二」）。
     为什么不用「基础句 + 数字」让原生去拼：RemoteViews 不会拼字符串，
     一旦把拼接放进 Kotlin，这句话就有了第二份实现，而两份分叉时没有任何提示。
     ★ 「还有 N 件」的 N = **去重后的待办总数 − 实际画出来的行数**。
       不去减「各分组条数之和」：分组之间会重复计同一件（一件过期的酱油
       同时出现在「该补货了」和「已过期」里），那样算出来的数会比
       用户点进去看到的行数大。
     ★ `Math.max(0, …)` 不能省：数据在两次查询之间变动时（原生取的下标
       比实际行数大），会算出「还有 -1 件」这种句子。 */
  const footLeftByShownToday: string[] = [];
  const footLeftByShownDated: string[] = [];
  for (let shown = 0; shown <= WIDGET_MAX_ROWS; shown += 1) {
    const restPhrase = `还有 ${Math.max(0, attentionCount - shown)} 件`;
    footLeftByShownToday.push(empty ? '' : `${restPhrase} · ${stampToday}`);
    footLeftByShownDated.push(empty ? '' : `${restPhrase} · ${stampDated}`);
  }

  const emptyLead = empty ? '都还好，没有要处理的' : '';
  const emptySub = empty
    ? nextExpiry
      ? `在看着 ${totalItems} 件 · 30 天内没有要到期的`
      : `在看着 ${totalItems} 件 · 录入时填上保质期，这里就有用了`
    : '';
  const emptyNext = empty && nextExpiry ? `下一件 · ${nextExpiry.name} · ${nextDateLabel}` : '';

  return {
    v: WIDGET_SNAPSHOT_VERSION,
    generatedAt: input.generatedAt,
    themeId: input.themeId,
    colors: input.colors,

    countLabel,

    footLeftByShownToday,
    footLeftByShownDated,

    emptyLead,
    emptySub,
    emptyNext,
    stampToday,
    stampDated,

    rows,

    attentionCount,
    totalItems,
    nextExpiry,
  };
}

/**
 * 解析磁盘上的快照。
 *
 * ★ 永远不抛：读不到、被截断、版本对不上、缺字段，一律返回 null。
 *   widget 侧绝不能因为一份坏 JSON 就画出一块白板 —— 那比显示旧数据更糟，
 *   因为它看起来像「应用坏了」，而实际上只是这一份文件没写好。
 *
 * ★ 校验的粒度是**「画得出来吗」**而不是「字段齐全吗」：只检查原生侧一定会用到
 *   的那几个字段。往这里加一条「必须有 nextExpiry」，就会把「库里没有带保质期的
 *   物品」这种**完全正常**的快照判成坏的 —— 那等于让空库用户的 widget 永远白屏。
 */
export function parseWidgetSnapshot(raw: string | null | undefined): WidgetSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WidgetSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== WIDGET_SNAPSHOT_VERSION) return null;
    if (!Array.isArray(parsed.rows) || !parsed.colors) return null;
    for (const key of ['countLabel', 'emptyLead', 'emptySub', 'emptyNext', 'stampToday', 'stampDated'] as const) {
      if (typeof parsed[key] !== 'string') return null;
    }
    /* ★ 页脚分档数组必须是**非空**的字符串数组。
       空数组会让原生一档都取不到 —— 那正是「页脚那一格空白、看起来像样式坏了」
       的来源。宁可整份判为不认、退回「还没有快照」那个说得清的提示态，
       也不要画一张缺了一句话的卡片。
       （逐项校验而不是只看长度：`[null]` 会让 Kotlin 侧 setText 到一个空值。） */
    for (const key of ['footLeftByShownToday', 'footLeftByShownDated'] as const) {
      const arr = parsed[key];
      if (!Array.isArray(arr) || arr.length === 0) return null;
      if (!arr.every((item) => typeof item === 'string')) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
