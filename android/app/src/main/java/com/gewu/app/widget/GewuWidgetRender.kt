package com.gewu.app.widget

import android.app.PendingIntent
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import com.gewu.app.R
import kotlin.math.ceil
import kotlin.math.roundToInt

/* ---------------------------------------------------------------- 尺寸常量
 *
 * ★★ 这些常量**必须留在文件顶层**，不能挪进下面 `GewuWidgetRender` 的内部：
 *    `Renderer` 是同一个文件里的**另一个顶层类**，而 Kotlin 的 `private`
 *    只在声明它的那个类（及其嵌套类）里可见。放错地方的后果**不是**
 *    「编译不过并指向这一行」，而是对它们的**引用全部解析失败**，再连累出
 *    一串看着毫不相干的报错 —— 参数变成错误类型之后，`Math.round` 会落到
 *    返回 `Long` 的那个重载上，于是整份文件里冒出十几条
 *    「actual type is 'Long', but 'Int' was expected」。
 *    真正的错只有一处，症状却散布在整份文件里。**第一次编译就踩到了这个。**
 *
 * ★ 换算一律走 `roundToInt()` 而不是 `Math.round()`：后者在 JVM 上有
 *   `Int` 与 `Long` 两个重载，选哪个取决于参数是 `Float` 还是 `Double`，
 *   是个随时会咬人的隐式规则。
 */

/** 卡片的圆角半径，与设计稿一致（dp） */
private const val CARD_RADIUS_DP = 24

/** 状态圆点直径（dp） */
private const val DOT_DP = 6

/** 状态胶囊的字号，必须与 `widget_gewu_row.xml` 里 `row_pill` 的 textSize 一致 */
private const val PILL_TEXT_SP = 11f

/** 状态胶囊的圆角半径与内距（dp），同样要与那个布局对齐 */
private const val PILL_RADIUS_DP = 6f
private const val PILL_PAD_H_DP = 7
private const val PILL_PAD_V_DP = 2

/**
 * 一轮更新里位图总字节的预算。
 *
 * Binder 单次事务上限 1MB，而且那个缓冲区是整个进程共享的；
 * 留出余量在 700KB。真撞上了就**退化成直角卡片**继续画 ——
 * 难看一点，但比「这次更新被静默丢掉、桌面停在上一帧」可控得多。
 */
private const val BITMAP_BUDGET_BYTES = 700 * 1024

/* ------------------------------------------------------------ 行数换算
 *
 * ★★★ 卡片现在**可以长按拖动改尺寸**，所以「能画几行」不再是个常量 ——
 *   拉高一行就多画一条待办。这件事只能在原生侧算：
 *   **它在写快照的那一刻根本不存在**（用户此刻把卡片拉到多高，
 *   只有拿到 AppWidgetOptions 才知道），与 `isStampToday` 完全同构。
 *
 * ★ 它是个纯算术，两个输入都能从布局 XML 里现算出来 ——
 *   `tests/widget-theme-parity.test.mjs` 会把下面三个常量与
 *   widget_gewu.xml / widget_gewu_row.xml 对账。改了行高、内边距或字号，
 *   那条测试立刻变红，不会等到桌面上少一行才发现。
 *
 * ★ 算错的表现是**安静**的：多算一行 → 最后一行被裁掉半截；
 *   少算一行 → 卡片下面一大片空白。2026-10-14 用户报的正是后者
 *   （「22 条待办只显示 3 条、下面有很大空白」）—— 当时行数还被
 *   JS 侧的 WIDGET_MAX_ROWS 钉死在 3，尺寸怎么变都没用。
 */

/**
 * 卡片里**与行数无关**的固定开销（dp）≈ 82。
 *
 * 逐项：内边距 14×2 = 28 ＋ 页眉 12sp×1.4 ≈ 17 ＋（分隔线上边距 6 ＋ 1dp = 7）
 *      ＋ 列表上边距 7 ＋ 分隔线 1 ＋（页脚上边距 7 ＋ 页脚 10.5sp×1.4 ≈ 15）
 * 上面这些数字全部由 parity 测试**从布局里解析出来**再相加，此处只是对账目标。
 */
private const val FIXED_OVERHEAD_DP = 82

/** 一行占的高度（dp）= 行高 40 ＋ 行间距 4，两个数都在 widget_gewu_row.xml 里 */
private const val ROW_PITCH_DP = 44

