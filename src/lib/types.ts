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
  expiringCount: number;
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
  key: 'overdue' | 'soon' | 'later';
  title: string;
  items: ItemView[];
}
