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

/**
 * 激活码的获取路径：**去爱发电支持，或者加作者微信**。
 *
 * ★ 二维码的载荷是个 `u.wechat.com` 加好友链接（见 `lib/contact.ts`），
 *    所以文案**不必也不该印出微信号**：微信号会变，而这句话会跟着 APK 发出去；
 *    二维码就在「我的 → 联系我」里，扫码/长按识别都行。
 * ★★ **写在这一处，别在四个页面各写一句** —— `AFDIAN_URL` 已经踩过这个坑：
 *    同一个地址散在几处，改的时候必然漏掉一处，而且不报错。
 * ★ 2026-10-11 两次改动：
 *   ① 删掉原来的「长句版」（`WECHAT_LICENSE_LEAD`）—— 那一页的标题已经写着
 *      「加我微信获取激活码」、二维码就在正下方，再铺一段是啰嗦。
 *   ② 措辞从「爱发电渠道还没走通：…」改成「去爱发电支持或者加我微信获取激活码」。
 *      ★★ 但这一句现在有个前提还没满足：**App 里 `AFDIAN_URL` 是空串**，
 *        也就是「去爱发电支持」这一半暂时点不到地方去（官网那边有创作者主页，是通的）。
 *        两条路：把商品页地址填上；或者把这里退回条件文案（有商品页才提爱发电）。
 */

/** 一句话版：塞在门控浮层、状态页脚注这类没地方铺开的地方 */
export const WECHAT_LICENSE_SHORT = '去爱发电支持或者加我微信获取激活码（二维码在「我的」页的「联系我」里）。';
