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
 * 支持的供应商。
 *
 * ── 为什么从「只对接智谱一家」改成可切换 ──────────────────────────
 * 原来这里写着「不做供应商切换」，理由是「多供应商＝维护 N 套请求格式」。
 * 那个理由现在不成立了：**业界已经收敛到 OpenAI 兼容格式**，
 * 换一家只是换一组常量（端点 + 模型名 + 注册地址），请求体一个字节都不用改。
 * 而收益是实打实的：智谱免费档慢、并发只给一条，用久了体验很差，
 * 用户想换成 DeepSeek / Kimi 或自建端点，不该由我发版来决定。
 *
 * ★★ 两条**必须**守住的：
 *
 * 1. **不是每家都能识图。** DeepSeek 的 V4 系列是纯文本模型（看不了图），
 *    `deepseek-v4-flash-vision-exp` 是实验性的、不保证可用。
 *    所以这里用一个可空的 `visionModel` 表达「这家不支持识图」——
 *    少了这个字段，用户一选 DeepSeek，识物会在点下去的瞬间坏掉，
 *    而且报的是模型侧的错，完全看不出是「这家本来就不支持」。
 *
 * 2. **模型名会变。** `deepseek-chat` / `deepseek-reasoner` 这两个用了一年的名字
 *    在 2026-07-24 被官方**直接下线**（不是废弃，是请求直接失败）。
 *    所以模型名必须让用户能改 —— 见 `customVisionModel` / `customChatModel`。
 *    写死在这里的名字，早晚有一天会变成一条报错。
 */
export interface AiProviderDef {
  /** 存进 meta 的标识，改了就等于让所有人的选择失效，别动 */
  key: string;
  name: string;
  /** 去哪注册、去哪拿 Key。界面上可点 */
  keyUrl: string;
  /** 一句话说清门槛 —— 用户最关心「要不要钱、要不要实名」 */
  signupNote: string;
  /** 完整的 chat/completions 地址 */
  endpoint: string;
  /** 识图模型名；**null = 这家看不了图**，识物入口据此隐藏 */
  visionModel: string | null;
  /** 问答模型名，作为默认值填进输入框 */
  chatModel: string;
  /** 是否官方免费档。界面据此决定要不要写「免费」两个字 */
  free: boolean;
}

export const AI_PROVIDERS: readonly AiProviderDef[] = [
  {
    key: 'zhipu',
    name: '智谱 BigModel',
    keyUrl: 'https://bigmodel.cn',
    signupNote: '手机号注册即可。GLM-4.6V / 4.7-Flash 免费，但同一时刻只允许一条请求',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    visionModel: 'glm-4.6v-flash',
    chatModel: 'glm-4.7-flash',
    free: true,
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com',
    signupNote: '要充值才能用。识图与问答都用 deepseek-flash（V4-Pro 看不了图）',
    endpoint: 'https://api.deepseek.com/chat/completions',
    /*
     * ★★ 这一格纠过两次，值得留着：
     *
     * 2026-08 之前 DeepSeek 确实只有纯文本模型，所以这里原本写的是 null。
     * 后来官方上了 V4.1-Flash 并给了视觉能力（功能表里 Vision 一栏是 ✓），
     * 而 deepseek-v4-pro 仍然是「Not supported」。
     *
     * 同时踩到第二个坑：**模型名本身也会退役**。
     * `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 现在都只是
     * 「仍被接受」的旧名 —— 请求会被路由到 V4.1-Flash 并按 Flash 计价，
     * 但官方现名是 `deepseek-flash`。写旧名能跑，却是在赌它哪天不再被接受。
     *
     * 所以：识图与问答都用 `deepseek-flash` 这一个名字 ——
     * 官方文档里它是同一个模型，同时具备文本与视觉能力。
     */
    visionModel: 'deepseek-flash',
    chatModel: 'deepseek-flash',
    free: false,
  },
  {
    key: 'moonshot',
    name: '月之暗面 Kimi',
    keyUrl: 'https://platform.moonshot.cn',
    signupNote: '新账号送一点额度，之后要充值。识图走 vision-preview 系列',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    visionModel: 'moonshot-v1-8k-vision-preview',
    chatModel: 'kimi-k2-0905-preview',
    free: false,
  },
  {
    key: 'custom',
    name: '自定义（任意 OpenAI 兼容端点）',
    keyUrl: '',
    signupNote: '中转站、自建服务、国外模型都走这里。填完整地址，结尾到 /chat/completions',
    endpoint: '',
    visionModel: '',
    chatModel: '',
    free: false,
  },
] as const;

