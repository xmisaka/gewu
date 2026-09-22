/**
 * 格物 · 分类词典与猜词
 *
 * 补偿机制之一（见 PRD 4.2 前提三）：
 * 表单只强制「名称」，若不做智能猜分类，会得到一个 500 条全是「未分类」的列表。
 *
 * 命中策略：先按名称做子串匹配（长词优先），未命中再退回 null（→「未分类」）。
 */

export interface BuiltinCategory {
  name: string;
  /** 默认保质期月数；null 表示该类通常无过期概念 */
  expireMonths: number | null;
  /** 猜词关键词，命中任一即归入本类 */
  keywords: string[];
}

/**
 * 顺序即展示顺序（sort_order 由此推导）。
 * 关键词按长度降序匹配，避免「手表」被「表」抢先。
 */
export const BUILTIN_CATEGORIES: BuiltinCategory[] = [
  {
    name: '数码',
    expireMonths: null,
    keywords: [
      '手机', '电脑', '笔记本', '平板', '相机', '镜头', '耳机', '音箱', '键盘', '鼠标',
      '显示器', '屏幕', '硬盘', '固态', '内存', '显卡', '路由', '充电宝', '充电器',
      '数据线', '转接头', '转接线', '读卡器', '智能手表', '手环', '投影', '麦克风',
      'u盘', 'u 盘', '手柄', '主机', '摄像头', '电池', '排插', '插排', '交换机',
      'hdmi', 'type-c', 'typec', 'usb', 'ipad', 'iphone', 'macbook', 'airpods',
      'thinkpad', 'kindle', 'switch', '树莓派', '开发板', '传感器', '马达', '电源',
    ],
  },
  {
    name: '工具',
    expireMonths: null,
    keywords: [
      '螺丝刀', '扳手', '锤子', '钳子', '电钻', '钻头', '卷尺', '美工刀', '剪刀',
      '热熔胶', '胶枪', '万用表', '烙铁', '电烙铁', '钳', '锯', '凿子', '水平仪',
      '工具箱', '梯子', '打气筒', '砂纸', '镊子', '扳手组', '套筒', '手电钻',
    ],
  },
  {
    name: '五金',
    expireMonths: null,
    keywords: [
      '螺丝', '螺母', '螺栓', '膨胀', '钉子', '合页', '铰链', '滑轨', '挂钩', '拉手',
      '垫片', '卡箍', '扎带', '钢丝', '链条', '轴承', '弹簧', '万向轮', '脚轮',
    ],
  },
  {
    name: '药品',
    expireMonths: 24,
    keywords: [
      '感冒', '退烧', '布洛芬', '阿莫西林', '创可贴', '碘伏', '酒精', '纱布', '绷带',
      '药膏', '眼药水', '维生素', '钙片', '益生菌', '止痛', '消炎', '藿香', '蒙脱',
      '体温计', '血压计', '药', '口罩', '抗原',
    ],
  },
  {
    name: '食品',
    expireMonths: 12,
    keywords: [
      '牛奶', '面包', '米', '面粉', '食用油', '酱油', '醋', '盐', '糖', '零食',
      '饼干', '巧克力', '咖啡', '茶叶', '坚果', '方便面', '挂面', '蜂蜜', '罐头',
      '火锅底料', '麦片', '燕麦', '饮料', '矿泉水', '啤酒', '红酒', '奶粉',
    ],
  },
  {
    name: '个护',
    expireMonths: 24,
    keywords: [
      '洗发水', '沐浴露', '牙膏', '牙刷', '洗面奶', '护肤品', '面霜', '精华', '面膜',
      '防晒', '剃须', '吹风机', '电动牙刷', '漱口水', '护手霜', '身体乳', '香水',
      '化妆', '口红', '指甲', '棉签', '卫生纸', '抽纸', '湿巾',
    ],
  },
  {
    name: '清洁',
    expireMonths: 24,
    keywords: [
      '洗衣液', '洗洁精', '洗衣粉', '柔顺剂', '消毒液', '洁厕', '去污', '拖把', '扫把',
      '抹布', '刷子', '垃圾袋', '除尘', '除螨', '滤芯', '滤网', '吸尘器',
    ],
  },
  {
    name: '厨房',
    expireMonths: null,
    keywords: [
      '锅', '碗', '盘', '刀', '砧板', '案板', '筷', '勺', '铲', '杯', '壶', '保鲜盒',
      '饭盒', '保温杯', '水壶', '电饭煲', '微波炉', '烤箱', '空气炸锅', '破壁机',
      '榨汁机', '电磁炉', '燃气灶', '油烟机', '餐具', '削皮',
    ],
  },
  {
    name: '家居',
    expireMonths: null,
    keywords: [
      '收纳', '整理箱', '置物架', '衣架', '枕头', '被子', '床单', '毯', '窗帘', '地垫',
      '台灯', '灯泡', '灯泡', '插座', '镜子', '花瓶', '香薰', '加湿器', '风扇',
      '取暖', '门锁', '挂钩', '凳', '桌', '椅', '沙发', '垃圾桶',
    ],
  },
  {
    name: '服饰',
    expireMonths: null,
    keywords: [
      '衣', '裤', '裙', '外套', '羽绒', '卫衣', '毛衣', 't恤', '衬衫', '鞋', '靴',
      '袜', '帽', '围巾', '手套', '腰带', '皮带', '包', '背包', '钱包', '眼镜',
      '太阳镜', '领带', '内衣',
    ],
  },
  {
    name: '文具',
    expireMonths: null,
    keywords: [
      '笔', '铅笔', '钢笔', '中性笔', '马克笔', '本子', '笔记', '活页', '便签', '订书机',
      '订书钉', '回形针', '文件夹', '胶棒', '橡皮', '尺子', '圆规', '计算器', '打印纸',
      '墨盒', '硒鼓', '标签纸', '信封',
    ],
  },
  {
    name: '运动户外',
    expireMonths: null,
    keywords: [
      '自行车', '山地车', '公路车', '头盔', '骑行', '瑜伽', '哑铃', '杠铃', '跳绳',
      '篮球', '足球', '羽毛球', '网球', '乒乓球', '球拍', '帐篷', '睡袋', '登山',
      '背包客', '护具', '泳', '滑板', '跑步机', '筋膜枪',
    ],
  },
  {
    name: '图书',
    expireMonths: null,
    keywords: ['书', '图书', '教材', '字典', '词典', '杂志', '绘本', '小说', '手册'],
  },
  {
    name: '宠物',
    expireMonths: 12,
    keywords: ['猫粮', '狗粮', '猫砂', '宠物', '猫', '狗', '牵引绳', '磨牙', '驱虫', '罐头', '化毛'],
  },
];

