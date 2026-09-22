/**
 * 格物 · 网图封面检索（Pexels）
 *
 * 定位：给「懒得拍照也不想自己找图」的物品配一张**示意封面**。
 * 因此刻意不做实物同款匹配 —— 搜「充电宝」给一张充电宝的通用图就够，
 * 目标是列表里不再是清一色的首字方块。
 *
 * 为什么是 Pexels（实测结论，别轻易改回其它源）：
 *   - 免费图库、无需署名即可商用，图片许可干净
 *   - 图 CDN 在本机与国内网络实测可达（openverse / wikimedia 均被墙）
 *   - Pixabay 的 API 通但图 CDN 返回 403，图片根本下不来
 *   - loremflickr 免注册，但出图是带 CC-NC-ND 水印的路人照，质量与许可双不合格
 *   综合下来，只有 Pexels 同时满足「图能下下来」「许可干净」「质量够用」。
 *   代价是需要注册拿一个免费 Key，但没有别的免费源能同时满足这三条。
 *
 * 设计取舍：
 *   1. 搜索词走**内置中英对照表**，不调翻译接口 —— 一次网络往返换一次请求的
 *      延迟与失败概率，不值得；且离线时至少还能用名字直接试。
 *   2. 下载图片到缓存目录而非直接入库 —— 让 pipeline.ingestMany 沿用同一条
 *      压缩/缩略图/落盘路径，网图与拍照图在存储上完全等价，
 *      备份包、导出、相册视图全部自动兼容，不需要任何特判。
 *   3. 宽高用 JPEG/PNG 头解析，不引第三方尺寸库。
 */

import { Directory, File, Paths } from 'expo-file-system';

import { uuid } from '../id';
import type { SourceImage } from './pipeline';

/* ------------------------------------------------------------ 凭证 */

/**
 * Pexels API Key（编译期回落值）。
 *
 * 优先级：用户在「我的 → 封面图源」里填的（存 meta 表）> 环境变量。
 * 两处都留是有原因的：环境变量是自用构建的便利路径；界面上可改的，
 * 是不想为了换一个 Key 重新打包时的出口。
 *
 * Key 不再硬编码在源码里 —— 写在仓库根目录的 .env（该文件不入版本库），
 * 由 Metro 在打包时按 EXPO_PUBLIC_ 前缀内联。没有 .env 也能正常构建，
 * 只是首次使用需要在界面里填一次。
 *
 * 注意：打包进 APK 的 Key 依然能被反编译提取，只适合自用构建；
 * 不要把带 Key 的 APK 对外分发。
 */
export const PEXELS_API_KEY = (process.env.EXPO_PUBLIC_PEXELS_API_KEY ?? '').trim();

/** meta 表里的键名 */
const META_KEY = 'stock.pexelsKey';

let runtimeKey: string | null = null;
let hydrated = false;

const API_BASE = 'https://api.pexels.com/v1/search';
const REQUEST_TIMEOUT_MS = 12_000;

/** 搜索与图片下载的中转目录（在 Paths.cache 下，系统可回收） */
const STOCK_DIR = 'stock';

/** 启动时调一次，把用户存过的 Key 读进内存 */
export async function hydrateApiKey(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    // 动态引入，避免 stock.ts 与 db 层产生静态循环依赖
    const { getDatabase, readMeta } = await import('../db');
    const db = await getDatabase();
    const saved = await readMeta(db, META_KEY);
    if (saved) runtimeKey = saved;
  } catch {
    // 数据库未就绪时退回编译期常量，不影响主流程
  }
}

/** 保存用户填的 Key；传空串即清除 */
export async function saveApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  runtimeKey = trimmed || null;
  hydrated = true;
  try {
    const { getDatabase, writeMeta } = await import('../db');
    const db = await getDatabase();
    await writeMeta(db, META_KEY, trimmed);
  } catch {
    // 写不进去就只在本次会话生效，界面会照实提示
  }
}

