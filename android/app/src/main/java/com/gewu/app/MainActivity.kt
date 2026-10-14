package com.gewu.app
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import com.gewu.app.widget.GewuWidgetProvider

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    // setTheme(R.style.AppTheme);
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    super.onCreate(null)
  }

  /**
   * 离开前台时把桌面小组件刷一遍。
   *
   * ★★ 为什么挂在 onStop 上，而不是让 JS 在数据变的时候主动去戳：
   *   桌面小组件要显示的是「当前的数据」+ 一个**诚实的时间戳**。刷新时机只有两个
   *   合理的选择 —— 要么每次写数据都去戳一次系统（那需要为一句话接一整套
   *   原生模块，而模块哪次没接上，表现和「没写快照」一模一样，反而更难查），
   *   要么挑一个「用户马上就要看到桌面的时刻」。onStop 正是后者：
   *   用户从格物回到桌面，下一步就是看那枚卡片。
   *
   * ★★ 顺序上也安全：JS 侧写快照用的是**同步**文件写入
   *   （`expo-file-system` 的 File.write，见 lib/widget/publish.ts），
   *   而 onStop 必然晚于任何一次数据变更，所以这里读到的不会是一份半成品。
   *
   * ★ 没有装小组件时这个调用会自己立刻返回（一次 binder 查询），
   *   所以对绝大多数用户它等于不存在。
   */
  override fun onStop() {
    super.onStop()
    GewuWidgetProvider.refreshAll(this)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
