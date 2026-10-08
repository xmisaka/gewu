/**
 * 格物 · 领域类型
 *
 * 与《收纳柜 App 产品需求文档》第 5 章数据模型严格对齐。
 * 主键一律 TEXT UUID（前提一：导入可选「追加合并」，自增 ID 会撞车）。
 */

/** 排序用的时间戳，毫秒 */
export type Millis = number;

/** ISO 日期串，形如 `2026-09-17`；空串视为未设置 */
export type DateString = string;

/* ---------------------------------------------------------------- 物品 */

export interface Item {
  id: string;
  /** 唯一强制字段，参与模糊搜索 */
  name: string;
  /** 空值归入「未分类」，不建实体 */
  categoryId: string | null;
  locationId: string | null;
  purchaseDate: DateString | null;
  /** 单位：元，两位小数 */
  price: number | null;
  /** V1 仅录入，不做提醒 */
  expireDate: DateString | null;
  brand: string | null;
  model: string | null;
  /**
   * 同批同款的剩余件数。
   *
   * `null` = 单件物品，不启用库存 —— 这是「六根不同寿命的数据线各建一条」的入口：
   * 老数据全部落在 `null`，行为零变化。
   * 数字 = 还有几件。**0 是「用完了」**，由查询实时派生，不落状态字段，
   * 因此不构成 PRD §11 明确排除的「物品使用状态机」。
   *
   * 语义边界（写进 PRD 例外条款的那两条）：
   *   - 一条记录 = 一个批次：过期时间只有一个，六瓶不同批次的药仍建六条；
   *   - `price` 仍是**单件价**，数量不参与日均成本。
   */
  quantity: number | null;
  tags: string[];
  note: string | null;
  /**
   * 手动排序值：越小越靠前。
   * null = 未指定，手动排序时统一沉到列表末尾。
   */
  sortOrder: number | null;
  createdAt: Millis;
  updatedAt: Millis;
  /** 软删除时间；非空即位于回收站 */
  deletedAt: Millis | null;
}

/**
 * 物品列表排序方式。
 * 与 `listItems` 的 `sort` 选项、排序切换器的选项一一对应，
 * 新增一档要同时补 items.ts 的 SORT_SQL。
 */
export type ItemSort = 'recent' | 'added' | 'manual' | 'expire' | 'name';

/** 新建物品时的入参，系统字段可缺省 */
export type ItemDraft = Omit<Item, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'> & {
  id?: string;
};

/* ---------------------------------------------------------------- 分类 */

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  /** 该分类默认保质期月数，用于带出过期时间 */
  defaultExpireMonths: number | null;
  sortOrder: number;
  /** 内置分类不允许删除 */
  builtin: boolean;
}

/* ---------------------------------------------------------------- 位置 */

/** 两级结构：柜子（parentId 为空）→ 格位 */
export interface StorageLocation {
  id: string;
  name: string;
  parentId: string | null;
  note: string | null;
  builtin: boolean;
  sortOrder: number;
}

/* ---------------------------------------------------------------- 图片 */

export interface Photo {
  id: string;
  itemId: string;
  /** App 沙盒内的相对路径，绝不依赖相册引用 */
  filePath: string;
  thumbPath: string;
  sortOrder: number;
}

/* ---------------------------------------------------------------- 视图模型 */

export type ExpiryState = 'none' | 'fine' | 'soon' | 'overdue';

/**
 * 库存状态。与 ExpiryState 同构：**由查询实时算出，不落库**。
 *
 *   none  未启用库存（quantity === null），界面上一律不渲染库存相关元素
 *   ok    还有余量
 *   low   即将见底（剩 LOW_STOCK_THRESHOLD 件）
 *   empty 用完了（quantity === 0）—— 这是一条能恢复的派生状态，不是删除
 */
export type StockState = 'none' | 'ok' | 'low' | 'empty';

/** 列表行 / 详情页共用的聚合结果 */
export interface ItemView extends Item {
  categoryName: string | null;
  locationName: string | null;
  /** 柜子名（位置为格位时取其父级） */
  cabinetName: string | null;
  photoCount: number;
  /** 首图缩略图路径，无图则为 null */
  coverThumb: string | null;
  expiry: ExpiryState;
  /** 距离到期天数，负数为已过期 */
  daysToExpiry: number | null;
  /** 库存状态，由 quantity 派生。口径与 expiry 一样只在这里算一次 */
  stock: StockState;
  /** 派生指标，任一前提不满足则为 null（→ 整行隐藏） */
  holdingDays: number | null;
  dailyCost: number | null;
}

/**
 * 首页与角标用的统计。
 *
 * expiringCount 是「需要关注的」口径（30 天内到期 **含已过期**），角标用它；
 * soonCount / overdueCount / fineCount 是三个互斥分组，合计等于 total，
 * 首页那条语义计数条用它 —— 三者必须能一眼对上总数，否则用户会觉得数字不对。
 */
export interface ItemStats {
  total: number;
  totalValue: number;
  /** 到期口径：已过期 + 今天起 30 天内。首页统计卡「即将到期」用它 */
  expiringCount: number;
  /**
   * 待办口径：快到期 **∪** 该补货（quantity ≤ 1），**去重后**的件数。
   * 提醒页顶部那句与标签栏角标用它 —— 角标是「有几件事要去看」，
   * 和提醒页里实际列出的行数必须是同一个数，否则点进去一眼就对不上。
   */
  attentionCount: number;
  /** 即将到期：今天起 30 天内，不含已过期 */
  soonCount: number;
  /** 已过期 */
  overdueCount: number;
  /** 正常：其余全部（含未设过期时间的） */
  fineCount: number;
}

/* ---------------------------------------------------------------- 柜子视图 */

export interface CabinetView extends StorageLocation {
  /** 直接挂在柜子下的物品数（未指定格位） */
  looseCount: number;
  /** 全部后代格位及其物品数 */
  slots: {
    slot: StorageLocation;
    itemCount: number;
    thumbs: string[];
  }[];
  totalCount: number;
  /** 已占用格位数 / 格位总数，用于柜子卡片的占用示意 */
  occupiedSlots: number;
}

/* ---------------------------------------------------------------- 到期 */

export interface ExpiringGroup {
  /**
   * `low` 是「余量见底」而不是「快到期」，但它和另外三组共用同一套分组列表
   * 与行组件，所以并进同一个联合类型 —— 页面渲染完全走同一条代码路径。
   */
  key: 'overdue' | 'soon' | 'later' | 'low';
  title: string;
  items: ItemView[];
}