/** 找不到时的兜底 —— 一定是「永远可用」的那家，不能是空表 */
export const DEFAULT_PROVIDER_KEY = 'zhipu';

export function findProvider(key: string): AiProviderDef {
  return AI_PROVIDERS.find((p) => p.key === key) ?? AI_PROVIDERS[0];
}

/**
 * 各家在界面上展示用的「模型清单」，以及——
 * 每个月最多能花多少钱，用于 `estimateMonthlyCost` 折算。
 *
 * ★ 这里的价格是**每百万 token 的美元单价**，只用于给用户一个数量级感知。
 *   价格会变，而且各家还有峰谷价、缓存价，所以界面上永远写「≈」。
 *   免费档记 0 —— 那是唯一能确定的事。
 */
export interface AiModelDef {
  /** 请求体里 model 字段用的名称 */
  id: string;
  /** 界面上展示的名称 */
  label: string;
  /** 是否官方免费档。界面据此决定要不要写「免费」这两个字 */
  free: boolean;
  /** 每百万输出 token 的美元价，用于估个数量级 */
  usdPerMillionOut?: number;
}

/** 识图：GLM-4.6V-Flash，官方免费 */
export const AI_VISION_MODEL: AiModelDef = {
  id: 'glm-4.6v-flash',
  label: 'GLM-4.6V-Flash',
  free: true,
};

/** 问答：GLM-4.7-Flash，官方免费，200K 上下文对「把库摘要塞进去」绰绰有余 */
export const AI_CHAT_MODEL: AiModelDef = {
  id: 'glm-4.7-flash',
  label: 'GLM-4.7-Flash',
  free: true,
};

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
const META_PROVIDER = 'ai.provider';
/** 自定义那家只需要存端点；模型名走下面的通用覆盖槽位 */
const META_CUSTOM_ENDPOINT = 'ai.custom.endpoint';
/** 上一版把自定义的两个模型名存在这两个键上，**只在 hydrate 时读一次做迁移** */
const META_LEGACY_CUSTOM_VISION = 'ai.custom.vision';
const META_LEGACY_CUSTOM_CHAT = 'ai.custom.chat';

export type AiModelKind = 'vision' | 'chat';

/**
 * Key 按供应商分开存：`ai.key.<providerKey>`。
 *
 * ★ 不共用一个槽位：换了供应商再换回来，Key 不该丢。
 * ★ `ai.key`（无后缀）是上一版的槽位，**升级时迁到智谱名下** ——
 *   直接改成带后缀会让所有老用户一觉醒来「没配 Key」，
 *   而界面上只会显示「还没填 API Key」，完全看不出是迁移漏了。
 */
const keySlot = (providerKey: string) => `${META_KEY}.${providerKey}`;

/**
 * 模型名按「供应商 + 用途」存：`ai.model.<providerKey>.<vision|chat>`。
 *
 * ★★ 为什么对**所有**供应商开放，而不只是「自定义」那家：
 *   官方下线模型名是常事 —— DeepSeek 的 `deepseek-chat` / `deepseek-reasoner`
 *   用了整整一年，2026-07-24 被直接下线，请求当场失败。
 *   写死在表里的名字，早晚有一天会让用户撞上一句莫名其妙的报错，
 *   而那时未必有人来改这张表。让用户能自己填，比每次发版跟着改可靠。
 *
 * 空串＝用这家预置的默认名（清空输入框即恢复默认）。
 */
const modelSlot = (providerKey: string, kind: AiModelKind) => `ai.model.${providerKey}.${kind}`;