/** 当前生效的 Key */
export function currentApiKey(): string {
  return (runtimeKey ?? PEXELS_API_KEY).trim();
}

/* ------------------------------------------------------------ 类型 */

/** 一张候选封面。uri 是远程地址，选中后才下载。 */
export interface CoverCandidate {
  /** Pexels 图片 id，用作 React key */
  id: number;
  /** 已在 CDN 侧裁好的缩略方图，网格展示用 */
  thumbUri: string;
  /** 原图地址，选中后下载它 */
  fullUri: string;
  width: number;
  height: number;
  /** 摄影师署名。免费图库不强制署名，但存着更稳妥 */
  photographer: string;
  /** 摄影师主页，署名时跳转用 */
  photographerUrl: string;
}

export interface SearchCoversOptions {
  perPage?: number;
  page?: number;
}

/* ------------------------------------------------------------ 中英对照 */

/**
 * 中文 → 英文检索词映射。
 *
 * 词表刻意精简：只覆盖高频物品，命中不了的会绕一圈去猜（见 translateQuery），
 * 再不行就把中文原样丢给 Pexels —— 它偶尔也能命中。词表越大维护成本越高，
 * 而长尾物品本来就该用「品牌 + 名称」之类的组合去搜。
 */
const ZH_TO_EN: Record<string, string> = {
  /* 数码 */
  手机: 'smartphone', 手机壳: 'phone case', 充电宝: 'power bank',
  充电器: 'charger', 数据线: 'usb cable', 耳机: 'headphones',
  蓝牙耳机: 'wireless earbuds', 音箱: 'speaker', 键盘: 'keyboard',
  鼠标: 'computer mouse', 显示器: 'computer monitor', 平板: 'tablet',
  笔记本电脑: 'laptop', 电脑: 'desktop computer', 相机: 'camera',
  镜头: 'camera lens', 硬盘: 'hard drive', 固态硬盘: 'ssd',
  内存: 'ram memory', 显卡: 'graphics card', 路由器: 'wifi router',
  转接头: 'usb adapter', 读卡器: 'card reader', 智能手表: 'smartwatch',
  手环: 'fitness tracker', 投影仪: 'projector', 麦克风: 'microphone',
  手柄: 'game controller', 摄像头: 'webcam', 电池: 'battery',
  排插: 'power strip', 插座: 'power socket', U盘: 'usb flash drive',
  移动硬盘: 'external hard drive', 游戏机: 'game console',
  无人机: 'drone', 三脚架: 'tripod', 电子秤: 'digital scale',

  /* 工具 · 五金 */
  螺丝刀: 'screwdriver', 扳手: 'wrench', 锤子: 'hammer', 钳子: 'pliers',
  电钻: 'electric drill', 钻头: 'drill bit', 卷尺: 'tape measure',
  美工刀: 'utility knife', 剪刀: 'scissors', 热熔胶枪: 'hot glue gun',
  万用表: 'multimeter', 电烙铁: 'soldering iron', 锯: 'hand saw',
  水平仪: 'spirit level', 工具箱: 'toolbox', 梯子: 'step ladder',
  打气筒: 'air pump', 砂纸: 'sandpaper', 镊子: 'tweezers',
  螺丝: 'screws', 螺母: 'nuts hardware', 钉子: 'nails',
  合页: 'door hinge', 滑轨: 'drawer slide', 挂钩: 'hook',
  把手: 'door handle', 扎带: 'cable ties', 轴承: 'ball bearing',
  弹簧: 'spring', 万向轮: 'caster wheel',

  /* 药品 · 个护 */
  药箱: 'first aid kit', 创可贴: 'bandage', 口罩: 'face mask',
  体温计: 'thermometer', 血压计: 'blood pressure monitor',
  维生素: 'vitamins', 药: 'medicine pills', 眼药水: 'eye drops',
  洗发水: 'shampoo', 沐浴露: 'body wash', 牙膏: 'toothpaste',
  牙刷: 'toothbrush', 电动牙刷: 'electric toothbrush',
  洗面奶: 'facial cleanser', 面霜: 'face cream', 面膜: 'face mask skincare',
  防晒霜: 'sunscreen', 剃须刀: 'razor', 吹风机: 'hair dryer',
  护手霜: 'hand cream', 香水: 'perfume', 口红: 'lipstick',
  棉签: 'cotton swabs', 卫生纸: 'toilet paper', 抽纸: 'tissue box',
  湿巾: 'wet wipes',

  /* 清洁 */
  洗衣液: 'laundry detergent', 洗洁精: 'dish soap', 消毒液: 'disinfectant',
  拖把: 'mop', 扫把: 'broom', 抹布: 'cleaning cloth', 刷子: 'brush',
  垃圾袋: 'trash bags', 吸尘器: 'vacuum cleaner', 滤芯: 'filter cartridge',

  /* 厨房 */
  锅: 'cooking pot', 炒锅: 'wok', 平底锅: 'frying pan', 碗: 'bowl',
  盘子: 'plate', 菜刀: 'kitchen knife', 砧板: 'cutting board',
  筷子: 'chopsticks', 勺子: 'spoon', 杯子: 'mug', 水壶: 'kettle',
  保温杯: 'thermos bottle', 保鲜盒: 'food container', 饭盒: 'lunch box',
  电饭煲: 'rice cooker', 微波炉: 'microwave oven', 烤箱: 'oven',
  空气炸锅: 'air fryer', 破壁机: 'blender', 榨汁机: 'juicer',
  电磁炉: 'induction cooktop', 油烟机: 'range hood', 餐具: 'tableware',
  咖啡机: 'coffee maker', 饮水机: 'water dispenser',

  /* 食品 */
  牛奶: 'milk carton', 面包: 'bread', 大米: 'rice grains',
  面粉: 'flour', 食用油: 'cooking oil', 酱油: 'soy sauce',
  盐: 'salt', 糖: 'sugar', 零食: 'snacks', 饼干: 'cookies',
  巧克力: 'chocolate', 咖啡: 'coffee beans', 茶叶: 'tea leaves',
  坚果: 'nuts', 方便面: 'instant noodles', 蜂蜜: 'honey jar',
  罐头: 'canned food', 麦片: 'cereal', 饮料: 'beverage bottle',
  矿泉水: 'mineral water', 啤酒: 'beer', 红酒: 'red wine',
  奶粉: 'milk powder',

  /* 家居 */
  收纳箱: 'storage box', 置物架: 'shelf', 衣架: 'clothes hanger',
  枕头: 'pillow', 被子: 'quilt blanket', 床单: 'bed sheet',
  毛巾: 'towel', 窗帘: 'curtain', 地垫: 'floor mat',
  台灯: 'desk lamp', 灯泡: 'light bulb', 镜子: 'mirror',
  花瓶: 'vase', 香薰: 'aroma diffuser', 加湿器: 'humidifier',
  风扇: 'electric fan', 取暖器: 'space heater', 门锁: 'door lock',
  凳子: 'stool', 桌子: 'table', 椅子: 'chair', 沙发: 'sofa',
  垃圾桶: 'trash can', 书柜: 'bookshelf', 衣柜: 'wardrobe',
  鞋柜: 'shoe cabinet', 挂钟: 'wall clock',

  /* 服饰 */
  上衣: 'shirt', T恤: 't-shirt', 衬衫: 'dress shirt',
  外套: 'jacket', 羽绒服: 'down jacket', 卫衣: 'hoodie',
  毛衣: 'sweater', 裤子: 'pants', 牛仔裤: 'jeans', 裙子: 'skirt',
  鞋: 'shoes', 运动鞋: 'sneakers', 靴子: 'boots', 袜子: 'socks',
  帽子: 'hat', 围巾: 'scarf', 手套: 'gloves', 腰带: 'belt',
  背包: 'backpack', 钱包: 'wallet', 眼镜: 'eyeglasses',
  太阳镜: 'sunglasses', 雨伞: 'umbrella', 行李箱: 'suitcase',

  /* 文具 */
  铅笔: 'pencil', 钢笔: 'fountain pen', 中性笔: 'ballpoint pen',
  马克笔: 'marker pen', 笔记本: 'notebook', 便签: 'sticky notes',
  订书机: 'stapler', 回形针: 'paper clips', 文件夹: 'file folder',
  橡皮: 'eraser', 尺子: 'ruler', 圆规: 'compass geometry',
  计算器: 'calculator', 打印纸: 'printer paper', 墨盒: 'ink cartridge',
  信封: 'envelope', 胶带: 'adhesive tape', 胶水: 'glue',

  /* 运动户外 */
  自行车: 'bicycle', 头盔: 'helmet', 瑜伽垫: 'yoga mat',
  哑铃: 'dumbbell', 杠铃: 'barbell', 跳绳: 'jump rope',
  篮球: 'basketball', 足球: 'soccer ball', 羽毛球拍: 'badminton racket',
  网球拍: 'tennis racket', 乒乓球拍: 'ping pong paddle',
  帐篷: 'camping tent', 睡袋: 'sleeping bag', 登山杖: 'trekking poles',
  泳镜: 'swimming goggles', 滑板: 'skateboard', 跑步机: 'treadmill',
  筋膜枪: 'massage gun', 水杯: 'water bottle',

  /* 图书 · 宠物 · 其他 */
  书: 'book', 杂志: 'magazine', 绘本: 'picture book',
  猫粮: 'cat food', 狗粮: 'dog food', 猫砂: 'cat litter',
  牵引绳: 'dog leash', 玩具: 'toy', 积木: 'building blocks',
  拼图: 'jigsaw puzzle', 乐器: 'musical instrument',
  吉他: 'guitar', 口琴: 'harmonica', 钥匙: 'keys',
  打火机: 'lighter', 手电筒: 'flashlight', 望远镜: 'binoculars',
  放大镜: 'magnifying glass', 温度计: 'thermometer',
  台历: 'desk calendar', 相框: 'picture frame', 礼品盒: 'gift box',
};

