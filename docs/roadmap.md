# 格物 · V2 待办与优化清单

> 梳理时间：2026-09-23 · 基线版本 v1.2.1（versionCode 5）
> **更新：2026-09-23 晚 —— 第一批 + 第二批已落地，逐条复核过源码，标 ✅ 的都有证据行号。**
> 每一条都标了代码位置，方便直接开工；「证据」一栏是当前实现的事实，不是推测。

---

## 一、结论速览

V1 的功能闭环是完整的：录入 → 组织 → 找回 → 到期 → 备份。**没有结构性缺口。**

第一批（数据通道缺陷 + 断链 + 仓库卫生 + 性能）已经做完，剩下的**全是「要拿主意」的新功能**：

| 排序 | 事项 | 为什么值得 | 量级 | 状态 |
|---|---|---|---|---|
| 1 | 到期提醒（本地通知） | 产品自己承诺的 V2 项，是「到期」模块的闭环 | 中 | 待办 |
| 2 | 统计 / 洞察页 | 数据全在库里，兑现「知道它们值不值」 | 中 | 待办 |
| 3 | 照片全屏查看 | 盘点、理赔、出手时要看清型号，现在看不清 | 小 | 待办 |
| 4 | 数量 / 库存 | 食品药品只能记「有」，不能记「还有 3 瓶」 | 中 | 待办（动 schema） |
| 5 | 借出 / 保修记录 | 收纳类 App 的自然延伸 | 中 | 待办（动 schema） |
| 6 | 列表分页 + 首屏懒加载收尾 | 个人规模不急，但方向明确 | 小 | 待办 |

### 本轮已落地（12 项）

| 项 | 内容 | 落点 |
|---|---|---|
| B1 | 三个数据通道缺陷（分类计数错 / 孤儿照片 / `REPLACE` 级联） | `backup.ts` · `pipeline.ts` · `db/*.ts` |
| A1 | 手动排序有了入口（↑ / ↓，仅「手动」档且无搜索无筛选时出现） | `index.tsx:369` |
| A2 | 批量改位置、批量删除 | `items.ts:369` `:374` |
| A3 | 搜索纳入分类名 / 位置名；位置视图补上搜索框 | `items.ts:205` `index.tsx:410` |
| A7 | 导入前预览（只读不写库）+ 备份超 30 天提醒 | `backup.ts:372` `mine.tsx:54` |
| B2 | 搜索 200ms 防抖 + 照片计数/封面改 `LEFT JOIN` | `use-debounced-search.ts` |
| B4 | 删掉 5 个零引用依赖 | `package.json` |
| B5 | `package.json` / `app.json` / `build.gradle` 三处版本对齐 1.2.1 | — |
| B6 | 删空目录 `src/hooks/`；5 个图标脚本归档 `tools/_archive/` | — |
| B7 | 纯函数单测（48 个用例） | `tests/*.test.mjs` |
| B8 | 颜色硬编码守护脚本挂进校验链 | `tools/audit-theme-colors.mjs` |
| B9 | 首页 cabinets 查询挪到 `mode === 'location'` 之后 | `index.tsx:280` |

**没做、且当时明确排除的**：统计页、全屏看图、重复项提示、数量/库存、借出/保修、
本地通知、v3 schema 迁移、iOS 适配、自动备份到目录。

---

## 二、功能缺口

### A1 · 手动排序入口 ✅ 已落地

**做法（已采用）**：列表在「手动」排序档、且没有搜索词与分类筛选时，行尾出现 ↑ / ↓
（`index.tsx:231` 的 `moveItem` → `:369` 传给 `ItemRow` 的 `onMoveUp / onMoveDown`）。

**仍可做**：长按拖动排序（`react-native-gesture-handler` + `reanimated` 已在依赖里）。
现在这版是「点一下挪一格」，够用，但整段重排时要连点很多次。

---

### A2 · 批量操作 ✅ 主体已落地

**已做**：批量补分类、**批量改位置**（`assignLocation`）、**批量删除**（`softDeleteMany`，走软删除，可恢复）。
统一走 `updateManyItems`（`items.ts:344`），包在 `withTransactionAsync` 里。

**仍缺**：**批量加标签** —— 标签已有 read/write 通路，缺批量入口，需要一个多选标签选择器。

---

### A3 · 搜索 ✅ 主体已落地

**已做**：
- 分类名进匹配范围（`items.ts:205` 的 `EXISTS (SELECT 1 FROM categories …)`）
- 位置名 / 柜子名进匹配范围（`:206`，含 `locations p ON p.id = l.parent_id` 取父级柜名）
- 位置视图补上了搜索框（`index.tsx:410`，占位符「搜索柜子或格位」）

**仍缺**：
- 拼音 / 首字母（`cdx` 搜不到「充电线」）—— 加分项，需要一张轻量拼音映射表，别自己造轮子。
- 搜索历史 / 最近搜索。

---

### A4 · 数量 / 库存与「消耗」动作

**证据**：`items` 表无 `quantity` 字段（`schema.ts:39-58`），食品 / 药品 / 耗材只能记"有"，不能记"还有 3 瓶"。

