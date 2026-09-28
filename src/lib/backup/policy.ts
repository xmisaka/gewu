/**
 * 格物 · 备份策略（纯函数）
 *
 * 从 backup.ts 里拆出来单独放，是因为这两条规则都「差一点就差很多」，
 * 却完全不依赖文件系统与数据库 —— 拆出来才能被单测真正覆盖：
 *   decideAutoBackup     判太松会天天写包，判太紧等于永远不写；
 *   planBackupRetention  多留一份是存储炸弹（一份包就是整个照片库的体积），
 *                        多删一份是不可逆的。
 * 真正的 I/O 留在 backup.ts，这里只出判断。
 */

/* ------------------------------------------------------------ 自动备份时机 */

/**
 * 自动备份间隔。7 天是个折中：更短会让 cache 里的包频繁重写、
 * 每次都要把整个照片库重新打一遍；更长则「数据变更后有个像样的副本」这条就不成立。
 */
export const AUTO_BACKUP_INTERVAL_DAYS = 7;

/** 本机最多留几份备份包 */
export const BACKUP_KEEP_MAX = 3;

/**
 * 本机备份包的总字节上限。
 *
 * 为什么必须有字节预算而不只限份数：一份备份包 ≈ 整个照片库的体积
 * （照片已压缩到长边 1600，几百张就是上百 MB）。只限「留 3 份」，
 * 大数据集下等于在 cache 里堆三个全量副本，低存储的手机直接被打爆。
 * 预算先到就先淘汰，于是小数据集能留满 3 份，大数据集只留得下 1 份。
 */
export const BACKUP_CACHE_BUDGET_BYTES = 400 * 1024 * 1024;

export type AutoBackupDecision = 'no-data' | 'fresh' | 'unchanged' | 'due';

export interface AutoBackupInput {
  /** 物品总数（含回收站）；为 0 时没有可备份的东西 */
  itemCount: number;
  /** 上次**任意一次**备份（手动或自动）的时间戳；从未备份过传 0 */
  lastBackupAt: number;
  /** 上次备份时存下的数据指纹；没有传 null */
  lastFingerprint: string | null;
  /** 当前数据指纹 */
  fingerprint: string;
  now: number;
}

/**
 * 该不该在启动时自动写一份备份包。
 *
 * 判断顺序有意为之：先看有没有数据，再看够不够久，最后才看数据有没有变 ——
 * 「从没备份过」不算「没变化」，那恰恰是最该补一份的时候。
 */
export function decideAutoBackup(input: AutoBackupInput): AutoBackupDecision {
  if (input.itemCount === 0) return 'no-data';

  const interval = AUTO_BACKUP_INTERVAL_DAYS * 86_400_000;
  // 手动备份也算「刚备份过」：用户自己刚存了一份，不该隔天再悄悄写一份出来。
  // 时间戳落在未来（改过系统时间）时差值为负，同样归入 fresh，安全侧。
  if (input.lastBackupAt > 0 && input.now - input.lastBackupAt < interval) return 'fresh';

  if (input.lastBackupAt > 0 && input.lastFingerprint === input.fingerprint) return 'unchanged';

  return 'due';
}

/* ------------------------------------------------------------ 保留策略 */

export interface BackupFileEntry {
  /** 文件名，形如 `格物-备份-20260928-1830.zip` */
  name: string;
  bytes: number;
}

export interface RetentionLimits {
  /** 最多留几份 */
  maxFiles: number;
  /** 总字节上限 */
  maxBytes: number;
}

export interface RetentionPlan {
  keep: BackupFileEntry[];
  remove: BackupFileEntry[];
}

/**
 * 算出该留哪些、该删哪些。**只出计划，不动文件**。
 *
 * 文件名的 `YYYYMMDD-HHmm` 是定长且从高位到低位排的，所以字典序即时间序，
 * 直接倒序拿到的就是「新的在前」，不需要读 mtime。
 */
export function planBackupRetention(files: BackupFileEntry[], limits: RetentionLimits): RetentionPlan {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

  const keep: BackupFileEntry[] = [];
  const remove: BackupFileEntry[] = [];
  let bytes = 0;

  for (const file of sorted) {
    const overCount = keep.length >= limits.maxFiles;
    /* 「至少留一份」不是可选项：单份就超过预算时也留着最新的那份 ——
       否则清理完等于没备份。 */
    const overBudget = keep.length >= 1 && bytes + file.bytes > limits.maxBytes;

    if (overCount || overBudget) {
      remove.push(file);
    } else {
      keep.push(file);
      bytes += file.bytes;
    }
  }

  return { keep, remove };
}

/** 一组备份包的合计信息，供「我的」页显示 */
export function summarizeBackups(files: BackupFileEntry[]): { count: number; bytes: number } {
  return {
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}
