# 格物 · 收纳柜

记录家里每一件东西，找到它们，并且知道它们值不值。

纯本地运行的 Android App，不联网、不注册、无云端。数据全部存在手机里。

---

## 怎么在手机上跑起来

不需要安装 Android SDK，也不需要连数据线。

1. 手机应用商店搜索 **Expo Go** 并安装（Android / iOS 都有）。
2. 手机和电脑连**同一个 WiFi**（关键：必须在同一网段，否则扫码也连不上）。
3. 在本目录下执行任一种：

   - 双击 `start-dev.cmd`（Windows 一键启动）
   - 或在命令行执行：

     ```bash
     npm start
     ```

4. 终端会显示一个二维码。用手机上的 **Expo Go** 扫码即可打开。
   - Android 版 Expo Go 自带扫码入口
   - 若扫码失败，也可在 Expo Go 里手动输入终端显示的 `exp://<电脑IPv4>:8081`

改代码后手机会自动热更新，不用重新扫码。

### 扫码连不上怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| 一直转圈 / 报 `Timeout` | 手机与电脑不在同一网段 | 查 `ipconfig` 确认电脑当前活动网卡的 IPv4，让手机连同一个 WiFi |
| 公司/校园网下必然失败 | 网络做了客户端隔离，设备互相不可见 | 改用隧道模式：`npm start -- --tunnel`（走公网中转，首次会慢些） |
| 换了网络后地址失效 | IP 变了 | 重启服务，重新扫码 |

> 电脑上若有多个网卡（Hyper-V、虚拟网卡等），Expo 可能广播错地址。
> 以终端实际打印的 `exp://…` 为准，不要凭印象输入。


## 本地配置

`.env` 存本地环境变量，**不入版本库**；模板见 `.env.example`。

