/**
 * 格物 · 检查更新的纯逻辑
 *
 * 为什么要单独拆一层：这个功能的**全部失败模式都是静默的** ——
 * 解析出一份坏清单、把「已是最新」判成「有新版本」、节流算反了导致再也不检查，
 * 三种都不会抛异常、不会红屏，用户只会觉得「这 App 好像从来不提示更新」。
 * 所以这里不 import expo / react-native / db，纯进纯出，交给 tests/update.test.mjs 钉住。
 *
 * 网络、读库、渲染三件事分别在 `check.ts` / `db/update.ts` / `UpdateSheet.tsx`。
 */

/** 官网 `/version.json` 的形状，字段名与方案页 §05 的样例一致 */
export interface UpdateManifest {
  /** 比对基准。必填 —— 缺了就当作坏清单丢掉，宁可这次不提示 */
  versionCode: number;
  /** 只用于展示（"1.6.0"） */
  versionName: string;
  /**
   * 安装包直链（APK，与官网同一台服务器）。弹窗的「去下载」开它，
   * 缺省时退回官网下载页（`DOWNLOAD_URL`）。
   * ★ 2026-10-10 改口径：原定「只作记录、界面跳官网」，理由（先看到更新说明）
   *   已被弹窗自身覆盖；现在它就是主下载路径，必须指向真实存在的文件。
   * ★ 解析层只收 `https://`（见 parseUpdateManifest），http 或花式协议一律丢弃。
   */
  url?: string;
  /** 更新说明，一行一条 */
  notes: string[];
  /** 安装包体积，形如 "48.3 MB"。没有就整行不显示 */
  size?: string;
}

/** 本机版本。versionCode 可能拿不到（见 readLocalVersion 的注释），所以允许 null */
export interface LocalVersion {
  versionName: string;
  versionCode: number | null;
}

export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'failed';

/** 两次检查之间至少隔这么久。冷启动才判断，所以「一天一次」其实就是「一天最多开一次网」 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 清单里最多显示几条说明。
 * 弹窗不是更新日志页：条数一多，两个按钮会被挤到手指够不着的地方，
 * 「以后再说」也就不好点了 —— 那会变相成为强制更新。
 */
export const UPDATE_NOTES_MAX = 4;

/* ------------------------------------------------------------ 解析 */

/**
 * 宽容解析但**严格取舍**：字段能少不能错。
 *
 * 宽容的地方：`versionCode` 写成字符串 `"11"` 也认（手写 JSON 很容易忘引号规则）、
 * 超出 4 条的 notes 截断而不是整份丢掉。
 *
 * 严格的地方：缺 `versionCode`、缺 `versionName`、不是对象 —— 一律返回 null。
 * 这种情况下的正确行为是「当作没查到更新」，而不是猜一个版本号去比 ——
 * 猜错的代价是天天弹一个假的更新提示，比不提示糟得多。
 */
export function parseUpdateManifest(raw: unknown): UpdateManifest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;

  const versionName = typeof src.versionName === 'string' ? src.versionName.trim() : '';
  if (!versionName) return null;

  const versionCode = toPositiveInt(src.versionCode);
  if (versionCode === null) return null;

  const notes = Array.isArray(src.notes)
    ? src.notes
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        .slice(0, UPDATE_NOTES_MAX)
        .map((n) => n.trim())
    : [];

  const rawUrl = typeof src.url === 'string' ? src.url.trim() : '';
  const url = rawUrl.startsWith('https://') ? rawUrl : undefined;

  const rawSize = typeof src.size === 'string' ? src.size.trim() : '';
  const size = rawSize.length > 0 ? rawSize : undefined;

  return { versionCode, versionName, url, notes, size };
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/* ------------------------------------------------------------ 比对 */

/**
 * 版本名逐段数字比较，只作为**兜底**（正常路径比 versionCode）。
 *
 * 段数不等时短的补 0：`1.5` 与 `1.5.0` 视为相同。
 * 遇到非数字段（`1.6.0-beta`）按 0 处理 —— 预发布版本来就不该出现在这份清单里，
 * 但真出现了也不该把整份清单判成无效。
 */
export function compareVersionName(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = toSegment(pa[i]);
    const y = toSegment(pb[i]);
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function toSegment(part: string | undefined): number {
  if (part === undefined) return 0;
  const n = Number.parseInt(part.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 有没有更新的版本。
 *
 * 优先比 versionCode（方案页定的基准）；本机拿不到 versionCode 时才退到版本名比较 ——
 * 只比名字会有 `1.10.0 < 1.9.0` 这类长度陷阱，compareVersionName 逐段比数字正好避开。
 */
export function isNewerVersion(remote: UpdateManifest, local: LocalVersion): boolean {
  if (local.versionCode !== null) return remote.versionCode > local.versionCode;
  return compareVersionName(remote.versionName, local.versionName) > 0;
}

/* ------------------------------------------------------------ 节流与抑制 */

/**
 * 该不该开这一次网。
 *
 * 负数分支是刻意的：用户把系统时钟往回拨（或刷机后时间不对）时
 * `lastCheckAt` 会落在未来，`elapsed` 为负。若只写 `elapsed >= interval`，
 * 这台机器会一直检查不了，直到真实时间追上那个错误的时间戳 —— 一个不会自我恢复的死锁。
 */
export function shouldCheckNow(
  lastCheckAt: number | null,
  now: number,
  intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheckAt === null || !Number.isFinite(lastCheckAt)) return true;
  const elapsed = now - lastCheckAt;
  return elapsed < 0 || elapsed >= intervalMs;
}

/**
 * 「以后再说」只对**那一个版本**有效。
 *
 * 没有这条的话，用户不打算更新时每天冷启动都要关一次弹窗 ——
 * 那就成了事实上的强制更新，而方案页明确写的是非强制。
 * 下一个版本号更大，自然会重新弹。
 */
export function shouldPrompt(remote: UpdateManifest, suppressedVersionCode: number | null): boolean {
  if (suppressedVersionCode === null || !Number.isFinite(suppressedVersionCode)) return true;
  return remote.versionCode > suppressedVersionCode;
}

/** meta 里存的是字符串，读出来要能安全地当数字用 */
export function readTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 同上，用于 `update.dismissedVersionCode` */
export function readVersionCode(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/* ------------------------------------------------------------ 文案 */

/** 弹窗副标题：`1.5.0 → 1.6.0 · 48.3 MB`，没有体积就省掉后半段 */
export function formatVersionChange(local: LocalVersion, remote: UpdateManifest): string {
  const head = `${local.versionName} → ${remote.versionName}`;
  return remote.size ? `${head} · ${remote.size}` : head;
}

/**
 * 设置页那一行的右侧文案。
 *
 * 三态口径：`failed` 只在**手动**检查失败时出现 ——
 * 自动检查失败必须连文案都不改，方案页的要求是「请求失败一律静默」，
 * 用户没问的时候不该看到任何网络相关的话。
 */
export function updateStatusText(status: UpdateStatus, local: LocalVersion): string {
  switch (status) {
    case 'checking':
      return '检查中…';
    case 'latest':
      return `已是最新 · ${local.versionName}`;
    case 'available':
      return '有新版本';
    case 'failed':
      return '暂时连不上官网';
    case 'idle':
      /* 还没查过 / 这次冷启动被节流跳过了。写「点击检查」而不是「—」：
         一个空状态行等于把入口藏起来，用户不会想到它其实是可以点的 */
      return '点击检查';
  }
}
