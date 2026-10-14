package com.gewu.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import com.gewu.app.MainActivity
import kotlin.math.roundToInt

/* ★ 常量放文件顶层、不放进 companion object —— 见 GewuWidgetRender.kt 顶部那段说明：
   `private` 只在声明它的类里可见，而同文件里的**另一个顶层类**看不到它。
   放顶层（文件的 private = 全文件可见）不损失任何封装，却少一类「引用解析失败、
   症状却散布在别处」的编译错误。这一条有测试钉着。 */

/**
 * 点整张卡片时打开的深链。
 *
 * ★ 刻意与长按图标的「待办」快捷方式**用同一个 URI**（`gewu://alerts`）：
 *   那条路已经在真机上验证过能落到提醒页，而桌面这张卡片说的正是同一件事
 *   （待办）。换一个没验证过的新 URI，这里没有任何东西会报错 ——
 *   只会出现「点了没反应」。
 */
private const val TAP_URI = "gewu://alerts"

private const val TAP_REQUEST_CODE = 0

/**
 * 格物 · 桌面小组件的广播接收器
 *
 * 这个类跑在**格物自己的进程**里（只是不在 JS 运行时里），所以能直接用
 * 文件 IO 读那份快照。它要做的只有一件事：把快照摆成 RemoteViews 交给系统。
 *
 * ★★ 什么时候会被叫醒，共四条路 —— 记住「谁在什么时候调它」比记住实现更重要：
 *   ① `onUpdate`        —— 刚被拖到桌面、开机重建、以及系统每 30 分钟的兜底重画
 *   ② `onAppWidgetOptionsChanged` —— 尺寸/位置变了（锁屏旋转、被拉到别的位置）
 *   ③ `MainActivity.onStop` → `refreshAll()` —— **主路径**：用户离开 App 的那一刻
 *   ④ 没有第四条。JS 侧**不会**主动来戳我们 ——
 *      见 `src/components/domain/WidgetSync.tsx` 的说明：那样要为一句话接一整套
 *      原生模块，而模块没接上时的表现和「没写快照」一模一样，反而更难查。
 *
 * ★★ 失败一律吞掉并记日志：桌面那张卡片坏了，不该影响 App 本身的任何操作。
 *   用户能看到的只有「桌面没更新」。
 */
class GewuWidgetProvider : AppWidgetProvider() {

  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    for (id in appWidgetIds) update(context, appWidgetManager, id)
  }

  /**
   * 尺寸或摆放位置变了就重画。
   *
   * ★ 本期只有一份 4×2 布局，不按尺寸换布局，但**仍然要重画**：
   *   卡片位图与角块是按渲染那一刻的密度现画的，换了尺寸不重画的话，
   *   系统会把上一张位图拉伸 —— 圆角会变成椭圆。
   */
  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle?,
  ) {
    update(context, appWidgetManager, appWidgetId)
  }

  companion object {

    /**
     * 把桌面上所有小组件重画一遍。
     *
     * 由 `MainActivity.onStop` 调用 —— 也就是**用户离开 App 的那一瞬间**。
     * 这个时机是刻意的：JS 侧写快照用的是同步文件写入，而 onStop 必然发生在
     * 数据变更（与写盘）之后，所以这里读到的**一定**是新的那一份，
     * 不存在「JS 还没写完、原生已经去读」的竞态。
     *
     * ★ 同步执行、不丢到后台线程：整件事是一读文件 + 建几张小位图 + 一次 binder 调用，
     *   毫秒级。丢到后台换来的那点顺滑，代价是进程一旦被回收这次刷新就没了 ——
     *   而用户要等最多 30 分钟才可能再更新一次。可靠性优先。
     *
     * ★ 没有任何小组件时直接返回：这是绝大多数用户的情况，
     *   不该让他们每次退出 App 都白跑一趟 binder。
     */
    fun refreshAll(context: Context) {
      try {
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(ComponentName(context, GewuWidgetProvider::class.java))
        if (ids.isEmpty()) return
        for (id in ids) update(context, manager, id)
      } catch (e: Exception) {
        Log.w(WIDGET_TAG, "刷新小组件失败（不影响 App 使用）", e)
      }
    }

    private fun update(context: Context, manager: AppWidgetManager, id: Int) {
      try {
        /* ★ 尺寸要先拿：卡身位图是按它现画的（见 GewuWidgetRender.card 的说明） */
        val size = cardSizeOf(context, manager, id)
        val snapshot = readWidgetSnapshot(context)
        val views = GewuWidgetRender.build(context, snapshot, tapIntent(context), size)
        /* ★ 先在本进程里跑一遍所有 action：id 打错、addView 目标不对这类问题
           在构造 RemoteViews 时全都不报错，只在 launcher 侧 apply 时才抛 ——
           那时候既不在我们的日志里，也不影响卡片的「上一次内容」继续显示，
           表现就是「怎么改都不生效」。这一步把那些异常提前到 logcat。 */
        GewuWidgetRender.selfCheck(context, views)
        manager.updateAppWidget(id, views)
      } catch (e: Exception) {
        Log.e(WIDGET_TAG, "更新小组件 $id 失败", e)
      }
    }

    /**
     * 这个 widget 实例当前的尺寸（dp），用来画卡身位图。
     *
     * ★★ 位图按它画、再等比拉伸到真实像素，所以**宽高比是唯一的硬要求** ——
     *    比错了圆角会被拉成椭圆。数值本身差几个 dp 无所谓：圆角只有 24dp，
     *    长度差 5% 在屏幕上根本看不出来。
     * ★★ 四个值全部记进日志（tag `GewuWidget`）：**不同 launcher 给这几个数的
     *    语义并不统一**，桌面效果不对时这几个数是唯一能对账的东西。
     *    真机量到的那组数记在 `.workbuddy/memory/_widget.txt` 里，改这里之前先看它。
     */
    private fun cardSizeOf(context: Context, manager: AppWidgetManager, id: Int): WidgetCardSize {
      val options = manager.getAppWidgetOptions(id)
      val minW = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
      val minH = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)
      val maxW = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH)
      val maxH = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
      Log.i(WIDGET_TAG, "尺寸探测 id=$id minW=$minW minH=$minH maxW=$maxW maxH=$maxH")

      if (minW > 0 && minH > 0) return WidgetCardSize(minW, minH)

      /* 兜底：选项读不到（某些 launcher / 模拟器）就用 info 里的最小尺寸，单位是像素。
         比例可能略偏 —— 但比「没有圆角」好。 */
      val info = manager.getAppWidgetInfo(id)
      val d = context.resources.displayMetrics.density
      val w = ((info?.minWidth ?: 0) / d).roundToInt()
      val h = ((info?.minHeight ?: 0) / d).roundToInt()
      Log.w(WIDGET_TAG, "AppWidgetOptions 没给尺寸，退回 info 的 ${w}x${h}dp")
      /* 与 res/xml/gewu_widget_info.xml 的 maxResizeWidth/Height 对齐 */
      return if (w > 0 && h > 0) WidgetCardSize(w, h) else WidgetCardSize(276, 220)
    }

    private fun tapIntent(context: Context): PendingIntent {
      val intent = Intent(context, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse(TAP_URI)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      return PendingIntent.getActivity(
        context,
        TAP_REQUEST_CODE,
        intent,
        /* ★ FLAG_IMMUTABLE 是 Android 12 起的强制要求（不写会直接崩）；
           UPDATE_CURRENT 让每次重建都用最新的 extras，避免留下上一版的意图 */
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
  }
}
