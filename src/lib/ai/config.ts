/**
 * 格物 · AI 配置（Key 存取 + 模型清单 + 用量计数）
 *
 * 骨架照 `lib/photos/stock.ts` 走：Key 存在 meta 表、界面只回显掩码、
 * 编译期留一个 .env 回落值给自用构建。三处细节刻意保持一致，
 * 因为「Key 怎么存」「掩码怎么显示」「没 Key 时怎么退化」这三件事
 * 已经在那条链路上验证过一遍，不值得重新发明。
 *
 * ── 与 stock.ts 的一处**刻意差异** ──────────────────────────────
 * 这个文件不 import `expo-file-system`，也不 import 任何 expo / react-native 模块。
 * stock.ts 要下载图片所以躲不开原生；而 AI 配置只需要「读一个字符串、写一个字符串」，
 * 于是它可以在 `node:test` 里被直接 import —— 掩码、用量滚动这些纯逻辑
 * 因此能进测试，不必靠肉眼看。
 *
 * 数据库仍然只有惰性引入（`await import('../db')`）：静态引入会把
 * expo-sqlite 拖进来，测试立刻加载不了。这与 stock.ts 的写法一致。
 */

/* ------------------------------------------------------------------ 供应商与模型 */

/**
 * 只对接智谱一家，而且**不做供应商切换**。
 *
 * 理由不是懒：多供应商意味着要维护 N 套请求格式、N 种报错文案、
 * N 份「哪里去注册」的说明，而格物的 AI 是「可选的一只手」，
 * 换供应商的收益远小于它带来的维护面。真要加，就在这个文件里加一组常量。
 */
export const AI_PROVIDER = {
  name: '智谱 BigModel',
  /** 注册与控制台地址，界面上可点 */
  keyUrl: 'https://bigmodel.cn',
  /** 一句话说清门槛，用户最关心的就是「要不要钱、要不要实名」 */
  signupNote: '手机号注册即可领取，免费模型不需要充值',
} as const;

export interface AiModelDef {
  /** 请求体里 model 字段用的名称 */
  id: string;
  /** 界面上展示的名称 */
  label: string;
  /** 是否官方免费档。界面据此决定要不要写「免费」这两个字 */
  free: boolean;
}

/** 识图：GLM-4.6V-Flash，官方免费 */
export const AI_VISION_MODEL: AiModelDef = { id: 'glm-4.6v-flash', label: 'GLM-4.6V-Flash', free: true };

/** 问答：GLM-4.7-Flash，官方免费，200K 上下文对「把库摘要塞进去」绰绰有余 */
export const AI_CHAT_MODEL: AiModelDef = { id: 'glm-4.7-flash', label: 'GLM-4.7-Flash', free: true };

/**
 * 接口地址。写死一处 —— 供应商只有一家，不需要可配置。
 * `/chat/completions` 是 OpenAI 兼容格式，识图与问答共用同一个端点，
 * 差别只在消息体里是不是多一张 image_url。
 */
export const AI_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

/**
 * 单次请求上限。
 * 与 `stock.ts` 的 `REQUEST_TIMEOUT_MS` 取同一个数（12 秒），
 * 不是巧合：两个都是「用户正等着的一次联网」，超过这个时间他就会以为卡死了。
 */
export const AI_TIMEOUT_MS = 12_000;

/**
 * 识图单独给一条更宽的上限。
 *
 * 12 秒对纯文本够用，对识图远远不够：一张长边 1024 的 JPEG 要先传上去，
 * 再让模型看一遍才出结果。真机实测里用户网速只有 6.75 KB/s —— 光上传就要几十秒。
 * 60 秒听着长，但界面上「识别中」一直在转，用户知道它在做事；
 * 反倒是提前掐掉害处更大：用户会重试，而重试会撞上「同一时刻只允许一条请求」的限流。
 */
export const AI_VISION_TIMEOUT_MS = 60_000;

/** 上传的识别副本长边上限。原图始终不出手机，这一条要写在界面上 */
export const AI_UPLOAD_MAX_EDGE = 1024;

/**
 * 识别副本的 JPEG 质量。
 *
 * 0.8 → 0.7 是照真机数据调的：弱网（实测 6.75 KB/s）下，一张 1024px、0.8 质量的照片
 * 压出来约 250KB，上传要半分钟以上，直接顶到超时；超时 abort 之后的重试又撞上限流。
 * 降到 0.7 体积少约四分之一，而「看清包装上印的字」靠的是分辨率，不是这点质量。
 */
export const AI_UPLOAD_QUALITY = 0.7;

/* ------------------------------------------------------------------ 用量 */

/** 两条通道分开记，因为界面上是两行：「识别 42 次 · 问答 118 次」 */
export type AiKind = 'vision' | 'chat';

export interface AiUsage {
  /** `YYYY-MM`。月份一变就归零 —— 界面上写的是「本月用量」 */
  month: string;
  vision: number;
  chat: number;
}

export const EMPTY_USAGE: AiUsage = { month: '', vision: 0, chat: 0 };

/**
 * 把用量滚到指定月份：**月份不同就整套清零**，而不是只换个标签。
 *
 * ★ 这一步不能省。少了它，跨月之后界面会一直显示上个月的累计数，
 *   而它既不报错也不会有任何迹象 —— 用户只会觉得「怎么这个月用了这么多」。
 *   同一条规则也让它幂等：同月再调用一次，原样返回。
 */
export function rollUsage(usage: AiUsage | null | undefined, month: string): AiUsage {
  if (!usage || usage.month !== month) return { month, vision: 0, chat: 0 };
  return usage;
}