/**
 * 行数上限。
 *
 * ★ 必须与 JS 侧 `WIDGET_MAX_ROWS`（快照里的备货量）一致，由 parity 测试钉住：
 *   这边比那边大 → 拉大之后多出来的行是空白的；小 → 快照白带了数据。
 */
private const val MAX_ROWS_CAPACITY = 8

/**
 * 给定卡片高度（dp），画得下几行。
 *
 * ★★ **至少返回 1**：高度小到放不下任何一行时（有些 launcher 不严格守
 *   minResizeHeight），画一行、被 clipChildren 裁掉一截，
 *   远好过画 0 行 —— 0 行会让列表区整个空着，而**「空列表」在屏幕上
 *   与「空态」长得一模一样**，用户会以为东西丢了。
 *   （真正的空态由 `snapshot.rows.isEmpty()` 决定，与这里无关。）
 * ★ `coerceIn` 不能省掉上界：拉得很高时按除法算出来的可能是十几行，
 *   而快照里只有 8 条备货 —— 多出来的行会画成空白。
 */
private fun rowsThatFit(heightDp: Int): Int {
  val usable = heightDp - FIXED_OVERHEAD_DP
  if (usable < ROW_PITCH_DP) return 1
  return (usable / ROW_PITCH_DP).coerceIn(1, MAX_ROWS_CAPACITY)
}

/**
 * 画卡身位图用的尺寸（单位 dp）。
 *
 * ★ 它只服务**画位图**，与布局的实际尺寸无关：位图按它画好，再由 ImageView 的
 *   fitXY 拉伸到真实像素。所以唯一真正要紧的是**宽高比** ——
 *   比例错了圆角会被拉成椭圆；数值本身差几个 dp 看不出来（圆角只有 24dp）。
 * ★ 由 `GewuWidgetProvider.cardSizeOf` 从 AppWidgetOptions 取，取不到有兜底。
 */
internal data class WidgetCardSize(val widthDp: Int, val heightDp: Int)

/**
 * 格物 · 把一份快照摆成 RemoteViews
 *
 * 这一层的职责被刻意压到最小：**只做「取一个值 → 放到一个 id 上」**。
 * 没有拼接、没有格式化 —— 所有会算错的东西都在 JS 侧的纯函数里
 * （`src/lib/widget/snapshot.ts`，有单测钉着）。这里如果多写一条规则，
 * 它就会在桌面上长出第二份实现，而两份分叉时不会有任何提示。
 *
 * 一共三处例外，各自在下面标注了理由：
 *   · 「生成日是不是今天」—— 快照躺在磁盘上到明天就过期了，不判断反而是在说谎
 *   · 「这个尺寸画得下几行」—— 尺寸是用户长按拖出来的，写快照时无从得知
 *     （见下面 `rowsThatFit`）
 *   · 状态槽位 → 一组色值 —— 那是查表，不是规则
 *
 * ★★ 圆角为什么不能按屏幕密度画整张位图：
 *   位图要过 Binder，单次事务上限 1MB。按真实密度画一张 276×220dp 的
 *   ARGB_8888 圆角图是 2.2MB（三倍屏），**整次更新会被系统静默丢弃** ——
 *   widget 停在上一帧，只有 logcat 里一行，属于最难查的那类失败。
 *   现在的做法是「**按 dp 尺寸**画，1 像素 = 1 dp」再交给 fitXY 拉伸：
 *   276×220 只有 243KB，而且画的宽高比与卡片一致，拉伸是等比的 ——
 *   圆角不会被拉成椭圆。（更早还试过「纯色底 + 四枚 24dp 角块」，
 *   那个方案**根本做不出圆角**，理由写在 res/layout/widget_gewu.xml 顶部。）
 */
internal object GewuWidgetRender {

  fun build(
    context: Context,
    snapshot: WidgetSnapshot?,
    pending: PendingIntent?,
    size: WidgetCardSize,
  ): RemoteViews {
    return Renderer(context, snapshot, pending, size).render()
  }

