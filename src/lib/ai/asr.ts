/**
 * 格物 · 语音识别（系统识别器通道）
 *
 * ── 为什么不用 expo-speech-recognition ──────────────────────────
 * 那个库要在 App 里申请 RECORD_AUDIO，而本工程的
 * `android/app/src/main/AndroidManifest.xml` 里这条权限是被**主动移除**的
 * （`tools:node="remove"`），加回来意味着每个装包的人都会多看到一个麦克风权限。
 *
 * 走系统识别对话框则不需要：录音发生在**识别器 App** 里，
 * 格物自始至终没有碰过麦克风，权限清单一个字节都不变。
 *
 * ── 代价（知情取舍，不是没想到）────────────────────────────────
 *   1. 识别时会离开本 App，观感是系统弹层，而不是 05 屏里那条波形；
 *   2. 拿不到 partial results，只有最终文本；
 *   3. 设备上没有识别器（部分定制 ROM 会裁掉）时不可用 ——
 *      这时返回 unsupported，由界面给出「改用手动录入」的出口。
 *
 * ── 边界 ──────────────────────────────────────────────────────
 * 本模块只做「一句话 → 一段文本」，**不做任何解析**：
 * 结构化预填交给 lib/ai/voice-parse.ts（纯函数、可测）。
 * 这样换识别后端（将来若要波形，换成 expo-speech-recognition）时，
 * 解析层与界面一行都不用动。
 */

import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';

/** android.speech.action.RECOGNIZE_SPEECH */
const ACTION_RECOGNIZE_SPEECH = 'android.speech.action.RECOGNIZE_SPEECH';

/* extras 的键名全部来自 android.speech.extra.*，不能改 */
const EXTRA_LANGUAGE_MODEL = 'android.speech.extra.LANGUAGE_MODEL';
const EXTRA_LANGUAGE = 'android.speech.extra.LANGUAGE';
const EXTRA_PROMPT = 'android.speech.extra.PROMPT';
const EXTRA_MAX_RESULTS = 'android.speech.extra.MAX_RESULTS';
const EXTRA_RESULTS = 'android.speech.extra.RESULTS';

/** LANGUAGE_MODEL_FREE_FORM：自由说，而不是网页搜索那种关键词模型 */
const LANGUAGE_MODEL_FREE_FORM = 'free_form';

/** Activity.RESULT_OK */
const RESULT_OK = -1;

export type AsrOutcome =
  | { kind: 'ok'; text: string }
  /** 用户在识别界面按了返回或取消 */
  | { kind: 'canceled' }
  /** 这台设备上没有可用的系统识别器 */
  | { kind: 'unsupported' }
  /** 识别器起来了，但没听清 */
  | { kind: 'nomatch' }
  /**
   * 其它失败。**界面不要显示原始错误**：
   * 用户既看不懂也没法处理，能做的只有重试或改手动录入。
   */
  | { kind: 'failed' };

/** 本功能只有 Android 实现。iOS 上直接走「不支持」那条分支，不留半截入口。 */
export const ASR_AVAILABLE = Platform.OS === 'android';

/**
 * 起一次系统语音识别，等它返回。
 *
 * ★ 调用方必须自己防连点：expo-intent-launcher 原生侧同一时刻只允许
 *   一个待决请求（`pendingPromise` 非空会直接抛 ActivityAlreadyStartedException），
 *   连点两下不会排队，而是第二次直接失败。
 *
 * ★ 整个函数不抛错。所有异常路径都收敛成 AsrOutcome 的一支 ——
 *   语音是一条辅助通道，它坏掉不该打断任何主流程。
 */
export async function listenOnce(prompt = '说出物品、放哪儿、保质期到什么时候'): Promise<AsrOutcome> {
  if (!ASR_AVAILABLE) return { kind: 'unsupported' };

  let result: IntentLauncher.IntentLauncherResult;
  try {
    result = await IntentLauncher.startActivityAsync(ACTION_RECOGNIZE_SPEECH, {
      extra: {
        [EXTRA_LANGUAGE_MODEL]: LANGUAGE_MODEL_FREE_FORM,
        [EXTRA_LANGUAGE]: 'zh-CN',
        [EXTRA_PROMPT]: prompt,
        [EXTRA_MAX_RESULTS]: 1,
      },
    });
  } catch {
    /*
     * 没有 Activity 能处理这个 intent 时，原生侧把 ActivityNotFoundException
     * 打成 rejected promise。这里不区分「没装识别器」与「其它原生错误」——
     * 两者对用户的含义完全相同：这条路走不通，去手动录入。
     */
    return { kind: 'unsupported' };
  }

  if (result.resultCode !== RESULT_OK) return { kind: 'canceled' };

  const text = pickResult(result.extra);
  if (text == null) return { kind: 'canceled' };
  if (!text.trim()) return { kind: 'nomatch' };
  return { kind: 'ok', text: text.trim() };
}

/**
 * 从返回的 extras 里取出识别文本。
 *
 * 系统识别的约定类型是 `ArrayList<String>`，经 expo 的 Bundle→JS 转换后
 * 正常是 `string[]`；但各家识别引擎（Google / 讯飞 / 厂商自研）回来的
 * 类型并不保证一致，所以这里把「字符串数组」与「单个字符串」都认下来。
 *
 * 取不到就返回 null，由上层当成取消处理 —— 这比抛错好：
 * 「没说话」与「识别器没给结果」对用户是同一件事。
 */
function pickResult(extra: unknown): string | null {
  /* 原生侧回的是一个 Bundle，转换后是普通对象；但类型上只保证是 object，
     所以这里自己收窄，而不是把 `as` 撒在上游 */
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[EXTRA_RESULTS];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return first ?? null;
  }
  return null;
}

/**
 * 失败态的用户可见文案。集中放在这里而不是散在界面里 ——
 * 同一句话只该有一个措辞，改的时候不会漏掉某一处。
 */
export function asrMessage(outcome: AsrOutcome): string {
  switch (outcome.kind) {
    case 'unsupported':
      return '这台设备上没有可用的系统语音识别，改用手动录入吧';
    case 'nomatch':
      return '没听清，再说一遍试试';
    case 'failed':
      return '语音识别没有返回结果，重试或手动录入';
    default:
      return '';
  }
}