/** 空分类的展示名。不做成实体，避免用户误删。 */
export const UNCATEGORIZED = '未分类';

/** 全部关键词按长度降序展开，长词优先命中 */
const KEYWORD_INDEX: { kw: string; category: string }[] = BUILTIN_CATEGORIES.flatMap((c) =>
  c.keywords.map((kw) => ({ kw: kw.toLowerCase(), category: c.name })),
).sort((a, b) => b.kw.length - a.kw.length);

/**
 * 按物品名称猜分类。返回分类名，未命中返回 null（→「未分类」）。
 * 纯子串匹配，无副作用，可在每次名称输入时调用。
 */
export function guessCategory(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (n.length < 1) return null;
  for (const entry of KEYWORD_INDEX) {
    if (n.includes(entry.kw)) return entry.category;
  }
  return null;
}

/** 取分类的默认保质期月数 */
export function defaultExpireMonths(categoryName: string | null): number | null {
  if (!categoryName) return null;
  const found = BUILTIN_CATEGORIES.find((c) => c.name === categoryName);
  return found ? found.expireMonths : null;
}

/** 常见保质期模板，供录入页快速选择（天 → 月 的换算由 addMonths 处理） */
export const EXPIRY_PRESETS: { label: string; months: number }[] = [
  { label: '3 个月', months: 3 },
  { label: '6 个月', months: 6 },
  { label: '1 年', months: 12 },
  { label: '2 年', months: 24 },
  { label: '3 年', months: 36 },
];