  /**
   * 在自己进程里把 RemoteViews 真正 inflate 一遍、把所有 action 跑完。
   *
   * ★★ 这一步不是为了显示（显示在 launcher 进程），而是**把静默失败变成日志**：
   *   `setTextViewText(R.id.xxx, ...)` 里的 id 打错了、`addView` 的目标容器
   *   不是 ViewGroup、某个 action 用的方法在这个 View 上不存在 ——
   *   这些在构造 RemoteViews 时**全都不报错**，只在 launcher 侧 apply 的时候抛。
   *   而 launcher 的异常我们既看不到、也不影响 widget 的「上一次内容」继续显示，
   *   于是表现成「怎么改都不生效」。
   *   自己先 apply 一遍，同一类异常会当场落在 logcat 里（tag `GewuWidget`）。
   *
   * 代价是每次刷新多 inflate 一棵二十来个视图的树，约一两毫秒 ——
   * widget 刷新最密也就 30 分钟一次，完全可以接受。
   */
  fun selfCheck(context: Context, views: RemoteViews): Boolean {
    return try {
      views.apply(context, null)
      true
    } catch (e: Exception) {
      Log.e(WIDGET_TAG, "自检失败：布局里的 id 或 action 对不上，桌面上会抛同一类异常", e)
      false
    }
  }
}

/**
 * 一轮渲染。做成一次性的小对象，只为了把「位图用了多少字节」这个累计量
 * 从函数参数里挪出来 —— 它要在建角块之前就知道，用来决定圆角保不保得住。
 */