/**
 * 名称里经常混着品牌、型号、规格，直接整串去搜命中率极低。
 * 这里按「去掉修饰词 → 长词优先」的顺序，从名称中捞出最有检索价值的片段。
 */
const NOISE_PATTERNS: RegExp[] = [
  /\d+(\.\d+)?\s*(mm|cm|m|寸|英寸|ml|l|升|克|g|kg|斤|w|瓦|v|伏|ah|毫安|mah|gb|tb|g)\b/gi,
  /[（(【\[][^）)】\]]*[）)】\]]/g,
  /\b(全新|二手|备用|旧的|原装|正品|进口|国产|大号|小号|中号|迷你|便携|家用|款|型|号)\b/g,
];

/**
 * 名称 → 英文检索词。
 *
 * 三步：① 直接命中词表（含别名）→ ② 去掉噪音后按最长子串命中 → ③ 猜分类英文。
 * 都失败返回 null，调用方会退回用原文搜。
 */
export function translateQuery(name: string): string | null {
  const raw = name.trim();
  if (!raw) return null;

  // 名称本身已是英文（或中英混排里的英文段），直接用
  const ascii = raw.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  const hasHan = /[\u4e00-\u9fa5]/.test(raw);

  let cleaned = raw;
  for (const p of NOISE_PATTERNS) cleaned = cleaned.replace(p, ' ');
  cleaned = cleaned.replace(/[\s\-_/·]+/g, '');

  // ① 清洗后与原名都试一遍精确命中
  for (const probe of [cleaned, raw]) {
    const hit = ZH_TO_EN[probe];
    if (hit) return hit;
  }

  // ② 子串命中，长词优先 —— 避免「手表」被「表」抢先这类误命中
  const keys = Object.keys(ZH_TO_EN).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (cleaned.includes(key)) return ZH_TO_EN[key];
  }

  // ③ 中文没救了，退回名称里的英文片段（品牌/型号往往就是英文）
  if (hasHan) {
    const latin = ascii.split(' ').filter((w) => w.length >= 3);
    if (latin.length === 0) return null;
    return latin.slice(0, 3).join(' ');
  }

  // ④ 纯英文名，原样返回，顺带去掉规格噪音
  const words = ascii.split(' ').filter((w) => w.length >= 2);
  return words.length > 0 ? words.slice(0, 4).join(' ') : null;
}

