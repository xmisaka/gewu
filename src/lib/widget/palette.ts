/**
 * 格物 · widget 用色的映射
 *
 * 主题令牌（27 个）里 widget 只用得上 10 个。这一层把「全量令牌」收窄成
 * `WidgetColors` —— 收窄这件事必须**显式写出来**，不能靠原生侧自己去猜该取哪几个：
 * 那份 JSON 是唯一交给原生看的东西，缺一个色值，原生只会画成透明，**不报错**。
 *
 * ★ 纯函数，不 import react-native / expo / db。输入是「已经取好的令牌」
 *   （`usePalette()` 的返回值），不是主题上下文 —— 取样与消费分开。
 *
 * ★★ 为什么不干脆在原生侧按主题 id 查表：
 *   那张表会长成第二份 `constants/theme.ts`，而七套主题的色值是会调的
 *   （「玄夜的分隔线比背景亮才看得见」这类修正）。抄一份的代价是：
 *   某天只改了 App 内那一份，桌面上那张卡片还是旧的配色，两边都不报错。
 *   → 令牌只有一个源，就是 `constants/theme.ts`；快照只是把它**搬过去**。
 */

import type { Tokens } from '@/constants/theme';

import type { WidgetColors } from './snapshot';

/**
 * 令牌 → widget 用色。
 *
 * 映射关系（左边是主题令牌，右边是它在卡片上管什么）：
 *   surface  卡片底色
 *   ink      物品名
 *   ink3     位置行、页眉右侧件数
 *   ink4     页脚（时间戳那一档）
 *   line3    卡片内分隔线
 *   brand    页眉左侧标题、页脚右侧「打开格物」
 *   clay/clayBg    砖红族：已过期 / 用完（前景 / 胶囊底）
 *   amber/amberBg  琥珀族：将到期 / 将见底
 *
 * ★ 语义色**不跟着品牌色走**：这是主题设计里的红线（见 `constants/theme.ts`
 *   的准入规则），所以这里直接取语义令牌，不做任何基于 brand 的推导。
 */
export function widgetColorsOf(tokens: Tokens): WidgetColors {
  return {
    surface: tokens.surface,
    ink: tokens.ink,
    ink3: tokens.ink3,
    ink4: tokens.ink4,
    line3: tokens.line3,
    brand: tokens.brand,
    clay: tokens.clay,
    clayBg: tokens.clayBg,
    amber: tokens.amber,
    amberBg: tokens.amberBg,
  };
}
