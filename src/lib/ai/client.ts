/**
 * 格物 · AI 网络层（跑腿的那一半）
 *
 * 职责只有一件：把消息发出去、把回来的东西翻译成人话。
 * 图片压缩搬去了 `upload.ts`，错误类型搬去了 `error.ts` —— 后者是因为两个模块同时需要它；
 * 前者是因为 `expo-image-manipulator` 的包入口是 node_modules 里的一个 `.ts`，
 * `--experimental-strip-types` 拒绝加载：只要这里还 import 它，整层逻辑就一条测试都跑不了。
 * （本轮那个「超时没真取消 → 撞并发限流」的 bug，正是从这个缺口里溜过去的。）
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

import {
  AI_CHAT_MODEL,
  AI_ENDPOINT,
  AI_TIMEOUT_MS,
  AI_VISION_MODEL,
  AI_VISION_TIMEOUT_MS,
  currentAiKey,
} from './config';
import { AiError } from './error';

/* 错误类型与文案住在 ./error，这里转出一次，调用方不必改 import 路径 */
export { AiError, describeAiError } from './error';
export type { AiErrorKind } from './error';

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
  /*
   * ★ 超时必须**真的取消请求**，不能只是把自己这边的 await reject 掉。
   *
   * 智谱免费 Flash 系列的限制是「同一时刻只允许 1 条并发请求」。
   * 超时后若不 abort，那条请求仍在服务端排队/推理，而我们这边已经报错、
   * 用户可以立刻重试 —— 第二次就和第一条撞成 2 并发，被直接拒掉（HTTP 429）。
   * 观感就是「刚打开 AI 就嫌我调用太频繁」，可用户其实只点了一两下。
   */
  /*
   * AbortController 在 Hermes / RN 0.60+ 上是现成的全局对象；那句 `typeof` 防御是给
   * 万一的环境 —— 缺了它也不该让整个请求失败，退化成「只是不等了」就行。
   * （这里最早正是因为「不确定 Hermes 支不支持 signal」而没做取消，
   *   结果真机上撞出了并发限流：超时后那条请求仍占着唯一一个并发位。）
   */
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = setTimeout(
    () => controller?.abort(),
    model === AI_VISION_MODEL.id ? AI_VISION_TIMEOUT_MS : AI_TIMEOUT_MS,
  );

  try {
    res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature: 0.2, stream: false }),
      signal: controller?.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new AiError(aborted ? '等了太久还没返回' : '连不上模型服务', aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new AiError('API Key 无效或没有权限，请重新复制一个', 'api');
  }
  if (res.status === 429) {
    /* 免费模型是「同一时刻只允许一条请求」，等一会儿就恢复，不是额度用完了 */
    throw new AiError('免费模型同一时刻只允许一条请求，稍等十几秒再试', 'api');
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

/* 失败态的文案在 ./error 的 `describeAiError`，已在文件顶部转出 */