private class Renderer(
  private val context: Context,
  private val snapshot: WidgetSnapshot?,
  private val pending: PendingIntent?,
  private val size: WidgetCardSize,
) {
  private val density = context.resources.displayMetrics.density
  private val scaledDensity = context.resources.displayMetrics.scaledDensity
  private var bitmapBytes = 0

  fun render(): RemoteViews {
    val colors = snapshot?.colors ?: WIDGET_FALLBACK_COLORS
    val rows = snapshot?.rows.orEmpty()

    /* ★ 顺序要紧：先把行的位图建出来（位图预算才准），再决定卡片要不要上圆角 */
    val views = if (rows.isEmpty()) quiet(colors) else list(colors, snapshot!!)
    card(views, colors)
    return views
  }

  /* ------------------------------------------------------------ 正常态 */

  private fun list(colors: WidgetColors, snap: WidgetSnapshot): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.widget_gewu)

    /* ★★ 判断一：这个尺寸画得下几行（理由见文件顶部那段「行数换算」）。
       ★ `shown` 再与 `rows.size` 取小：用户把卡片拉得很高、
         而库里只有 3 件待办时，不该画出 5 个空行 ——
         那会让页脚那句「还有 0 件」显得莫名其妙。 */
    val fit = rowsThatFit(size.heightDp)
    val shown = minOf(fit, snap.rows.size)

    /* ★★ 判断二：生成日是不是今天。理由见 WidgetSnapshot.isStampToday：
       快照会在磁盘上躺到明天，那时「截至今天」就是假话。
       ★ 页脚那句现在还要先按下标取 —— 它随**实际画了几行**变
         （「还有 N 件」里的 N）。两件事叠在一起，所以先选日期那一套、
         再取行数那一档，全程不拼字符串。 */
    val foot = if (snap.isStampToday(System.currentTimeMillis())) {
      footLeftFor(snap.footLeftByShownToday, shown)
    } else {
      footLeftFor(snap.footLeftByShownDated, shown)
    }

    views.setTextViewText(R.id.widget_count, snap.countLabel)
    views.setTextViewText(R.id.widget_foot_left, foot)
    views.setTextColor(R.id.widget_foot_left, colors.ink4)
    // 页脚右侧那颗「打开格物」的文字来自布局里的 @string，这里只上色
    views.setTextColor(R.id.widget_foot_right, colors.brand)

    /* ★ addView 之前必须 removeAllViews：系统每 30 分钟会重画一次，
       不先清空的话第 4 件之后每一轮都会再叠三行上去，而**不报错** ——
       表现是行越来越密、溢出卡片。
       ★ 卡片可调尺寸之后这一步更要紧：用户拖动的过程中
         `onAppWidgetOptionsChanged` 会被连续触发，每一轮都是一次
         removeAllViews + 重新 addView，少一次就会叠一行。 */
    views.removeAllViews(R.id.widget_rows)
    for (row in snap.rows.take(shown)) {
      views.addView(R.id.widget_rows, rowView(colors, row))
    }

    /* ★ 这一行是排查「桌面只显示 N 条」的第一现场：
       把「尺寸 / 画得下几行 / 实际画了几行 / 快照备了几条」四个数一起打出来，
       一眼能分辨是**尺寸没拿到**、**行数算错了**、还是**快照里就没带够**。
       2026-10-14 那次「22 条只显示 3 条」，靠的就是这四个数。 */
    Log.i(
      WIDGET_TAG,
      "渲染 正常态 尺寸=${size.widthDp}x${size.heightDp}dp" +
        " 行数=$shown（画得下 $fit / 备货 ${snap.rows.size}）" +
        " 计数=\"${snap.countLabel}\" 页脚=\"$foot\" 位图=${bitmapBytes}B",
    )
    return views
  }

  private fun rowView(colors: WidgetColors, row: WidgetRow): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.widget_gewu_row)
    val tone = colors.toneOf(row.tone)

    views.setImageViewBitmap(R.id.row_dot, circle((DOT_DP * density).roundToInt(), tone.dot))

    views.setTextViewText(R.id.row_name, row.name)
    views.setTextColor(R.id.row_name, colors.ink)

    views.setTextViewText(R.id.row_place, row.place)
    views.setTextColor(R.id.row_place, colors.ink3)

    if (row.statusText.isEmpty()) {
      /* 没话说就不画胶囊，但**不隐藏整行** —— 名称与位置照常显示，
         只是右边留白。隐藏整行会让行数变少，而「三行」是这一版的承诺。 */
      views.setViewVisibility(R.id.row_pill_box, View.GONE)
    } else {
      views.setImageViewBitmap(R.id.row_pill_bg, pill(row.statusText, tone.pillBg))
      views.setTextViewText(R.id.row_pill, row.statusText)
      views.setTextColor(R.id.row_pill, tone.pillFg)
    }
    return views
  }

  /* ------------------------------------------- 空态 / 还没有快照 */

  /**
   * 两种「没有东西可列」共用一份布局，只换文案：
   *   · 有快照、库里没待办 → 快照里的那几句（含「下一件」与时间戳）
   *   · 压根没有快照 → strings.xml 里那两句（说清原因，而不是空白）
   */
  private fun quiet(colors: WidgetColors): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.widget_gewu_empty)
    val snap = snapshot

    val lead = snap?.emptyLead ?: context.getString(R.string.widget_gewu_none_lead)
    val sub = snap?.emptySub ?: context.getString(R.string.widget_gewu_none_sub)
    val next = snap?.emptyNext ?: ""
    val stamp = snap?.let {
      if (it.isStampToday(System.currentTimeMillis())) it.stampToday else it.stampDated
    } ?: ""
    val count = snap?.countLabel ?: context.getString(R.string.widget_gewu_none_count)

    views.setTextViewText(R.id.widget_count, count)
    views.setTextViewText(R.id.widget_empty_lead, lead)
    views.setTextViewText(R.id.widget_empty_sub, sub)
    views.setTextViewText(R.id.widget_empty_next, next)
    views.setTextViewText(R.id.widget_stamp, stamp)

    views.setTextColor(R.id.widget_empty_lead, colors.ink)
    views.setTextColor(R.id.widget_empty_sub, colors.ink3)
    views.setTextColor(R.id.widget_empty_next, colors.ink4)
    views.setTextColor(R.id.widget_stamp, colors.ink4)

    Log.i(WIDGET_TAG, "渲染 空态 lead=\"$lead\" sub=\"$sub\" 下一件=\"$next\" 戳=\"$stamp\" 位图=${bitmapBytes}B")
    return views
  }

  /* ------------------------------------------------------------ 卡片外壳 */

  private fun card(views: RemoteViews, colors: WidgetColors) {
    /* ★★★ 卡身（底色 + 圆角）是一张**按 dp 尺寸现画的位图**，交给 ImageView 的
       fitXY 等比拉伸。两个「更自然」的做法都被真机否掉了：
         · 四枚 24dp 角块 —— **盖不住方角**。角块位图在圆弧之外是透明的，
           露出来的正是它底下那块铺满的卡身；真机上四角是实心的白，
           一个像素的圆角都没有。
         · 按屏幕密度画整卡 —— 276×220dp 在三倍屏上是 828×660 像素，
           ARGB_8888 就是 2.2MB，超 Binder 单次事务上限 1MB，
           **整次更新会被静默丢弃**，桌面停在上一帧。
       按 dp 画（1 像素 = 1 dp）之后：276×220 只有 243KB；而且因为画的宽高比
       与卡片一致，拉伸是等比的 —— 圆角不会被拉成椭圆，半径正好 24dp。
       详尽推理写在 res/layout/widget_gewu.xml 顶部。 */
    val cardBytes = size.widthDp * size.heightDp * 4
    if (cardBytes + bitmapBytes <= BITMAP_BUDGET_BYTES) {
      views.setImageViewBitmap(
        R.id.widget_body,
        cardBitmap(size.widthDp, size.heightDp, colors.surface),
      )
    } else {
      /* 退化：直角卡片。难看一点，但比「整次更新被 Binder 丢掉、桌面停在上一帧」可控 */
      Log.w(WIDGET_TAG, "位图预算不足（卡身 ${cardBytes}B + 行 ${bitmapBytes}B），本轮圆角退化成直角")
      views.setInt(R.id.widget_body, "setBackgroundColor", colors.surface)
    }

    // 页眉那句文字来自布局里的 @string，这里只上色
    views.setTextColor(R.id.widget_header, colors.brand)
    views.setTextColor(R.id.widget_count, colors.ink3)
    views.setInt(R.id.widget_rule_top, "setBackgroundColor", colors.line3)
    views.setInt(R.id.widget_rule_bottom, "setBackgroundColor", colors.line3)

    pending?.let { views.setOnClickPendingIntent(R.id.widget_card, it) }
  }

  /* ------------------------------------------------------------ 现画的位图 */

  /**
   * 卡身位图：一张按 dp 尺寸画的纯色圆角矩形。
   *
   * ★ 圆角半径用 `CARD_RADIUS_DP` 的**原始 dp 值**，**不乘 density** ——
   *   这里的坐标系一个像素就是一 dp，密度由 ImageView 的 fitXY 拉伸负责。
   *   乘了 density 半径会变成 24dp × 3.1 ≈ 74dp 的巨圆角，四个角看起来像被啃掉。
   * ★ 抗锯齿开着：圆角边缘会有 1 个源像素的渐变，拉伸 3 倍后糊成 3 个像素 ——
   *   比锯齿好看，也比整张直角卡片好看。
   */
  private fun cardBitmap(wDp: Int, hDp: Int, color: Int): Bitmap {
    val bmp = Bitmap.createBitmap(wDp, hDp, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
    val r = CARD_RADIUS_DP.toFloat()
    canvas.drawRoundRect(RectF(0f, 0f, wDp.toFloat(), hDp.toFloat()), r, r, paint)
    bitmapBytes += wDp * hDp * 4
    return bmp
  }

  private fun circle(sizePx: Int, color: Int): Bitmap {
    val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
    // 留半像素，否则抗锯齿的边缘会被画布裁掉，圆点看起来偏小一圈
    canvas.drawCircle(sizePx / 2f, sizePx / 2f, sizePx / 2f - 0.5f, paint)
    bitmapBytes += sizePx * sizePx * 4
    return bmp
  }

  /**
   * 状态胶囊的底。
   *
   * 宽度必须按**这段文字的实际宽度**现量 —— 胶囊是 `wrap_content`，
   * 给一张固定宽度的底，文字长一点就会从底上溢出来（而文字短一点，
   * 底会被 fitXY 压窄，圆角变成椭圆）。量的字号、内距都要与
   * `widget_gewu_row.xml` 里 `row_pill` 的设定一致，改一处要两处一起改。
   */
  private fun pill(text: String, color: Int): Bitmap {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = PILL_TEXT_SP * scaledDensity }
    val padH = (PILL_PAD_H_DP * density).roundToInt()
    val padV = (PILL_PAD_V_DP * density).roundToInt()
    /* 文本排版结果与 measureText 差一两个像素是常事：多给 4px 余量。
       欠了会在胶囊右端露出一条底色，多了只是被 fitXY 轻微拉伸（看不出来）。 */
    val w = ceil(paint.measureText(text)).toInt() + padH * 2 + 4
    val fm = paint.fontMetrics
    val h = ceil(fm.descent - fm.ascent).toInt() + padV * 2

    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
    canvas.drawRoundRect(RectF(0f, 0f, w.toFloat(), h.toFloat()), PILL_RADIUS_DP * density, PILL_RADIUS_DP * density, fill)
    bitmapBytes += w * h * 4
    return bmp
  }
}
