package com.gewu.app.widget

import android.content.Context
import android.graphics.Color
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Calendar

/**
 * 格物 · 桌面小组件读的那份快照
 *
 * 这是 JS 侧 `src/lib/widget/snapshot.ts` 的**逐字段镜像**。
 * 那边负责「算什么」并落到 `filesDir/widget-snapshot.json`，
 * 这边负责把它读出来，交给 `GewuWidgetRender` 照着摆。
 *
 * ★★ 为什么 provider 能直接读文件、不需要 ContentProvider：
 *   `AppWidgetProvider` 虽然渲染发生在 launcher 侧，但**接收器本身跑在格物自己的进程里**
 *   —— 只是不在 JS 运行时里。所以普通 File IO 就能读到私有目录，
 *   零权限、零跨进程授权。这条是整条链路能这么短的前提。
 *   ★ 文件名与 JS 侧的 `WIDGET_SNAPSHOT_FILE` 必须一致（这里没有共享机制，
 *     两边各写一份字面量 —— 所以那边有一个测试钉着这个值）。
 *
 * ★★ 解析**永不抛**：读不到、被截断、版本对不上，一律返回 null。
 *   widget 侧不能因为一份坏 JSON 就崩掉或画出一块白板 —— 白板看起来
 *   像「应用坏了」，而实际上只是这份文件没写好。null 由渲染层翻成
 *   「还没有数据」那一态，说清楚原因。
 *
 * ★ 校验的粒度与 JS 侧一致：只检查**渲染一定会用到**的字段。
 *   往这里加一条「必须有 nextExpiry」，会把「库里一件带保质期的都没有」
 *   这种完全正常的快照判成坏的 —— 那等于让空库用户的 widget 永远白屏。
 */

/** 日志 tag。排查时 `adb logcat -s GewuWidget` 一条命令捞全 */
internal const val WIDGET_TAG = "GewuWidget"

/** ★ 与 JS 侧 `lib/widget/snapshot.ts` 的 WIDGET_SNAPSHOT_FILE 相同，改一处要两处一起改 */
private const val SNAPSHOT_FILE = "widget-snapshot.json"

/**
 * ★ 与 JS 侧 `WIDGET_SNAPSHOT_VERSION` 相同。对不上就当没有 —— 两侧同版本发布，不做兼容。
 *
 * v1 → v2（2026-10-14，为「长按改尺寸」）：页脚左句从一句变成**按显示行数分档的数组**。
 * 版本号必须一起升，理由见 JS 侧 `snapshot.ts` 同名常量的注释 —— 缩略版：
 * 新代码去读旧 JSON，最好的结果也只是页脚空一格，而那看起来像样式坏了。
 */
private const val SNAPSHOT_VERSION = 2

/** 快照里的一个状态色槽位。**只认这两个**，多出来的按 amber 画（见 toneOf） */
private const val TONE_CLAY = "clay"
private const val TONE_AMBER = "amber"

internal data class WidgetRow(
    val name: String,
    val place: String,
    val statusText: String,
    val tone: String,
)

internal data class WidgetColors(
    val surface: Int,
    val ink: Int,
    val ink3: Int,
    val ink4: Int,
    val line3: Int,
    val brand: Int,
    val clay: Int,
    val clayBg: Int,
    val amber: Int,
    val amberBg: Int,
)

internal data class WidgetSnapshot(
    val generatedAt: Long,
    val countLabel: String,
    /**
     * 正常态页脚左句，**按「实际画了几行」分档**，索引 = 显示行数，值是整句。
     *
     * ★ 两套并列：这里是**两个**「生成时不知道」的维度叠在一起 ——
     *   画了几行 × 生成日是不是今天。渲染层先选一套、再取下标。
     * ★ 为什么不能让这边自己拼「还有 N 件」：RemoteViews 不会拼字符串，
     *   一旦在这边拼，这句话就有了第二份实现，而两份分叉时没有任何提示。
     *   这与 `isStampToday` 是同一个套路，见下面那段注释。
     */
    val footLeftByShownToday: List<String>,
    val footLeftByShownDated: List<String>,
    val emptyLead: String,
    val emptySub: String,
    val emptyNext: String,
    val stampToday: String,
    val stampDated: String,
    val rows: List<WidgetRow>,
    val colors: WidgetColors,
) {
    /**
     * 生成日与此刻是不是同一天。
     *
     * ★★ 这是原生侧**两处判断**中的第一处（另一处是「尺寸 → 行数」，
     *   见 `GewuWidgetRender.rowsThatFit`）。两处的共同点：
     *   **它们在写快照的那一刻根本不可能知道**，所以只能留到这里做。
     *
     * 这一处的理由：快照可能是昨天写的，而 widget 到明天才被系统重画
     *   （周期兜底 30 分钟一次）。若把整句「截至今天 09:12」焊进快照，
     *   那时候它就在说谎 —— 而时间戳存在的**唯一理由**就是把
     *   「这份数据有多旧」暴露出来。
     * 所以两边各准备一个完整版本，这里只做一次同日比较、二选一，
     *   **不拼句子、不格式化日期**（格式化的结果是 JS 给的）。
     */
    fun isStampToday(now: Long): Boolean = isSameDay(generatedAt, now)
}