/**
 * 名称 → 分类英文兜底词。
 * 词表命中不了时（比如「小明的那个东西」），至少给一个贴合分类的通用图，
 * 比让用户面对「没有结果」友好。
 */
const CATEGORY_TO_EN: Record<string, string> = {
  数码: 'electronics gadgets',
  工具: 'hand tools',
  五金: 'hardware screws',
  药品: 'first aid medicine',
  食品: 'groceries food',
  个护: 'personal care products',
  清洁: 'cleaning supplies',
  厨房: 'kitchen utensils',
  家居: 'home decor',
  服饰: 'clothing',
  文具: 'stationery supplies',
  运动户外: 'sports equipment',
  图书: 'books stack',
  宠物: 'pet supplies',
};

export function categoryFallbackQuery(categoryName: string | null): string | null {
  if (!categoryName) return null;
  return CATEGORY_TO_EN[categoryName] ?? null;
}

/* ------------------------------------------------------------ 搜索 */

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  src: {
    original: string;
    large: string;
    large2x: string;
    medium: string;
    small: string;
    portrait: string;
    landscape: string;
    tiny: string;
  };
}

interface PexelsSearchResponse {
  photos?: PexelsPhoto[];
  error?: string;
}

/**
 * 图片下载与展示统一走 CDN 的压缩参数。
 *
 * 关键坑：Pexels 返回的 `large2x` / `large` 这些现成 URL **自带查询串**
 * （如 `?dpr=2&h=650&w=940`），再追加我们自己的 `w=` 不会覆盖它 ——
 * 实测 `large2x + w=1600` 下来的是 1300×1300 而不是 1600。
 * 所以要拿 `original`（纯净无参数）自己拼宽度，结果才可预期。
 */