**缺口**：没有"用掉一件"的快捷动作，也没有低库存提示。

**做法**：加 `quantity INTEGER`（`SCHEMA_VERSION` → 3，走既有幂等迁移链）。
详情页给「用掉一件 / 补一件」，减到 0 时提示归档或进「该补货了」清单。
**注意**：这条会动 schema，改前先走 `expo-sqlite-schema-migrate` 技能，注意 `CREATE_INDEXES` 必须在 `migrate()` 之后。

---

### A5 · 借出 / 保修记录

**证据**：无相关字段。工具借给邻居、数码在保 —— 收纳类 App 的自然延伸。
界面稿的「设计取舍」里已经写明：V1 **没有**保修字段，将来加的话直接复用琥珀色倒计时，不新增色。

**两种做法**：
- 零成本：约定标签前缀（`借出:张三`、`保修至:2027-03`），查询靠 LIKE。够用但不成体系。
- 正式：`loaned_to TEXT` / `warranty_until TEXT` 两列（同样 v3 迁移），
  到期页可以顺带把「保修将到期」也列出来 —— **复用到期的三段式 UI，不用新页**。

---

### A6 · 统计 / 洞察页

**证据**：现有统计只有首页三格（`MetricStrip`）与我的页总量（`getStats`）。
数据层 `price / purchaseDate / categoryId / locationId` 全都在，**零 schema 变更**即可产出：

- 分类维度的价值分布（哪个类目最烧钱）
- 日均成本 TOP N（`dailyCost` 已实现，只是没被聚合）
- 柜子占用排行（`CabinetView.occupiedSlots` 已有）
- 月度新增件数 / 新增金额趋势（`createdAt` 已有）

**做法**：新增一页（可以挂在「我的 → 整理」下，不动底部五格）。
图表别引图表库 —— 用现有的 `Card` + 横向条即可保持设计语言统一。

---

### A7 · 备份通道的健壮性 ✅ 主体已落地

**已做**：
- **导入前预览**（`backup.ts:372` 的 `previewBackup`，注释写明「只读不写库」）——
  恢复到哪、包里有几件，用户不再是盲选。
- **备份超期提醒**：`BACKUP_STALE_DAYS = 30`（`mine.tsx:54`），`backupStale` 驱动品牌卡文案。
- **收尾对账**：导入/覆盖后统一调 `pruneOrphanFiles(referenced)`（`pipeline.ts:129`，调用点 `backup.ts:540`），
  删掉磁盘上已无人引用的照片文件，`storageUsage()` 不再虚高。
- 原先零引用的 `fileExists` / `stageForBackup` 已作为死代码删除 —— 对账这件事由
  `pruneOrphanFiles` 一并承担，不需要它们了。

**仍缺**：
- **历史备份包清理**：写在 cache 下的包越堆越多，无保留策略、无清理入口。
- **照片缺失检出**：DB 有记录但文件丢了，当前对账只做「文件→DB」单向，反向没查。

---

### A8 · 照片体验

**证据**：详情页只有缩略图横向条（`item/[id]/index.tsx:97-113`），没有全屏查看。

**缺口**：
- **全屏大图 + 双指缩放** —— 盘点、理赔、出手时要看清型号和序列号，现在看不清。
- **换封面**只能在编辑页操作，路径太长；详情页该有个「设为封面」。
- 相册页点击跳物品详情，不能看大图，也没有单张删除。

---

### A9 · 其他小缺口

- **重复物品提示**：录入时若已存在同名物品，提示「已存在同名，是同一件吗？」（成本极低，防重复录入）
- **复制一件**：同款买第二个，现在要重填全部字段
- **导出选中项**：现在只能全量 CSV
- **iOS**：`app.json` 配置基本就绪，但从未构建验证过

---

## 三、优化项

### B1 · 数据通道的三个真实缺陷 ✅ 全部已修

**(1) 导入完成后的「分类」计数** —— 改为在分类循环结束时取快照，不再用四段循环累加后的 `skipped`。

**(2) 覆盖导入留下孤儿照片** —— 新增 `pruneOrphanFiles`（`pipeline.ts:88`），
导入收尾一律对账一次（`backup.ts` 注释：收尾一律对账一次，清掉磁盘上没人引用的照片文件）。
目录不可读时返回空表，结果偏保守，不会误删。

**(3) `INSERT OR REPLACE` 的级联风险** —— 全部改成显式 `ON CONFLICT(id) DO UPDATE SET`
（`items.ts:572`、`categories.ts:127`、`locations.ts:227`、`photos.ts:169`），
并且每处都留了注释说明「REPLACE 是先删后插，会级联删掉照片记录」。
`db/index.ts:103` 的 meta 表也一并改了。

---

### B2 · 搜索性能 ✅ 已落地

- `use-debounced-search.ts` 提供 200ms 防抖，`index.tsx:121` 接上。
- `SELECT_VIEW` 的 `cover_thumb` 子查询改成 `LEFT JOIN` + 聚合（`items.ts:73-76`），
  一次扫描拿到首图与计数，不再是 N 行 2N 次相关子查询。