/**
 * 按「实际画了几行」取页脚左句。
 *
 * ★ 三重兜底，因为这一格**空着比写错更难查**：桌面上少一句话，
 *   看起来像布局坏了，而没人会想到是数组下标越界。
 *   · 下标越界（数据在两次查询之间变动）→ 退到最后一档；
 *   · 数组整个是空的（不该发生，JS 侧解析会拒收）→ 退回空串。
 * ★ 空串也是合法结果：空态那几句走的是别的字段，这条只在正常态用。
 */
internal fun footLeftFor(byShown: List<String>, shown: Int): String {
    if (byShown.isEmpty()) return ""
    return byShown.getOrNull(shown) ?: byShown.last()
}

private fun isSameDay(a: Long, b: Long): Boolean {
    val ca = Calendar.getInstance().apply { timeInMillis = a }
    val cb = Calendar.getInstance().apply { timeInMillis = b }
    return ca.get(Calendar.YEAR) == cb.get(Calendar.YEAR) &&
        ca.get(Calendar.DAY_OF_YEAR) == cb.get(Calendar.DAY_OF_YEAR)
}

/**
 * 读磁盘上的快照。**唯一**的入口，所有异常在这里了结。
 */
internal fun readWidgetSnapshot(context: Context): WidgetSnapshot? {
    return try {
        val file = File(context.filesDir, SNAPSHOT_FILE)
        if (!file.exists()) {
            Log.i(WIDGET_TAG, "还没有快照（$SNAPSHOT_FILE 不存在）—— 按「还没有数据」那一态画")
            return null
        }
        parseWidgetSnapshot(JSONObject(file.readText()))
    } catch (e: Exception) {
        Log.w(WIDGET_TAG, "快照读不出来，按空态画（下次 App 一轮之后会自愈）", e)
        null
    }
}

/**
 * 解析。字段缺失/类型不对一律返回 null —— 与 JS 侧的 `parseWidgetSnapshot` 一一对应。
 */
internal fun parseWidgetSnapshot(o: JSONObject): WidgetSnapshot? {
    if (o.optInt("v", -1) != SNAPSHOT_VERSION) return null

    val colorsJson = o.optJSONObject("colors") ?: return null
    val rowsJson = o.optJSONArray("rows") ?: return null

    val countLabel = o.requiredString("countLabel") ?: return null
    val footLeftByShownToday = o.requiredStringArray("footLeftByShownToday") ?: return null
    val footLeftByShownDated = o.requiredStringArray("footLeftByShownDated") ?: return null
    val emptyLead = o.requiredString("emptyLead") ?: return null
    val emptySub = o.requiredString("emptySub") ?: return null
    val emptyNext = o.requiredString("emptyNext") ?: return null
    val stampToday = o.requiredString("stampToday") ?: return null
    val stampDated = o.requiredString("stampDated") ?: return null

    return WidgetSnapshot(
        generatedAt = o.optLong("generatedAt", 0L),
        countLabel = countLabel,
        footLeftByShownToday = footLeftByShownToday,
        footLeftByShownDated = footLeftByShownDated,
        emptyLead = emptyLead,
        emptySub = emptySub,
        emptyNext = emptyNext,
        stampToday = stampToday,
        stampDated = stampDated,
        rows = rowsJson.toRows(),
        colors = colorsJson.toColors(),
    )
}

/** 一个字符串字段：**存在且是字符串**才算数。空串是合法值（空态那几句就是空串） */
private fun JSONObject.requiredString(key: String): String? {
    if (!has(key)) return null
    val value = opt(key)
    return if (value is String) value else null
}

/**
 * 一个字符串数组字段：存在、是数组、**每一项都是字符串**，才算数。
 *
 * ★ 空数组也**不收**：页脚那一档会取不到，卡片上就少一句话 ——
 *   而「少一句话」看起来像排版坏了，没人会想到是数组是空的。
 *   宁可整份走「还没有快照」那个说得清的提示态。
 * ★ 逐项校验而不是只看长度：`[null]` 会让 setText 收到一个空值，
 *   结果同样是页脚空一格，而且更难查（长度看起来是对的）。
 * ★ 与 JS 侧 `parseWidgetSnapshot` 的校验一一对应，改一处要两处一起改。
 */
private fun JSONObject.requiredStringArray(key: String): List<String>? {
    if (!has(key)) return null
    val arr = optJSONArray(key) ?: return null
    if (arr.length() == 0) return null
    val out = ArrayList<String>(arr.length())
    for (i in 0 until arr.length()) {
        val value = arr.opt(i)
        if (value !is String) return null
        out.add(value)
    }
    return out
}

