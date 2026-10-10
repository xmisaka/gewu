/**
 * 格物 · 对外地址
 *
 * 集中一处：同一个地址在几个页面里各写一遍，改的时候必然漏掉一处。
 * 这些会被打进 APK，改一次要发一次新版 —— 所以宁可留空让入口自己消失，
 * 也不填一个猜的地址：一个点开是 404 的「去支持」按钮，比暂时看不到入口更伤信任。
 */

/** 官网（下载页 + 更新说明）。App 内「检查更新」读的也是这个域名。 */
export const SITE_URL = 'https://gewu.zhouzhou.online';

/** 官网上的版本清单，「检查更新」读它 —— 这是主源 */
export const VERSION_URL = `${SITE_URL}/version.json`;

/**
 * 备用源：仓库里同一份 `docs/version.json` 的 raw 地址。
 *
 * 主源只在一种情况下不可达 —— 官网挂了、域名解析出问题、或服务器到期忘了续。
 * 那时这个 raw 地址还能把「有个新版本」这件事告诉用户，成本是一次失败的请求。
 * 同一个文件放两个地方，是为了让「官网挂了」不等于「更新检查功能废了」。
 *
 * raw.githubusercontent.com 在国内时不通常，所以它**只是第二手**：
 * 先试主源，主源给出合法清单就不再打第二个。
 */
export const VERSION_FALLBACK_URL = `https://raw.githubusercontent.com/xmisaka/gewu/main/docs/version.json`;

/**
 * 检查更新依次尝试的源。加镜像就往这里追加一行 —— 顺序即优先级。
 * 一个能解析出合法清单就停，不做「多源取最新」：两个源给出的版本不一致时，
 * 该修的是发布流程，不是在客户端猜哪个更可信。
 */
export const VERSION_URLS: readonly string[] = [VERSION_URL, VERSION_FALLBACK_URL];

/**
 * 官网地址 + 换肤参数：官网的换肤器认 `?skin=<key>`，
 * key 与 `theme.ts` 的主题键同名（sujian / dianqing / … / xuanye）。
 * 调用处用 `getActiveThemeKey()` 取**当前生效**的那套传进来 ——
 * 系统深色时传「xuanye」，官网就会跟着换成深色。
 *
 * 这个函数刻意不带 import：本文件被 `tests/update.test.mjs` 直接
 * import，必须保持零依赖（换肤参数在调用处拼，不在这里读主题）。
 */
export function siteUrlWithSkin(skin: string, anchor = ''): string {
  return `${SITE_URL}/?skin=${encodeURIComponent(skin)}${anchor}`;
}

/**
 * 爱发电商品页（支持者档 ¥36）。
 *
 * **留空 = 还没上架** → 界面隐藏「去爱发电支持」入口，只保留「我已有激活码」，
 * 不会出现一个点了没反应的按钮。上架后把商品页地址填进来即可。
 */
export const AFDIAN_URL = '';
