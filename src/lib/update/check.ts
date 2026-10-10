/**
 * 格物 · 检查更新（跑腿的那一半）
 *
 * 职责：读本机版本 → 决定要不要开网 → 按 主源 / 备用源 顺序拉清单 → 比出结论。
 * 判定规则全在 `policy.ts`，这里只负责把「时钟、网络、库」三样东西搬到位。
 *
 * 四条口径（方案页 §05、§07 + 2026-10-11 加的总开关）：
 *   1. **失败静默**。更新检查失败不是用户需要知道的事，自动路径连设置页那行文案都不改。
 *   2. **不强制**。拿到新版本也只是给一个可以关掉的弹窗，不做倒计时、不挡返回。
 *   3. **只发一个版本号**。请求里没有任何标识信息 —— 不带设备 id、不带安装 id、
 *      不发 POST。整个请求就是一句 `GET /version.json`。
 *   4. **可关闭**。用户可以彻底关掉自动检查（`update.autoCheck`）。
 *      ★ 关的只是「自动」：手动入口永远可点，否则用户关了之后想更新都找不到路。
 */

import Constants from 'expo-constants';

import { VERSION_URLS } from '@/constants/site';
import { readUpdateState, writeLastCheckAt, type UpdateState } from '@/lib/db/update';
import {
  decideCheck,
  isNewerVersion,
  parseUpdateManifest,
  shouldPrompt,
  type LocalVersion,
  type UpdateManifest,
} from './policy';

/** 单次请求上限。本地优先工具不该为了查更新把 App 卡住，超时就当没查到 */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * 本机版本。
 *
 * `versionCode` 允许拿不到 —— 它来自 `expoConfig.android`，在少数构建形态下这个段可能是空的。
 * 拿不到就退到比版本名（见 policy 的 isNewerVersion），**不在这里补一个假的数字**：
 * 补错了会变成「永远提示有新版本」或者「永远提示已是最新」，两种都很难被发现。
 */
export function readLocalVersion(): LocalVersion {
  const cfg = Constants.expoConfig;
  const rawCode: unknown = cfg?.android?.versionCode;
  return {
    versionName: cfg?.version ?? '—',
    versionCode: typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode > 0 ? rawCode : null,
  };
}

export type CheckOutcome =
  /** 用户关掉了自动检查，这次连网都没开。**手动路径永远不会走到这里** */
  | { kind: 'disabled' }
  /** 当天已经查过了，这次连网都没开 */
  | { kind: 'throttled' }
  /** 查到了，但没有更新的版本 */
  | { kind: 'latest'; local: LocalVersion }
  /** 所有源都没给出合法清单（断网、官网挂了、清单写坏了） */
  | { kind: 'failed'; local: LocalVersion }
  | {
      kind: 'available';
      manifest: UpdateManifest;
      local: LocalVersion;
      /**
       * 用户点过「以后再说」的那个版本正是它。
       * **状态照实显示**（设置页那行仍写「有新版本」），只是不再主动弹窗 ——
       * 把状态也一起藏起来的话，用户想更新时会找不到入口。
       */
      suppressed: boolean;
    };

/**
 * 查一次更新。
 *
 * `manual` 只影响两件事：绕过 24h 节流与**自动检查总开关**，以及允许把失败写进界面状态。
 * 它**不影响**节流窗口的写法 —— 手动查过也照样把时间戳刷新，
 * 否则连点两次就等于是绕开了节流，等于没有节流。
 *
 * 「要不要走」这一步整个交给 policy 的 decideCheck（纯函数，被测试钉住）：
 * 这里只负责把「时钟、库、网络」三样东西搬到位，自己不再写一遍判断 ——
 * 否则总开关很容易在某个分支里被绕开，而且不报错。
 */
export async function checkForUpdate(options: { manual?: boolean } = {}): Promise<CheckOutcome> {
  const manual = options.manual === true;
  const local = readLocalVersion();
  const now = Date.now();

  const state: UpdateState = await readUpdateState();
  const decision = decideCheck({
    manual,
    autoCheck: state.autoCheck,
    lastCheckAt: state.lastCheckAt,
    now,
  });
  /* 关着 / 被节流都在这里收口，且**都不写时间戳** ——
     没开网就没开网，不该占掉当天的名额 */
  if (decision === 'disabled') return { kind: 'disabled' };
  if (decision === 'throttled') return { kind: 'throttled' };

  const manifest = await fetchFromAnySource();
  await writeLastCheckAt(now).catch(() => {
    // 写不进去只是下次启动会白查一遍，不值得打断这次结果
  });

  if (!manifest) return { kind: 'failed', local };
  if (!isNewerVersion(manifest, local)) return { kind: 'latest', local };

  return { kind: 'available', manifest, local, suppressed: !shouldPrompt(manifest, state.dismissedVersionCode) };
}

/** 按 VERSION_URLS 的顺序试，第一个给出合法清单的胜出 */
async function fetchFromAnySource(): Promise<UpdateManifest | null> {
  for (const url of VERSION_URLS) {
    const manifest = await fetchManifest(url);
    if (manifest) return manifest;
  }
  return null;
}

async function fetchManifest(url: string): Promise<UpdateManifest | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return parseUpdateManifest(await response.json());
  } catch {
    // 断网、超时、DNS 失败、返回的不是 JSON —— 全部一视同仁：这次当没查到
    return null;
  } finally {
    clearTimeout(timer);
  }
}