interface ModelOverride {
  vision: string;
  chat: string;
}

let runtimeKey: string | null = null;
let runtimeEnabled: boolean | null = null;
let runtimeProvider: string | null = null;
let runtimeEndpoint: string | null = null;
let runtimeModels: Record<string, ModelOverride> = {};
let hydrated = false;

/** 启动时调一次，把用户存过的 Key / 开关 / 用量 / 供应商 / 模型名读进内存 */
export async function hydrateAi(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const { getDatabase, readMeta } = await import('../db');
    const db = await getDatabase();
    const [legacyKey, enabled, provider, endpoint, legacyVision, legacyChat] = await Promise.all([
      readMeta(db, META_KEY),
      readMeta(db, META_ENABLED),
      readMeta(db, META_PROVIDER),
      readMeta(db, META_CUSTOM_ENDPOINT),
      readMeta(db, META_LEGACY_CUSTOM_VISION),
      readMeta(db, META_LEGACY_CUSTOM_CHAT),
    ]);

    if (enabled != null) runtimeEnabled = enabled === '1';
    if (provider) runtimeProvider = provider;
    runtimeEndpoint = endpoint ?? null;

    /* 模型覆盖：每家两个槽位。本地 meta 读，一次并发读完 */
    const overrides: Record<string, ModelOverride> = {};
    await Promise.all(
      AI_PROVIDERS.flatMap((p) =>
        (['vision', 'chat'] as const).map(async (kind) => {
          const value = await readMeta(db, modelSlot(p.key, kind));
          if (value) {
            overrides[p.key] = { ...(overrides[p.key] ?? { vision: '', chat: '' }), [kind]: value };
          }
        }),
      ),
    );

    /* 上一版自定义那家的模型名存在 ai.custom.*，迁到通用槽位（只补空缺） */
    const custom = overrides.custom ?? { vision: '', chat: '' };
    overrides.custom = {
      vision: custom.vision || (legacyVision ?? ''),
      chat: custom.chat || (legacyChat ?? ''),
    };
    runtimeModels = overrides;

    /* 老 Key 槽位迁移：先读新的，没有才看老的 */
    const active = runtimeProvider ?? DEFAULT_PROVIDER_KEY;
    const saved = (await readMeta(db, keySlot(active))) ?? (active === DEFAULT_PROVIDER_KEY ? legacyKey : null);
    if (saved) runtimeKey = saved;
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
    const slot = keySlot(activeProviderKey());
    await writeMeta(db, slot, trimmed);
    /* 老槽位一起清掉，免得下次启动又从老的读回来 */
    if (slot !== META_KEY) await writeMeta(db, META_KEY, '');
  } catch {
    // 写不进去就只在本次会话生效，界面会照实提示
  }
}

/* ---------------------------------------------------------- 供应商与模型解析 */

/** 当前选中的供应商标识。没选过时用默认那家 */
export function activeProviderKey(): string {
  return runtimeProvider ?? DEFAULT_PROVIDER_KEY;
}

/** 当前选中的供应商配置 */
export function activeProvider(): AiProviderDef {
  return findProvider(activeProviderKey());
}

/**
 * 切换供应商。
 *
 * ★ 换供应商时**顺手把 runtimeKey 换成那一家的** —— 不换的话，
 *   用户切到 DeepSeek 却还在用智谱的 Key，服务端回 401，
 *   而界面上 Key 那一行显示得好好的（它有内容），排查会非常绕。
 */
export async function saveAiProvider(key: string): Promise<void> {
  runtimeProvider = key;
  hydrated = true;
  runtimeKey = null;
  try {
    const { getDatabase, readMeta, writeMeta } = await import('../db');
    const db = await getDatabase();
    await writeMeta(db, META_PROVIDER, key);
    const saved = await readMeta(db, keySlot(key));
    if (saved) runtimeKey = saved;
  } catch {
    // 同上：写不进去只影响下次启动
  }
}

