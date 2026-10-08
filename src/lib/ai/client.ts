/**
 * 格物 · AI 网络层（跑腿的那一半）
 *
 * 职责只有两件：把图压成 ≤1024px 的副本、把消息发出去拿回文本。
 * **不做任何解析** —— 抠 JSON、映射字段、清洗答案全在纯函数模块里，
 * 这样换模型、换供应商都不用动那些规则，而规则也不必为了测试去 mock fetch。
 *
 * ── 三条口径（方案页 §02「铁律」的落地）──────────────────────────
 *
 * 1. **用完即弃**：上传的是压缩副本，原图始终留在手机里；base64 只在内存里过一趟，
 *    不落盘、不留服务器副本。
 * 2. **失败静默**：所有异常收敛成 `AiError`，界面上只给一句人话，
 *    绝不把 HTTP 状态码或堆栈丢给用户。
 * 3. **永不阻塞**：调用方拿到失败一律退回本地规则的结果（语音）或本地检索的事实（问一问）。
 *    AI 是加速器，不是必经之路。
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import {
  AI_CHAT_MODEL,
  AI_ENDPOINT,
  AI_TIMEOUT_MS,
  AI_UPLOAD_MAX_EDGE,
  AI_UPLOAD_QUALITY,
  AI_VISION_MODEL,
  currentAiKey,
} from './config';

export type AiErrorKind =
  /** 还没配 Key */
  | 'no-key'
  /** 连不上、超时、DNS 失败 */
  | 'network'
  /** 服务端回了非 2xx 或响应体不是预期形状 */
  | 'api';

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: AiErrorKind,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/* ------------------------------------------------------------------ 图片 */

/**
 * 把沙盒里的一张图压成长边 ≤1024 的 JPEG base64。
 *
 * 走 `saveAsync({ base64: true })` 而不是「先落盘再读文件」：
 * 那一步会多出一份临时文件和一次完整读盘，而这份副本的**唯一用途**就是发出去、
 * 用完即弃。让它连文件都不产生，是最省事也最不容易留垃圾的做法。
 *
 * ★ 只在长边超限时才缩，绝不放大 —— 与 photos/pipeline.ts 的 resizeAction 同一条规则。
 */
export async function toUploadBase64(uri: string, width: number, height: number): Promise<string> {
  const longEdge = Math.max(width, height);
  let ctx = ImageManipulator.manipulate(uri);
  if (longEdge > AI_UPLOAD_MAX_EDGE) {
    ctx = width >= height ? ctx.resize({ width: AI_UPLOAD_MAX_EDGE }) : ctx.resize({ height: AI_UPLOAD_MAX_EDGE });
  }
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ compress: AI_UPLOAD_QUALITY, format: SaveFormat.JPEG, base64: true });
  if (!out.base64) throw new AiError('图片压缩失败', 'api');
  return out.base64;
}

/* ------------------------------------------------------------------ 请求 */

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface ChatMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/**
 * 发一次 chat/completions。
 *
 * 识图与问答共用它：差别只在 `content` 是字符串还是一段带 image_url 的数组，
 * 而 OpenAI 兼容格式把这两件事统一在同一个字段里。
 */
async function chat(model: string, messages: ChatMessage[]): Promise<string> {
  const key = currentAiKey();
  if (!key) throw new AiError('还没配置 API Key', 'no-key');

  let res: Response;
  try {
    res = await withTimeout(
      fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ model, messages, temperature: 0.2, stream: false }),
      }),
    );
  } catch (err) {
    throw new AiError(
      err instanceof Error && err.name === 'AbortError' ? '等待太久，超时了' : '连不上模型服务',
      'network',
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new AiError('API Key 无效或没有权限，请重新复制一个', 'api');
  }
  if (res.status === 429) {
    throw new AiError('调用太频繁了，等一会儿再试', 'api');
  }
  if (!res.ok) {
    throw new AiError(`模型服务返回了异常状态（${res.status}）`, 'api');
  }

  let payload: ChatResponse;
  try {
    payload = (await res.json()) as ChatResponse;
  } catch {
    throw new AiError('模型返回内容无法解析', 'api');
  }

  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    /* 服务端也可能是 `error` 字段而不是 choices —— 但两句话对用户是同一件事：
       这次没拿到结果。不给状态码，不给英文原文。 */
    throw new AiError('模型没有返回内容', 'api');
  }
  return text;
}

/** 识图：把一段提示词和一张压缩副本发过去 */
export function askVision(userPrompt: string, imageBase64: string): Promise<string> {
  return chat(AI_VISION_MODEL.id, [
    {
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      ],
    },
  ]);
}

/** 文本问答 */
export function askText(system: string, user: string): Promise<string> {
  return chat(AI_CHAT_MODEL.id, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
}

/**
 * 超时。
 * 不用 AbortController + signal：这里要的只是「不等了」，
 * 而 signal 在 Hermes 上对 fetch 的支持要额外确认一次，不值得为一个超时引入不确定性。
 */
function withTimeout(promise: Promise<Response>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    }, AI_TIMEOUT_MS);
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

/* ------------------------------------------------------------------ 自检 */

/**
 * 连通性自检：发一句最省的请求，只为确认「Key 对不对、网通不通」。
 *
 * 设置页的「测试连接」用它。**必须在填完 Key 的当场跑一次** ——
 * 否则用户要等到第一次识别失败时才知道 Key 粘错了，那时他已经站在柜子前了。
 */
export async function pingAi(): Promise<void> {
  await askText('你是一个连通性自检助手。', '只回复两个字：正常');
}

/* ------------------------------------------------------------------ 文案 */

/**
 * 失败态的用户可见文案。集中一处 —— 同一句话只该有一个措辞。
 * 三种失败对用户的动作**完全不同**（去填 Key / 检查网络 / 稍后重试），所以必须分开说。
 */
export function describeAiError(err: unknown): string {
  if (err instanceof AiError) {
    switch (err.kind) {
      case 'no-key':
        return '还没配置 API Key，先到「我的 → AI 助手」填一个';
      case 'network':
        return '联网失败了，检查一下网络后重试';
      default:
        return err.message;
    }
  }
  return 'AI 暂时用不了，稍后再试';
}
