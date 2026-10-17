/**
 * 格物 · 清册失败分类（纯逻辑，不 import expo，测试里可直接跑）
 *
 * ★★★ 原生异常**一个字都不能端给用户**。
 *   真机上报出来的是这句：
 *     `Call to function 'FileSystemFile.rename' has been rejected.
 *      → Caused by: java.nio.file.FileAlreadyExistsException: /data/user/0/com.gewu.app/…`
 *   它既说清了原因，也把包名和缓存路径一起泄了，而用户一个字都判断不了。
 *   所以每个失败点只允许向上抛 `InventoryFailure`，`message` 是**一句人话**；
 *   原始异常只进 `cause`，留给日志。
 *
 * ★★ 分类只看**症状**，不看栈。原生错误串在安卓各版本上不统一（`ENOSPC` / `No space left` /
 *   厂商 ROM 自己换的说法都见过），所以这里用一组宽松的正则，匹配不上就退回「这一步没成功」——
 *   宁可文案笼统，也不许把英文栈甩出去。
 */

/** 出事的环节。与 `FAILURE_TEXT` 的键一一对应，便于「哪一步失败 → 在哪一步重试」 */
export type InventoryErrorCode =
  | 'empty'
  | 'layout'
  | 'save'
  | 'nospace'
  | 'share'
  | 'missing'
  | 'noShare';

/** 用户看到的那一句话。写死在这里，界面不拼字符串 */
export const FAILURE_TEXT: Record<InventoryErrorCode, string> = {
  empty: '还没有物品，先录几件再来。',
  layout: '排版这一步没成功。换个样式，或稍后再试一次。',
  save: '文件没能存下来。检查一下手机剩余空间。',
  nospace: '手机存储空间不够了，腾出一点再来。',
  share: '没能把文件交出去。稍后再试一次。',
  missing: '文件被系统清掉了，重新生成一份。',
  noShare: '这台设备没有系统分享。',
};

export class InventoryFailure extends Error {
  readonly code: InventoryErrorCode;
  /** 原始异常，只给日志。★ 不放进 message —— message 是要给用户看的那一句 */
  readonly detail?: unknown;

  constructor(code: InventoryErrorCode, detail?: unknown) {
    super(FAILURE_TEXT[code]);
    this.name = 'InventoryFailure';
    this.code = code;
    this.detail = detail;
  }
}

/* 症状正则。全部按「宁可漏判成通用文案」写，不要写成精确匹配 */
const NO_SPACE = /ENOSPC|No space left|not enough space|空间不足|磁盘已满/i;
const NOT_FOUND = /ENOENT|No such file|does not exist|UnableToOpen|文件不存在/i;
const EXISTS = /FileAlreadyExists|already exists|DestinationAlreadyExists/i;

/** 把任意异常归到某个 code。`stage` 是「当前在做什么」，匹配不上时用它兜底 */
export function classifyFailure(
  stage: Exclude<InventoryErrorCode, 'nospace' | 'missing' | 'noShare'>,
  err: unknown,
): InventoryErrorCode {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (NO_SPACE.test(text)) return 'nospace';
  // 分享时说「文件没了」和生成时说「文件存不下」是两件事，不能共用一句话
  if (NOT_FOUND.test(text)) return stage === 'share' ? 'missing' : 'save';
  if (EXISTS.test(text)) return 'save';
  return stage;
}

/** 统一出口：已经是 `InventoryFailure` 就原样抛，其余按症状归类 */
export function toFailure(
  stage: Exclude<InventoryErrorCode, 'nospace' | 'missing' | 'noShare'>,
  err: unknown,
): InventoryFailure {
  if (err instanceof InventoryFailure) return err;
  return new InventoryFailure(classifyFailure(stage, err), err);
}