function sizedUrl(base: string, width: number): string {
  // original 无查询串；若返回别的形态，先剥掉原有参数再拼
  const clean = base.split('?')[0];
  return `${clean}?auto=compress&cs=tinysrgb&w=${width}`;
}

function toCandidate(p: PexelsPhoto): CoverCandidate {
  const original = p.src.original ?? p.src.large2x ?? p.src.large;
  return {
    id: p.id,
    // 网格里只显示 260px 见方的缩略，点选后才下大图
    thumbUri: sizedUrl(original, 260),
    // 1600 已略高于管道的长边上限（MAX_EDGE=1600），
    // 再大也只是白下载几十 KB 后被自己缩掉
    fullUri: sizedUrl(original, 1600),
    width: p.width,
    height: p.height,
    photographer: p.photographer,
    photographerUrl: p.photographer_url,
  };
}

export class StockError extends Error {
  constructor(message: string, readonly kind: 'no-key' | 'network' | 'api') {
    super(message);
    this.name = 'StockError';
  }
}

/** 供界面判断是「没配 Key」还是「网络问题」，两者的提示文案完全不同 */
export function hasApiKey(): boolean {
  return currentApiKey().length > 0;
}

/**
 * 按关键词搜候选封面。
 * 关键词应当是英文；中文请先过 translateQuery。
 */