**知情即可**：`sort: 'name'` 仍会整表取回在 JS 里用 `Intl.Collator` 重排（中文排序不能交给 SQL），
数据量大时是全量 + 排序。

---

### B3 · 列表未分页（未做）

`listItems` 不传 `limit` 时返回全量，首页 FlatList 一次拿到所有行。
`limit / offset` 接口已经留好了，个人规模（<2000 件）不必急着改，
但目录页（`cabinet/[id].tsx`）已经做了 `slice(0, tilesPerRow * 6)` 截断 ——
两边的策略不一致，将来统一成一种。

---

### B4 · 未使用依赖 ✅ 已移除

`@expo/ui` / `expo-glass-effect` / `expo-symbols` / `expo-web-browser` / `expo-device`
五个包已从 `package.json` 移除，未打 release 验证过（当时只跑了 `npm run verify`）。

**不要动**：`expo-linking` / `expo-splash-screen` / `expo-system-ui` /
`react-native-screens` / `react-native-worklets` —— 这些是 expo-router 与 reanimated 的
运行时依赖，源码里 grep 不到但缺了会崩。

---

### B5 · 版本号三处不一致 ✅ 已对齐

三处现在都是 `1.2.1`（`package.json` / `app.json` / `android/app/build.gradle`）。
发版时仍只需同步后两处，`package.json` 不参与打包。

---

### B6 · 仓库卫生 ✅ 已清理

- `src/hooks/` 空目录已删（真实 hooks 在 `src/lib/hooks/`）。
- 5 个图标脚本 + 预览图归档到 `tools/_archive/`（`make_icons.py` / `_v2` / `mock_desktop.py` /
  `font_probe.py` / `scripts/build-icons.py`），`tools/` 只留 `make_icons_final.py` +
  `sync_android_icons.py` + `audit-theme-colors.mjs`。
- **死代码已清**：`wipeAll`、`closeDatabase`、`getStorageUsage`、`fileExists`、
  `stageForBackup`、`countAll`、`listRecent` 七个零引用函数全部删除，`grep` 复核为 0 命中。

---

### B7 · 测试 ✅ 已落地

`tests/` 下三个文件共 **48 个用例**，全绿：

| 文件 | 覆盖 |
|---|---|
| `pure.test.mjs` | `lib/date.ts` 的 `expiryState` / `holdingDays` / `dailyCost` / `addMonths`；`lib/format.ts` 的 `parseMoneyInput` / `formatMoney`；`lib/suggest.ts` 的 `guessCategory` |
| `db.test.mjs` | 建表 / 迁移 / 索引，用 `node:sqlite` 的 `DatabaseSync` 跑真实 SQL |
| `search.test.mjs` | 搜索的 WHERE 拼装与分类名 / 位置名命中 |

跑法：`npm test`（`node --experimental-strip-types --experimental-test-module-mocks`，
用 `tests/support/register.mjs` 装 `mock.module`）。不需要 Jest 全家桶。

---

### B8 · 主题硬编码的自动化守护 ✅ 已落地

`tools/audit-theme-colors.mjs` 扫 `src/**` 里的十六进制色值，白名单只放 `theme.ts`，
零命中才通过。已挂进 `npm run verify`。

顺带：相册压照片的白字阴影那处 `rgba()` 是刻意的（压照片用 `pure` 而非 `onAccent`），脚本放行。

---

### B9 · 首屏加载 ✅ 部分落地

- 首页：cabinets 查询已挪到 `mode === 'location'` 之后（`index.tsx:280`）✅
- 录入页：`compose.tsx:38-42` **仍在并发三个 `useAsyncData`**（categories + cabinets + lastLocation），
  可以合并成一个 `Promise.all` 状态。⬜

---

## 四、建议的推进顺序

**第一批（半天级，全是小改）** ✅ 已完成
1. ~~修 B1 的三个数据通道缺陷~~
2. ~~A2 批量操作补齐~~
3. ~~A3 搜索纳入分类名 / 位置名~~
4. ~~B6 仓库卫生 + B5 版本对齐~~
5. ~~A7 导入前预览~~

**第二批（几天级）** ✅ 已完成
6. ~~A1 手动排序入口（↑/↓ 版）~~
7. ~~A7 备份超期提醒（历史包清理仍未做）~~
8. ~~B2 查询优化（防抖 + 子查询改 JOIN）~~
9. ~~B7 补纯函数单测 + B8 颜色守护脚本~~

**第三批（要拿主意，都还没动）**
10. A4 数量/库存 + A5 借出/保修 —— 一起做一次 v3 迁移（省一次发版）
11. A6 统计洞察页
12. A8 照片全屏查看 + 详情页「设为封面」
13. 系统级到期提醒（本地通知，需处理 Android 13+ 权限，注意别 prebuild）
14. 收尾零碎：批量加标签 / 历史备份包清理 / 照片缺失反向检出 / B9 录入页合并查询

> 第三梯队里，**本地通知**和 **v3 迁移**是两件需要单独想清楚的事：
> 前者会引入新依赖与权限，后者会碰数据库 —— 都建议单独发一个版本，别混在功能批里。