| 变量 | 用途 |
|---|---|
| `EXPO_PUBLIC_PEXELS_API_KEY` | 「我的 → 封面图源」的网图检索（[Pexels](https://www.pexels.com/api/)） |

留空也能正常构建 —— 首次使用时在 App 里填一次即可，会存进本地数据库
（「我的 → 封面图源」）。改了 `.env` 需要重启 Metro 才生效。

> 该变量在打包时被内联进 JS bundle，装了包就能反编译提取。
> 所以正式分发的包不应带 Key，只适合自用构建。


## 怎么打出一个能装进手机的 APK

走**本地构建**，不使用 Expo 云构建。需要 JDK 17 + Android SDK。

```bash
cd android
gradlew.bat assembleRelease --no-daemon --console=plain --no-parallel
```

产物在 `android/app/build/outputs/apk/release/app-release.apk`，
传到手机安装即可（需允许"安装未知来源应用"）。

> 串行构建（`--no-parallel`）是为了绕开安全软件偶发拦截 Gradle 缓存。
> 增量构建约 6～8 分钟，首次全量或清缓存后会到 20 分钟以上。

### 签名配置（换机器必读）

**签名密钥与口令不入版本库**，克隆后需要自行补齐：

| 文件 | 入库 | 说明 |
|---|---|---|
| `android/app/gewu-release.keystore` | ❌ | release 签名密钥。**换密钥将导致无法覆盖安装已发布的版本** |
| `android/key.properties` | ❌ | 密钥口令，格式见 `android/key.properties.example` |
| `android/local.properties` | ❌ | 本机 Android SDK 路径，模板见 `android/local.properties.example` |

> ⚠️ 缺失 `key.properties` 时构建**不会中断**，会静默回落到 debug 签名 ——
> 打出来的包签名不符，装不上已经装了正式版的手机。打完包务必用
> `apksigner verify --verbose` 确认签名，这一步不加 `--verbose` 时通过也不打印任何字样。

### 发版前要同步的版本号

主版本号散落在两处，**必须一致**：

- `app.json` → `expo.version`（如 `1.2.1`）与 `expo.android.versionCode`（如 `5`）
- `android/app/build.gradle` → `versionName` 与 `versionCode`

Gradle 只认 `build.gradle` 那份，`app.json` 是给 Expo 与界面读的
（界面上的版本号从 `Constants.expoConfig.version` 取，不硬编码）。

---

## 功能范围（V1）

| 模块 | 内容 |
|---|---|
| 录入 | 名称唯一必填，其余选填；连续录入模式；按名称自动猜分类；按分类带出保质期 |
| 组织 | 物品列表、模糊搜索、按分类筛选、按柜子/格位筛选 |
| 位置 | 两级结构：柜子 → 格位；柜内格位视图；占用示意 |
| 相册 | 全部照片按年月分组浏览 |
| 到期 | 应用内到期清单（按已过期 / 30 天内 / 更远分组），**不做系统推送** |
| 持有成本 | 详情页显示持有天数与日均成本（实时计算，不落库） |
| 数据通道 | 备份包（zip，可完整还原）、导出 CSV、导入（可选覆盖或合并） |
| 回收站 | 软删除，可恢复或彻底清除 |

## 目录结构

```
src/
  app/                     页面（expo-router 文件路由）
    _layout.tsx            根 Stack + 数据库预热
    (tabs)/                五个底部标签页
      index.tsx            物品（列表 / 位置双视图）
      album.tsx  compose.tsx  alerts.tsx  mine.tsx
    item/[id]/             详情、编辑
    cabinet/               柜子管理、柜内格位
    trash.tsx              回收站
  components/
    TabBar.tsx             自定义底部标签栏
    ui/                    排版、布局、控件、反馈等原子件
    domain/                业务组件（物品行、柜子网格、表单、各类选择器）
  constants/theme.ts       设计令牌（色板 / 字级 / 间距 / 圆角）
  lib/
    db/                    SQLite 建表与四张表的仓储
    photos/                图片压缩、缩略图、沙盒落盘
    backup/                备份包、CSV 导出、导入
    date.ts format.ts      派生指标与格式化
    suggest.ts             分类猜词词典
    store/                 全局状态（数据版本 + 角标统计）
```

## 几条不能改坏的约定

- **主键必须是 UUID**：导入支持「合并」，自增 ID 在两份备份合并时必然撞车。
- **图片必须落进 App 沙盒**（`Paths.document/photos`），不能只存相册引用 —— 否则用户清理相册后照片全变白框。
- **派生指标不落库**：持有天数、日均成本在展示时实时计算；数据为空时整块隐藏，绝不显示 `¥0.00/天`。
- **删除是软删除**：先入回收站，彻底删除时才清照片文件。
- **备份与导出是两条通道**：备份给机器读（zip，可还原），导出给人看（CSV，Excel 能开）。

## 品牌素材

`assets/images/` 下的成品全部由脚本生成，没有手工图
（`_preview_dark.png` 是深色档预览，不参与构建）：

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `icon.png` | 1024×1024 | 主图标（iOS / 网页 / 备用），满幅方形不烤圆角 |
| `android-icon-foreground.png` | 1024×1024 | 安卓自适应前景（透明底 + 赭石棕「格」） |
| `android-icon-monochrome.png` | 1024×1024 | 安卓主题图标（单色 + alpha，系统自行上色） |
| `splash-icon.png` | 1024×1024 | 启动图，配置为 132pt |
| `favicon.png` | 64×64 | 网页 favicon |

要改图标，**改脚本再重新生成，不要直接 P 图**。需要 Pillow 与 Windows 的华文中宋
（`C:\Windows\Fonts\STZHONGS.TTF`）：

```bash
python tools/make_icons_final.py     # 1. 生成 assets/images/ 下的素材
python tools/sync_android_icons.py   # 2. 同步到 android/app/src/main/res/ 原生资源
```

> ⚠️ **两步缺一不可。** 安卓桌面实际读的是 `android/app/src/main/res/` 下的原生资源
> （prebuild 产物），只改 `assets/images/` 和 `app.json` 不会生效。
> 同时 `app.json` 的 `android.adaptiveIcon.backgroundColor` 与
> `res/values/colors.xml` 的 `iconBackground` 要一起改。
>
> `scripts/build-icons.py` 是早期的「朱印」方案（棕底反白字），**已废弃**，不要再用。

设计规格（v3 定稿）：暖米白底 `#F7F4EF` + 赭石棕 `#8C5A34` 中宋「格」字，
墨迹框占画布 **44%**，笔画做 2.2px 膨胀加粗 —— 中宋笔画细，缩到 48px 以下会散架，
膨胀能在不改变字形骨架（横细竖粗、撇捺出锋）的前提下把笔画压实。

> **Expo Go 里看不到这些图。** Expo Go 用的是它自己的图标和启动屏，
> 换成「格物」图标必须出一个独立 APK。改完图标也不必重启开发服务器，对 Expo Go 无影响。


## 技术栈

Expo SDK 57 · React Native 0.86 · React 19 · expo-router 57 · TypeScript · expo-sqlite

设计语言：暖棕纸感（品牌色 `#8C5A34`），衬线管叙述、无衬线管数据，数字开等宽对齐。

---

## 版本管理

### 什么入库、什么不入库

| 入库 | 不入库（`.gitignore` 排除） |
|---|---|
| `src/`、`assets/`、`tools/`、`scripts/` | `node_modules/`、`.expo/` |
| `android/` 的原生配置源码 | `android/app/build/`、`android/app/.cxx/`、`android/build/`、`android/.gradle/` |
| `app.json`、`package.json`、`tsconfig.json`、`eslint.config.js` | `android/key.properties`、`android/local.properties` |
| `.env.example`、`android/*.example` | `.env`、`*.keystore`、`*.jks` |

> `android/` **必须入库**：里面有手工维护的签名配置、权限调整（`tools:node="remove"`
> 移除录音与悬浮窗权限）、图标原生资源和 arm64 单架构设定。
> 一旦重新跑 `expo prebuild`，这些改动会被覆盖 —— **发版时不要 prebuild**，
> 只需同步两处版本号。

### 发一个版本

1. 改版本号：`app.json` 的 `version` / `android.versionCode`
   ＋ `android/app/build.gradle` 的 `versionName` / `versionCode`
2. 构建：`cd android && gradlew.bat assembleRelease --no-daemon --console=plain --no-parallel`
3. 校验：`aapt2 dump badging`（版本 / 架构 / 权限）、`apksigner verify --verbose`（签名）
4. 提交并打标签：

   ```bash
   git add -A
   git commit -m "release: v1.2.1"
   git tag -a v1.2.1 -m "格物 v1.2.1"
   git push origin main --tags
   ```

> 同版本号重打时版本串失去区分力，改用「差分 + 归因」：
> 确认 `createBundleReleaseJsAndAssets` 非 UP-TO-DATE，再扫基线之后被改的源文件
> （本机 `find -newermt` 静默失效，用 Python `st_mtime`），最后新旧 bundle 逐字节比。