export async function searchCovers(
  query: string,
  options: SearchCoversOptions = {},
): Promise<CoverCandidate[]> {
  const key = currentApiKey();
  if (!key) {
    throw new StockError('还没配置 Pexels API Key', 'no-key');
  }

  const q = query.trim();
  if (!q) return [];

  const perPage = Math.min(Math.max(options.perPage ?? 12, 1), 24);
  const page = Math.max(options.page ?? 1, 1);
  const url = `${API_BASE}?query=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}&orientation=square`;

  let res: Response;
  try {
    res = await withTimeout(
      fetch(url, {
        headers: {
          Authorization: key,
          Accept: 'application/json',
        },
      }),
    );
  } catch (err) {
    throw new StockError(
      err instanceof Error && err.name === 'AbortError'
        ? '联网超时，检查一下网络后重试'
        : '连不上图库，检查一下网络后重试',
      'network',
    );
  }

  if (res.status === 401) {
    throw new StockError('Pexels API Key 无效，请到 pexels.com/api 重新复制', 'api');
  }
  if (res.status === 429) {
    throw new StockError('搜索太频繁了，Pexels 限流了，等一会儿再试', 'api');
  }
  if (!res.ok) {
    throw new StockError(`图库返回了异常状态（${res.status}）`, 'api');
  }

  let payload: PexelsSearchResponse;
  try {
    payload = (await res.json()) as PexelsSearchResponse;
  } catch {
    throw new StockError('图库返回内容无法解析', 'api');
  }

  const photos = payload.photos ?? [];
  return photos.map(toCandidate);
}

function withTimeout(promise: Promise<Response>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    }, REQUEST_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/* ------------------------------------------------------------ 下载 */

function stockDir(): Directory {
  const dir = new Directory(Paths.cache, STOCK_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * 读取 JPEG / PNG 头部拿尺寸。
 *
 * 为什么不用 expo-image-manipulator 的 renderAsync 顺带拿宽高：
 * 那一步会真的把整张图解一遍再编码成临时文件，为了两个数字付一次全尺寸
 * 解码的代价不划算 —— 而 ingestMany 内部本来就要重新编一遍。
 */
function readImageSize(data: Uint8Array): { width: number; height: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 4) return { width: 0, height: 0 };

  // PNG：签名 8 字节 + IHDR 块，宽高是大端 32 位
  if (
    data.byteLength > 24 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  ) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG：逐段扫描，遇到 SOFn 段即为尺寸
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.byteLength) {
      if (data[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = data[i + 1];
      // 填充字节
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // 无载荷段
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = view.getUint16(i + 2);
      // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      if (len <= 0) break;
      i += 2 + len;
    }
  }

  return { width: 0, height: 0 };
}

/**
 * 下载一张候选图到缓存目录，并包装成 SourceImage。
 *
 * 调用方拿到后直接丢给 ingestMany 即可 —— 网图与相册图在管道里没有区别。
 * 下载失败与解析失败都抛出，由调用方计入失败计数而不落半成品。
 */
export async function downloadToCache(candidate: CoverCandidate): Promise<SourceImage> {
  const dir = stockDir();
  // 后缀用 .jpg：Pexels 的 auto=compress 一律出 JPEG，给解码器一个它认识的扩展名，
  // 省得依赖「实现恰好会嗅探魔数」这种隐性契约
  const dest = new File(dir, `${uuid()}.jpg`);

  let tmp: File;
  try {
    tmp = await File.downloadFileAsync(candidate.fullUri, dest);
  } catch {
    throw new Error('图片下载失败');
  }

  try {
    const bytes = await tmp.bytes();
    const size = readImageSize(bytes);
    if (!size.width || !size.height) {
      throw new Error('图片尺寸无法识别');
    }
    return { uri: tmp.uri, width: size.width, height: size.height };
  } catch (err) {
    try {
      if (tmp.exists) tmp.delete();
    } catch {
      // 清理失败不影响主流程，缓存目录本身可回收
    }
    throw err instanceof Error ? err : new Error('图片读取失败');
  }
}

/** 清空缓存里的临时图。下载成功后由调用方回收，避免缓存目录堆积。 */
export function clearStockCache(): void {
  try {
    const dir = new Directory(Paths.cache, STOCK_DIR);
    if (dir.exists) dir.delete();
  } catch {
    // 缓存清理失败无需惊动用户
  }
}
