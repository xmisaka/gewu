/**
 * 格物 · 清册文件命名（纯逻辑，不 import expo，测试里可直接跑）
 *
 * ★★★ 名字必须精确到**秒**。
 *   原来只到分钟（`20261017-2139`）：「同一分钟再点一次」得到同一个名字，
 *   而 `expo-file-system` 的 `rename(newName)` **没有覆盖语义**，撞上就抛
 *   `FileAlreadyExistsException`，用户看到的是「Call to function 'FileSystemFile.rename'
 *   has been rejected → java.nio.file.FileAlreadyExistsException: /data/user/0/…」。
 *   带秒之后碰撞窗口从 60s 缩到 1s；剩下那一格由写盘时的 `move(..., { overwrite: true })`
 *   兜住 —— 两道防线分别管「几乎不会撞」和「撞了也不炸」。
 *
 * ★ 前缀是「认领」用的：清册的文件都落在 `Paths.cache` 根下，下次生成时按这个前缀
 *   把上一轮留下的清掉，否则每点一次就多留一对 PDF + HTML，永不回收
 *   （缓存目录虽然会被系统回收，但不能指望它）。
 */
export const BOOKLET_PREFIX = '格物-家庭财产清册-';

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** `格物-家庭财产清册-20261017-213912`（不含扩展名） */
export function bookletBaseName(now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${BOOKLET_PREFIX}${date}-${time}`;
}

/** cache 里哪些文件是清册留下的：按前缀认，不按时间猜 */
export function isBookletFile(name: string): boolean {
  return name.startsWith(BOOKLET_PREFIX);
}