private fun JSONArray.toRows(): List<WidgetRow> {
    val out = ArrayList<WidgetRow>(length())
    for (i in 0 until length()) {
        val row = optJSONObject(i) ?: return emptyList()
        val name = row.requiredString("name") ?: return emptyList()
        val tone = row.requiredString("tone") ?: return emptyList()
        out.add(
            WidgetRow(
                name = name,
                /* 位置可能为 null（这件东西没登记位置）。渲染层按「有就画、没有就空一行」
                   处理 —— 空串会让那一行塌掉，间距自然收紧，比占一行空白好看 */
                place = row.optString("place", "").takeIf { it != "null" } ?: "",
                statusText = row.requiredString("statusText") ?: return emptyList(),
                tone = tone,
            ),
        )
    }
    return out
}

private fun JSONObject.toColors(): WidgetColors = WidgetColors(
    surface = colorAt("surface"),
    ink = colorAt("ink"),
    ink3 = colorAt("ink3"),
    ink4 = colorAt("ink4"),
    line3 = colorAt("line3"),
    brand = colorAt("brand"),
    clay = colorAt("clay"),
    clayBg = colorAt("clayBg"),
    amber = colorAt("amber"),
    amberBg = colorAt("amberBg"),
)

/**
 * 色值解析。
 *
 * ★ 解析不出来时给**灰色**而不是透明：色值畸形只可能来自 JS 侧被改坏
 *   （theme.ts 里全是 `#RRGGBB` 字面量），真发生时灰色是看得见的告警，
 *   透明则是「整块东西凭空消失」—— 后者会被当成布局问题查半天。
 */
private fun JSONObject.colorAt(key: String): Int {
    val raw = optString(key, "")
    return try {
        Color.parseColor(raw)
    } catch (e: IllegalArgumentException) {
        Log.w(WIDGET_TAG, "色值 $key=\"$raw\" 解析不了，先画成灰色")
        Color.GRAY
    }
}

/** 状态槽位 → 一组具体色值（圆点 / 胶囊文字 / 胶囊底） */
internal data class ToneColors(val dot: Int, val pillFg: Int, val pillBg: Int)

/**
 * ★ 这是一次**查表**，不是一条规则：槽位名是 JS 侧给的
 *   （`'clay' | 'amber'`），色值也在快照里，这里只做配对。
 *   认不出的槽位按「留意」画 —— 比画成透明强，而且与 `TONE_AMBER` 的含义一致。
 */
internal fun WidgetColors.toneOf(tone: String): ToneColors = when (tone) {
    TONE_CLAY -> ToneColors(dot = clay, pillFg = clay, pillBg = clayBg)
    else -> ToneColors(dot = amber, pillFg = amber, pillBg = amberBg)
}

/**
 * 「还没有快照」时用的兜底配色。
 *
 * ★★ 这是全工程**唯一**一处主题色值出现在 `constants/theme.ts` 之外的地方，
 *   而且是不得不如此：兜底态的定义就是「拿不到快照」，而快照才是带着当前主题
 *   色值的那份东西。这一态又必须画得出来 —— 白板会被当成坏了。
 *
 * ★ 取的是**素笺**（默认主题）那套：没有信息表明用户偏好时，用缺省最不意外。
 *
 * ★★ 它不是第二份真相，是**复制品**：`tests/widget-theme-parity.test.mjs`
 *   会把下面这几个值与 `theme.ts` 的素笺逐个比对 —— 改了一边没改另一边会直接报错，
 *   不会让桌面和 App 悄悄分成两个颜色。
 */
internal object WidgetFallbackColors {
    const val SURFACE = "#FFFFFF"
    const val INK = "#2B241F"
    const val INK3 = "#9A8D80"
    const val INK4 = "#C9BEB0"
    const val LINE3 = "#F1ECE4"
    const val BRAND = "#8C5A34"
}

/** 兜底配色装成 `WidgetColors`。语义色用不到（兜底态没有条目行），给中性值即可 */
internal val WIDGET_FALLBACK_COLORS = WidgetColors(
    surface = Color.parseColor(WidgetFallbackColors.SURFACE),
    ink = Color.parseColor(WidgetFallbackColors.INK),
    ink3 = Color.parseColor(WidgetFallbackColors.INK3),
    ink4 = Color.parseColor(WidgetFallbackColors.INK4),
    line3 = Color.parseColor(WidgetFallbackColors.LINE3),
    brand = Color.parseColor(WidgetFallbackColors.BRAND),
    /* 空态不画圆点与胶囊，这两个随便给一个中性灰；真用上了说明有人改了布局 */
    clay = Color.GRAY,
    clayBg = Color.GRAY,
    amber = Color.GRAY,
    amberBg = Color.GRAY,
)