/** 自定义端点三件套的当前值。模型名两项是通用覆盖槽位在 custom 这一格上的值 */
export function customEndpointSettings(): { endpoint: string; vision: string; chat: string } {
  return {
    endpoint: runtimeEndpoint ?? '',
    vision: modelOverride('custom', 'vision'),
    chat: modelOverride('custom', 'chat'),
  };
}

/** 写入自定义端点。三项一次写全，免得出现半套配置 */
export async function saveCustomEndpoint(
  patch: Partial<{ endpoint: string; vision: string; chat: string }>,
): Promise<void> {
  if (patch.endpoint !== undefined) {
    const value = patch.endpoint.trim();
    runtimeEndpoint = value;
    hydrated = true;
    try {
      const { getDatabase, writeMeta } = await import('../db');
      const db = await getDatabase();
      await writeMeta(db, META_CUSTOM_ENDPOINT, value);
    } catch {
      // 同上
    }
  }
  if (patch.vision !== undefined) await saveAiModel('vision', patch.vision, 'custom');
  if (patch.chat !== undefined) await saveAiModel('chat', patch.chat, 'custom');
}

/* ---------------------------------------------------------- 模型名的读写 */

/** 某家某个槽位上的覆盖值；空串＝没覆盖过 */
export function modelOverride(providerKey: string, kind: AiModelKind): string {
  return (runtimeModels[providerKey] ?? { vision: '', chat: '' })[kind];
}

/** 当前生效的端点是用户填的，还是这家预置的 */
export function endpointUrl(): string {
  const p = activeProvider();
  if (p.key !== 'custom') return p.endpoint;
  return (runtimeEndpoint ?? '').trim();
}

/** 这家预置的默认模型名。界面拿它当输入框的 placeholder 与「默认」提示 */
export function defaultModelName(kind: AiModelKind): string {
  const p = activeProvider();
  return kind === 'vision' ? (p.visionModel ?? '') : p.chatModel;
}

/** 当前这家这个槽位有没有被用户改过。界面据此显示「已自定义」 */
export function hasModelOverride(kind: AiModelKind): boolean {
  return modelOverride(activeProviderKey(), kind).length > 0;
}

/**
 * 写入某个模型名。空串＝清除覆盖、回到这家预置的默认名。
 *
 * `providerKey` 默认取当前这家；自定义端点那边显式传 'custom'。
 */
export async function saveAiModel(
  kind: AiModelKind,
  value: string,
  providerKey: string = activeProviderKey(),
): Promise<void> {
  const trimmed = value.trim();
  const current = runtimeModels[providerKey] ?? { vision: '', chat: '' };
  runtimeModels = { ...runtimeModels, [providerKey]: { ...current, [kind]: trimmed } };
  hydrated = true;
  try {
    const { getDatabase, writeMeta } = await import('../db');
    const db = await getDatabase();
    await writeMeta(db, modelSlot(providerKey, kind), trimmed);
  } catch {
    // 同上：写不进去只影响下次启动
  }
}

/**
 * 当前生效的识图模型名；**空串表示这家（或这个槽位）看不了图**。
 *
 * 界面拿它决定识物入口露不露脸；`askVision` 再兜一道，
 * 免得别处漏判时把请求发出去换个语焉不详的模型侧错误。
 */
export function visionModelName(): string {
  const own = modelOverride(activeProviderKey(), 'vision');
  if (own) return own;
  return activeProvider().visionModel ?? '';
}

/** 当前生效的问答模型名 */
export function chatModelName(): string {
  const own = modelOverride(activeProviderKey(), 'chat');
  if (own) return own;
  return activeProvider().chatModel;
}

/** 这家供应商能不能识图 */
export function providerSupportsVision(): boolean {
  return visionModelName().length > 0;
}

/** 当前生效的 Key：用户填的优先，没填回落编译期（只对智谱有意义） */
export function currentAiKey(): string {
  const own = (runtimeKey ?? '').trim();
  if (own) return own;
  return activeProviderKey() === DEFAULT_PROVIDER_KEY ? ENV_API_KEY.trim() : '';
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