/** 记一次调用。负数与非整数一概当 0 处理，免得脏数据把计数带歪。 */
export function bumpUsage(usage: AiUsage, kind: AiKind, by = 1): AiUsage {
  const step = Number.isFinite(by) && by > 0 ? Math.floor(by) : 0;
  if (kind === 'vision') return { ...usage, vision: usage.vision + step };
  return { ...usage, chat: usage.chat + step };
}

/**
 * 本月预估花费（元）。
 *
 * 两个模型都是免费档，所以这里恒为 0 —— 但它仍然是个函数而不是写死的 `¥0.00`：
 * 将来若把某一档换成付费模型，改这一处，界面上那个数字会自己跟着变，
 * 不需要再去翻页面代码。`free` 的模型按 0 计，不参与累加。
 */
export function estimateMonthlyCost(usage: AiUsage): number {
  const rate = (m: AiModelDef): number => (m.free ? 0 : 0.01);
  return usage.vision * rate(AI_VISION_MODEL) + usage.chat * rate(AI_CHAT_MODEL);
}

/** 从 meta 里读出来的 JSON 恢复用量；坏数据一律当作没用过 */
export function parseUsage(raw: string | null): AiUsage {
  if (!raw) return { ...EMPTY_USAGE };
  try {
    const v = JSON.parse(raw) as Partial<AiUsage>;
    return {
      month: typeof v.month === 'string' ? v.month : '',
      vision: toCount(v.vision),
      chat: toCount(v.chat),
    };
  } catch {
    return { ...EMPTY_USAGE };
  }
}

function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/* ------------------------------------------------------------------ 掩码 */

/**
 * Key 掩码：只露头 6 位与尾 4 位。
 *
 * 设置页会被旁人瞥一眼，全文回显没有任何展示价值 —— 这个动作只有
 * 「确认我填过」一个用途，露出头尾就够。长度不够时退化成「首字符 + 点」，
 * 免得短 Key 被掩成一个看不出是什么的东西。
 */
export function maskKey(key: string): string {
  const k = (key ?? '').trim();
  if (!k) return '';
  if (k.length <= 8) return `${k[0]}••••`;
  return `${k.slice(0, 6)}••••••${k.slice(-4)}`;
}

/* ------------------------------------------------------------------ 存取 */

/**
 * 编译期回落值。
 *
 * 与 Pexels Key 同一个取舍：自用构建可以在仓库根的 .env 里塞一个，
 * 省去每次装机都填一遍；对外分发的包必须走 BYOK ——
 * 打进 APK 的 Key 用 jadx 一分钟就能提出来。这一点在界面上也照实说。
 */
export const ENV_API_KEY = (process.env.EXPO_PUBLIC_ZHIPU_API_KEY ?? '').trim();

/** meta 表的键名。`ai.*` 前缀与 `ui.*` / `stock.*` 并列 */
const META_KEY = 'ai.key';
const META_ENABLED = 'ai.enabled';
const META_USAGE = 'ai.usage';

let runtimeKey: string | null = null;
let runtimeEnabled: boolean | null = null;
let hydrated = false;

/** 启动时调一次，把用户存过的 Key / 开关 / 用量读进内存 */
export async function hydrateAi(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const { getDatabase, readMeta } = await import('../db');
    const db = await getDatabase();
    const [key, enabled] = await Promise.all([readMeta(db, META_KEY), readMeta(db, META_ENABLED)]);
    if (key) runtimeKey = key;
    if (enabled != null) runtimeEnabled = enabled === '1';
  } catch {
    // 库还没热起来时按「未配置」走：宁可不给，也不要默认开着一个联网能力
  }
}

/** 保存 Key；传空串即清除 */
export async function saveAiKey(key: string): Promise<void> {
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

/** 当前生效的 Key：用户填的优先，没填回落编译期 */
export function currentAiKey(): string {
  return (runtimeKey ?? ENV_API_KEY).trim();
}

/** 有没有 Key。界面据此区分「去配 Key」与「AI 坏了」两种提示 */
export function hasAiKey(): boolean {
  return currentAiKey().length > 0;
}

/**
 * 保存总开关。
 *
 * 默认是**关**的：`runtimeEnabled` 为 null 时按 false 处理。
 * 这一条是方案页 §02「三条铁律」里最重要的一条 —— 不填 Key、不开开关，
 * 就不存在任何联网链路；用户主动打开的那一刻才算知情同意。
 */
export async function saveAiEnabled(on: boolean): Promise<void> {
  runtimeEnabled = on;
  hydrated = true;
  try {
    const { getDatabase, writeMeta } = await import('../db');
    const db = await getDatabase();
    await writeMeta(db, META_ENABLED, on ? '1' : '0');
  } catch {
    // 同上：写不进去只影响下次启动
  }
}

/** 开关当前状态；null（从未设置）视为关 */
export function isAiEnabled(): boolean {
  return runtimeEnabled === true;
}

/* ------------------------------------------------------------------ 用量落盘 */

/** 读本月用量。**滚动到当前月份**后再返回，调用方不必自己判断跨月 */
export async function readAiUsage(month: string): Promise<AiUsage> {
  try {
    const { getDatabase, readMeta } = await import('../db');
    const db = await getDatabase();
    return rollUsage(parseUsage(await readMeta(db, META_USAGE)), month);
  } catch {
    return rollUsage(null, month);
  }
}

/** 写回用量。调用方传进来的应当已经过 rollUsage */
export async function writeAiUsage(usage: AiUsage): Promise<void> {
  try {
    const { getDatabase, writeMeta } = await import('../db');
    const db = await getDatabase();
    await writeMeta(db, META_USAGE, JSON.stringify(usage));
  } catch {
    // 计数是锦上添花，写不进去不该影响这次调用本身
  }
}
