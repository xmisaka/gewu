/**
 * 格物 · 桌面小组件：JS 与原生两侧的「同一件事」对账
 *
 * 这个文件守的全是**跨语言、跨编译单元的重复**。重复本身是不得已的
 * （Kotlin 读不到 theme.ts，也 import 不了 snapshot.ts），但重复一旦分叉，
 * 每一条的表现都是**不报错**：
 *
 *   · 兜底配色与素笺对不上 → 「还没有快照」那一态是另一个颜色，
 *     用户以为小组件串了主题；而它只在「装了 widget 但还没打开过 App」时出现，
 *     平时根本没人能看见
 *   · 文件名对不上 → provider 永远读不到快照，卡片一直是空态，
 *     而 App 那边一切正常、文件也确实写出了
 *   · 版本号对不上 → 快照被整份判为「不认识」，同上
 *   · Kotlin 里写了一个布局里不存在的 id → RemoteViews 构造时不报错，
 *     要到 launcher 侧 apply 时才抛；而那次抛异常**不影响卡片的上一次内容**继续显示，
 *     表现就是「怎么改都不生效」
 *
 * 所以这几条全部钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const { WIDGET_SNAPSHOT_FILE, WIDGET_SNAPSHOT_VERSION } = await import('../src/lib/widget/snapshot.ts');

const rootOf = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

/* ------------------------------------------------------------ 读取源码 */

const themeSource = readFileSync(rootOf('src/constants/theme.ts'), 'utf8');

const WIDGET_DIR = rootOf('android/app/src/main/java/com/gewu/app/widget');
const ktFiles = readdirSync(WIDGET_DIR)
  .filter((f) => f.endsWith('.kt'))
  .map((f) => ({ name: f, text: readFileSync(join(WIDGET_DIR, f), 'utf8') }));

/**
 * 去掉 Kotlin 注释后再扫描。
 *
 * ★ 必须去：文档注释里会举例写 `setTextViewText(R.id.xxx, …)` 来说明「id 打错了
 *   会怎样」，把它当成真实引用会让下面的对账报一个假警 ——
 *   而假警比没有检查更糟，它会训练人忽略这个测试。
 * ★ 行注释要求 `//` 前面是行首或空白：`"gewu://alerts"` 里的 `://` 因此不受影响。
 */
function stripKotlinComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

const ktRaw = ktFiles.map((f) => f.text).join('\n');
const ktAll = stripKotlinComments(ktRaw);

const LAYOUT_DIR = rootOf('android/app/src/main/res/layout');
const layouts = readdirSync(LAYOUT_DIR)
  .filter((f) => f.endsWith('.xml'))
  .map((f) => ({ name: f, text: readFileSync(join(LAYOUT_DIR, f), 'utf8') }));

const stringsXml = readFileSync(rootOf('android/app/src/main/res/values/strings.xml'), 'utf8');

/* ------------------------------------------------------------ 解析素笺 */

/**
 * ★ 换行写成 `\r?\n`：theme.ts 是 CRLF 行尾，而不同编辑器/脚本写回时行尾会变。
 *   只认 `\n` 会让下面的正则**静默匹配不到**，断言拿到 undefined 再「凑巧通过」。
 * ★ 所以紧接着有一条断言专门核对「到底解析出来几个键」。
 */
const sujianBlock = (() => {
  const start = themeSource.indexOf('  sujian: {');
  assert.ok(start > 0, '没在 theme.ts 里找到素笺主题块 —— 下面的正则该更新了');
  const next = themeSource.indexOf('\n  dianqing: {', start);
  assert.ok(next > start, '没找到素笺之后的下一个主题 —— 主题表结构变了');
  return themeSource.slice(start, next);
})();

const sujianTokens = {};
for (const m of sujianBlock.matchAll(/^ {6}(\w+): '([^']+)',/gm)) sujianTokens[m[1]] = m[2];

/* ------------------------------------------------------------ Kotlin 侧的常量 */

/** `WidgetFallbackColors` 里那几条 `const val NAME = "#RRGGBB"` */
const fallbackColors = (() => {
  const start = ktAll.indexOf('object WidgetFallbackColors {');
  assert.ok(start > 0, '没找到 WidgetFallbackColors —— 兜底配色被挪走或改名了');
  const body = ktAll.slice(start, ktAll.indexOf('\n}', start));
  const out = {};
  for (const m of body.matchAll(/const val (\w+) = "(#[0-9A-Fa-f]{6})"/g)) out[m[1]] = m[2];
  return out;
})();

const ktSnapshotFile = /private const val SNAPSHOT_FILE = "([^"]+)"/.exec(ktAll)?.[1];
const ktSnapshotVersion = Number(/private const val SNAPSHOT_VERSION = (\d+)/.exec(ktAll)?.[1]);

/* ------------------------------------------------------------ 用例 */

test('★ 兜底配色解析得到六条（少一条就说明正则已经匹配不到了）', () => {
  assert.deepEqual(Object.keys(fallbackColors).sort(), [
    'BRAND',
    'INK',
    'INK3',
    'INK4',
    'LINE3',
    'SURFACE',
  ]);
  assert.ok(Object.keys(sujianTokens).length >= 25, `素笺令牌只解析出 ${Object.keys(sujianTokens).length} 个`);
});

test('★★ 原生侧的兜底配色必须与 theme.ts 的素笺逐条一致', () => {
  /* 这是全工程唯一一处主题色值出现在 theme.ts 之外的地方（理由见
     GewuWidgetSnapshot.kt 里 WidgetFallbackColors 的注释：兜底态的定义就是
     「拿不到快照」，而快照才是带着当前主题色值的那份东西）。
     ★ 它不是第二份真相，是复制品 —— 这一条就是防止复制品过期的。 */
  const pairs = [
    ['SURFACE', 'surface'],
    ['INK', 'ink'],
    ['INK3', 'ink3'],
    ['INK4', 'ink4'],
    ['LINE3', 'line3'],
    ['BRAND', 'brand'],
  ];
  for (const [ktName, token] of pairs) {
    assert.equal(
      fallbackColors[ktName],
      sujianTokens[token],
      `GewuWidgetSnapshot.kt 的 ${ktName}=${fallbackColors[ktName]} 与素笺的 ${token}=${sujianTokens[token]} 不一致 ——` +
        '改了 theme.ts 就要一起改那边，否则「还没有快照」那一态会是另一个颜色',
    );
  }
});

test('★★ 快照的文件名与版本号两侧必须一致', () => {
  /* 对不上的表现只有一种：provider 读不到 / 整份判为不认识，
     于是小组件永远停在空态 —— 而 App 这边文件确实写出了、日志里也没有任何异常。 */
  assert.equal(ktSnapshotFile, WIDGET_SNAPSHOT_FILE, 'JS 与 Kotlin 的快照文件名不一致');
  assert.equal(ktSnapshotVersion, WIDGET_SNAPSHOT_VERSION, 'JS 与 Kotlin 的快照版本号不一致');
});

test('★★ Kotlin 里用到的每一个 R.id.* 都必须在布局里真实声明', () => {
  /* RemoteViews 最容易踩的坑：id 打错了，构造时不报错，
     到 launcher 侧 apply 时才抛 —— 而且那次异常**不影响卡片上一次的内容**继续显示，
     于是表现成「改了没生效」，能查很久。这一条把它提前到提交前。 */
  const declared = new Set();
  for (const file of layouts) {
    for (const m of file.text.matchAll(/android:id="@\+id\/(\w+)"/g)) declared.add(m[1]);
  }
  assert.ok(declared.size >= 10, `布局里只解析出 ${declared.size} 个 id，正则该更新了`);

  const used = new Set();
  for (const m of ktAll.matchAll(/R\.id\.(\w+)/g)) used.add(m[1]);
  assert.ok(used.size >= 10, `Kotlin 里只解析出 ${used.size} 个 R.id，正则该更新了`);

  const missing = [...used].filter((id) => !declared.has(id)).sort();
  assert.deepEqual(missing, [], `Kotlin 用到了布局里不存在的 id：${missing.join(', ')}`);
});

test('★ Kotlin 里用到的 R.layout / R.string 也必须真实存在', () => {
  const layoutNames = new Set(layouts.map((f) => f.name.replace(/\.xml$/, '')));
  const strings = new Set([...stringsXml.matchAll(/<string name="(\w+)"/g)].map((m) => m[1]));

  const missingLayouts = [...new Set([...ktAll.matchAll(/R\.layout\.(\w+)/g)].map((m) => m[1]))].filter(
    (n) => !layoutNames.has(n),
  );
  const missingStrings = [...new Set([...ktAll.matchAll(/R\.string\.(\w+)/g)].map((m) => m[1]))].filter(
    (n) => !strings.has(n),
  );

  assert.deepEqual(missingLayouts, [], `Kotlin 引用了不存在的布局：${missingLayouts.join(', ')}`);
  assert.deepEqual(missingStrings, [], `Kotlin 引用了不存在的字符串：${missingStrings.join(', ')}`);
});

test('★ provider 信息里引用的布局、字符串与预览图都要存在', () => {
  const info = readFileSync(rootOf('android/app/src/main/res/xml/gewu_widget_info.xml'), 'utf8');
  const strings = new Set([...stringsXml.matchAll(/<string name="(\w+)"/g)].map((m) => m[1]));
  const layoutNames = new Set(layouts.map((f) => f.name.replace(/\.xml$/, '')));

  const initialLayout = /android:initialLayout="@layout\/(\w+)"/.exec(info)?.[1];
  assert.equal(initialLayout, 'widget_gewu');
  assert.ok(layoutNames.has(initialLayout), `initialLayout 指向了不存在的布局 ${initialLayout}`);

  const description = /android:description="@string\/(\w+)"/.exec(info)?.[1];
  assert.ok(description && strings.has(description), `description 指向了不存在的字符串 ${description}`);

  /* 预览图是打包资源：文件不在，**构建就会失败**（好事，早报错）。
     这里再钉一道是为了让「按 script 重新生成过」这件事有据可查。 */
  const preview = /android:previewImage="@drawable\/(\w+)"/.exec(info)?.[1];
  assert.equal(preview, 'widget_gewu_preview');
  const previewPath = rootOf(`android/app/src/main/res/drawable-nodpi/${preview}.png`);
  assert.ok(readFileSync(previewPath).length > 1000, '预览图不存在或是个空文件');
});

test('★ 清单里注册了 receiver，且指向的 provider 类真的存在', () => {
  /* 漏了 receiver 的表现：长按桌面 → 小组件列表里根本没有格物，
     不报错、App 也照常跑。 */
  const manifest = readFileSync(rootOf('android/app/src/main/AndroidManifest.xml'), 'utf8');
  const receiverName = /<receiver\s+android:name="([^"]+)"/.exec(manifest)?.[1];
  assert.equal(receiverName, '.widget.GewuWidgetProvider');

  /* `exported` 必须是 false：APPWIDGET_UPDATE 由系统发出，
     而系统在 checkComponentPermission 里被直接放行 —— 不需要把自己暴露出去。 */
  const receiverBlock = manifest.slice(manifest.indexOf('<receiver'), manifest.indexOf('</receiver>'));
  assert.match(receiverBlock, /android:exported="false"/, 'widget receiver 不该 exported=true');
  assert.match(receiverBlock, /android:name="android\.appwidget\.action\.APPWIDGET_UPDATE"/);
  assert.match(receiverBlock, /android:resource="@xml\/gewu_widget_info"/);

  const providerClass = ktFiles.find((f) => /class GewuWidgetProvider\s*:\s*AppWidgetProvider/.test(f.text));
  assert.ok(providerClass, '没找到 GewuWidgetProvider —— 清单里的 receiver 会指向一个不存在的类');
});

test('★ 注释里的 id 不该被当成真实引用（这条守着上面那条扫描的有效性）', () => {
  /* 上一条的对账靠正则扫 `R.id.*`，而注释里写 `R.id.xxx` 说明「id 打错会怎样」
     是最自然的行文。真扫进去了，那条测试就会一直红 —— 然后被人加白名单屏蔽掉，
     于是它连真问题也拦不住了。 */
  assert.ok(ktRaw.includes('R.id.xxx'), 'Kotlin 注释里那个举例的 id 被删了？这条测试的前提没了');
  assert.ok(!ktAll.includes('R.id.xxx'), '去注释没生效，下面那条对账会报警');
});

test('★★ 尺寸属性必须写对关系 —— 写错不是报错，是被系统**整条忽略**', () => {
  /* 这些属性**没有一个会在构建期报错**，写错了只有一个后果：
     系统悄悄按自己的默认值来，或者把某一条**整条忽略**。官方语义逐条查过
     （别凭记忆 —— 它们的名字和实际含义是反的）：
   *   · minWidth/minHeight 是「**默认**尺寸」= 刚放到桌面时占多大，**不是最小值**
   *   · minResizeWidth/Height **大于** minWidth/minHeight 时被直接忽略
   *   · maxResizeWidth/Height **小于** minWidth/minHeight 时被直接忽略（且 Android 12 才有）
   *   · updatePeriodMillis 小于 1800000 → 系统按 30 分钟下限处理
   *   · resizeMode 缺省时不同 launcher 行为不一致；写 none 则**完全拉不动**
   *
   * 2026-10-14 两次真机都栽在这上面：
   *   第一次是 minHeight 写成了「一行」的高度，桌面上只显示得下一行；
   *   第二次是六个值全部贴成同一个数 + resizeMode=none，
   *   用户长按拉不动，卡片里 22 件待办只画得出 3 行。 */
  const info = readFileSync(rootOf('android/app/src/main/res/xml/gewu_widget_info.xml'), 'utf8');
  const dp = (name) => {
    const m = new RegExp(`android:${name}="(\\d+)dp"`).exec(info);
    assert.ok(m, `gewu_widget_info.xml 里没找到 android:${name}（或它不是 dp 值）`);
    return Number(m[1]);
  };

  const minW = dp('minWidth');
  const minH = dp('minHeight');
  const minRH = dp('minResizeHeight');
  const maxRH = dp('maxResizeHeight');

  /* 官方格子公式：width = 73n − 16、height = 118m − 16 → 4×2 = 276×220 */
  assert.equal(minW, 276, '默认宽度应为 4×2 的 73×4−16 = 276dp');
  assert.equal(minH, 220, '默认高度应为 4×2 的 118×2−16 = 220dp（那时正好三行）');

  /* ★★ 这两条是「能不能拉动」的全部：条件不满足时系统**不报错**，
     只是那条属性被忽略 —— 用户看到的是一张拉不动的卡片。 */
  assert.ok(minRH < minH, `minResizeHeight(${minRH}) 必须**小于** minHeight(${minH})，否则整条被忽略、拉不小`);
  assert.ok(maxRH > minH, `maxResizeHeight(${maxRH}) 必须**大于** minHeight(${minH})，否则整条被忽略、拉不大`);
  assert.ok(maxRH > minRH, '最大可拉尺寸不能小于最小可拉尺寸');

  const period = Number(/android:updatePeriodMillis="(\d+)"/.exec(info)?.[1]);
  assert.ok(
    period >= 1800000,
    `updatePeriodMillis=${period} 小于系统下限 1800000（30 分钟）—— 会被静默夹到下限，` +
      '写成更小的值只会让人误以为刷新更频繁',
  );

  assert.match(info, /android:targetCellWidth="4"/);
  assert.match(info, /android:targetCellHeight="2"/);
  assert.match(info, /android:widgetCategory="home_screen"/);

  /* ★★ resizeMode 绝不能是 none。写成 none 的表现不是报错，而是
     **用户长按拖不动** —— 卡片里明明有 22 件待办，却只画得出三行，
     下面一大片空白。这是 2026-10-14 用户第二次反馈。 */
  const resizeMode = /android:resizeMode="([^"]+)"/.exec(info)?.[1];
  assert.ok(resizeMode, '没写 resizeMode —— 缺省行为在不同 launcher 上不一致');
  assert.notEqual(resizeMode, 'none', 'resizeMode=none 会让用户完全拉不动这张卡片');
  assert.match(resizeMode, /vertical/, '待办看板的价值在行数，而行数只由高度决定 —— 垂直方向必须可拉');
});

test('★★ widget/*.kt 里的 private const 一律声明在文件顶层', () => {
  /* 这条是**花了一次构建换来的**（2026-10-14，第一次编译这份 Kotlin）。
   *
   * 起因：尺寸常量原本写在 `object GewuWidgetRender` 内部，而 `Renderer` 是同一个
   * 文件里的另一个**顶层类** —— Kotlin 的 private 只在声明它的类（及其嵌套类）里
   * 可见，于是那些引用全部解析失败。可怕的地方是报错的样子：
   * 参数变成错误类型之后 `Math.round` 落到了返回 Long 的那个重载上，
   * 编译日志里冒出十几条「actual type is 'Long', but 'Int' was expected」，
   * 真正的错只有一处，症状却散布在整份文件里 —— 要对着源码看一遍才能定位。
   * 代价是 3 分 38 秒的构建。
   *
   * 约定：`private` 写成文件顶层（= 全文件可见）不损失任何封装，
   * 却让「这个引用能不能解析」这个问题不再取决于「我在哪个花括号里」。
   * 所以整个 widget 包统一这么写，由这条盯着。
   */
  const offenders = [];
  let total = 0;
  for (const file of ktFiles) {
    for (const line of stripKotlinComments(file.text).split('\n')) {
      if (!/private const val/.test(line)) continue;
      total += 1;
      if (!line.startsWith('private const val')) offenders.push(`${file.name}: ${line.trim()}`);
    }
  }
  /* 先钉住扫描有效：正则写坏了会让下面那条变成永远通过 */
  assert.ok(total >= 8, `整个 widget 包只扫到 ${total} 条 private const val，正则该更新了`);
  assert.deepEqual(
    offenders,
    [],
    `这些 private const 缩进在某个类里，同文件的其他顶层类看不到它们：\n  ${offenders.join('\n  ')}`,
  );
});

/**
 * 去掉 XML 注释后再扫描。
 *
 * ★ 必须去：这几个布局的注释里**刻意写着**「不能用裸 `<View>`」来说明上面那条约定，
 *   不去注释的话那条检查会一直红 —— 然后被人加白名单屏蔽掉，连真问题也拦不住。
 *   （同一个坑在 Kotlin 那边也踩过一次，见 stripKotlinComments。）
 */
function stripXmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, ' ');
}

test('★★★ 布局里只能用 RemoteViews 白名单内的视图类，且必须写全限定名', () => {
  /* 2026-10-14 第一次真机踩到，两个坑挨着来：
   *
   * ① 卡片底色与两条分隔线原本写成裸 `<View>` → 桌面直接显示
   *    「载入窗口小部件时出现问题」。RemoteViews 只认标注了 @RemoteView 的类，
   *    官方白名单是：
   *      容器  FrameLayout / LinearLayout / RelativeLayout / GridLayout
   *      控件  AnalogClock / Button / Chronometer / ImageButton / ImageView /
   *            ProgressBar / TextView / ViewFlipper / ListView / GridView /
   *            StackView / AdapterViewFlipper / ViewStub
   *    **裸 View 不在其中**，而它的失败方式是这里最坏的一种：
   *      构造 RemoteViews 不报错 → 我们自己在本进程 inflate（selfCheck）也不报错 →
   *      只有 launcher 侧 apply 时炸，桌面一句「载入窗口小部件时出现问题」，
   *      不说哪一行、不说哪个文件，launcher 的堆栈还会被系统吞掉。
   *
   * ② 改完 ① 之后，露出第二个：`<ImageView>` 在本进程里被 AppCompat 换成了
   *    `AppCompatImageView`，而它**覆写了 `setImageBitmap` 且没标
   *    `@RemotableViewMethod`** → RemoteViews 抛
   *    `ActionException: can't use method with RemoteViews: setImageBitmap`。
   *    真机上 launcher 侧其实是好的（它拿到的是标准控件），
   *    所以这是 **selfCheck 的假阳性** —— 但假阳性比没有自检更糟：
   *    它会训练人忽略这个自检。
   *    → 解法是标签写**全限定名**，AppCompat 的工厂 switch 就匹配不上了。
   *
   * 这一条同时校验上面两件事，因为它们的修法是同一个：写清全限定名 + 在白名单内。
   * 用**正面白名单**而不是「禁止 View」：黑名单挡不住下一个看着很普通的控件。
   */
  const PREFIX = 'android.widget.';
  const ALLOWED_SIMPLE = [
    'FrameLayout',
    'LinearLayout',
    'RelativeLayout',
    'GridLayout',
    'AnalogClock',
    'Button',
    'Chronometer',
    'ImageButton',
    'ImageView',
    'ProgressBar',
    'TextView',
    'ViewFlipper',
    'ListView',
    'GridView',
    'StackView',
    'AdapterViewFlipper',
    'ViewStub',
  ];
  const ALLOWED = new Set(ALLOWED_SIMPLE.map((n) => PREFIX + n));

  const offenders = [];
  let seen = 0;
  for (const file of layouts) {
    for (const m of stripXmlComments(file.text).matchAll(/<([A-Za-z][\w.]*)/g)) {
      seen += 1;
      const tag = m[1];
      if (!ALLOWED.has(tag)) {
        const hint = tag.indexOf('.') === -1 ? '（没写全限定名 —— 会被 AppCompat 换成子类）' : '';
        offenders.push(`${file.name}: <${tag}>${hint}`);
      }
    }
  }
  /* 先钉住扫描有效：正则写坏（比如 `<?xml` 也算进去）会让下面那条永远通过 */
  assert.ok(seen >= 20, `布局里只扫到 ${seen} 个标签，正则该更新了`);
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    '这些标签不在 RemoteViews 白名单里（或漏了全限定名），桌面会显示「载入窗口小部件时出现问题」：\n  ' +
      offenders.join('\n  '),
  );
});

test('★★ 三条快捷方式的 short/long 标签必须成对存在、且文案一致', () => {
  /* 2026-10-14 真机踩到：改完名字，长按菜单里三条**仍然显示旧名**，
     而每一环都是绿的 —— 代码、测试、编译、连「包里字符串池核对」都过了。
   *
   * 原因：**launcher 在长按菜单里优先显示的是 LongLabel**，而当时只改了 ShortLabel。
   * 没有哪一种 diff 能看出这件事，只有真机上长按才知道。
   *
   * 所以这里钉两条：
   *   ① short 与 long 必须都存在 —— 缺 long 时不同 launcher 的兜底行为不一致；
   *   ② 两者文案必须一致 —— 不一致就等于埋了「改了一处忘了另一处」这个坑，
   *      而且下一次还会以完全相同的形式再踩一次。
   */
  const strings = new Map(
    [...stringsXml.matchAll(/<string name="(\w+)">([^<]*)<\/string>/g)].map((m) => [m[1], m[2]]),
  );

  const ids = ['compose', 'alerts', 'search'];
  const checked = [];
  for (const id of ids) {
    const short = strings.get(`shortcut_${id}_short`);
    const long = strings.get(`shortcut_${id}_long`);
    assert.ok(short, `shortcut_${id}_short 不存在`);
    assert.ok(long, `shortcut_${id}_long 不存在 —— 长按菜单优先显示它，缺了不同 launcher 表现不一`);
    assert.equal(
      long,
      short,
      `shortcut_${id} 的 short="${short}" 与 long="${long}" 不一致：` +
        'launcher 显示的是 long，只改 short 等于没改。要么两处一起改，要么保持相同。',
    );
    checked.push(short);
  }
  /* 这三条同时也是 shortcuts.xml 里三个 shortcut 的顺序说明里的那个「名字」，
     钉住它们非空且互不相同 —— 全一样的话菜单里三条分不清 */
  assert.equal(new Set(checked).size, ids.length, `三条快捷方式的名字有重复：${checked.join(' / ')}`);
});

test('★★★ 行数换算的三个常量必须与布局 XML、JS 快照三方对得上', () => {
  /* 卡片现在**可以长按拖动改尺寸**，「能画几行」由原生算
     （`GewuWidgetRender.rowsThatFit`），那是个纯算术：
         行数 = (卡片高度 − 固定开销) / 每行占的高度
     两个输入全部来自布局 XML，却在 Kotlin 里被写成常量 ——
     一份**跨编译单元的重复**。改了布局里的行高、内边距或字号，
     Kotlin 那三个常量不会自己跟着变，而症状是**桌面上少一行或空一片**（不报错）。
     这一条就是替两边对账，顺便验证三个尺寸之间的关系是自洽的。
   *
   * 另外它还会把 JS 侧的备货量（`WIDGET_MAX_ROWS`）拉进来一起比：
   * 那三个数说的是同一件事的三种说法，任何一处单独改动都会在这里变红。 */
  const main = layouts.find((f) => f.name === 'widget_gewu.xml')?.text;
  const row = layouts.find((f) => f.name === 'widget_gewu_row.xml')?.text;
  assert.ok(main && row, '找不到 widget_gewu.xml / widget_gewu_row.xml');

  const pick = (text, re, what) => {
    const m = re.exec(text);
    assert.ok(m, `没解析到${what} —— 正则该更新了`);
    return Number(m[1]);
  };

  /* 一行文字的高度按字号 × 1.4 估（Android 的默认行距倍数）。
     宁可估高：估低了会漏掉「差一点点装不下」那种情况。 */
  const LINE = 1.4;

  const pad = pick(main, /android:padding="([\d.]+)dp"/, '外层内边距');
  const ruleGap = pick(
    main,
    /android:id="@\+id\/widget_rule_top"[\s\S]{0,120}?android:layout_marginTop="([\d.]+)dp"/,
    'rule_top 的上外边距',
  );
  const rowsGap = pick(
    main,
    /android:id="@\+id\/widget_rows"[\s\S]{0,160}?android:layout_marginTop="([\d.]+)dp"/,
    'widget_rows 的上外边距',
  );
  const footGap = pick(
    main,
    /android:layout_marginTop="([\d.]+)dp"\s+android:orientation="horizontal"/,
    '页脚行的上外边距',
  );
  const headerSp = pick(
    main,
    /android:id="@\+id\/widget_header"[\s\S]{0,300}?android:textSize="([\d.]+)sp"/,
    '页眉字号',
  );
  const footSp = pick(
    main,
    /android:id="@\+id\/widget_foot_left"[\s\S]{0,300}?android:textSize="([\d.]+)sp"/,
    '页脚字号',
  );
  const rowH = pick(row, /android:layout_height="([\d.]+)dp"/, '行高');
  const rowGap = pick(row, /android:layout_marginBottom="([\d.]+)dp"/, '行间距');

  /* 布局算出来的两个值 */
  const fixNeed =
    pad * 2 + headerSp * LINE + (ruleGap + 1) + rowsGap + 1 + (footGap + footSp * LINE);
  const pitchNeed = rowH + rowGap;

  /* Kotlin 里写的三个值 */
  const ktFix = Number(/private const val FIXED_OVERHEAD_DP = (\d+)/.exec(ktAll)?.[1]);
  const ktPitch = Number(/private const val ROW_PITCH_DP = (\d+)/.exec(ktAll)?.[1]);
  const ktRows = Number(/private const val MAX_ROWS_CAPACITY = (\d+)/.exec(ktAll)?.[1]);
  assert.ok(
    ktFix > 0 && ktPitch > 0 && ktRows > 0,
    `没解析到 Kotlin 的行数换算常量（FIXED_OVERHEAD_DP=${ktFix} ROW_PITCH_DP=${ktPitch} ` +
      `MAX_ROWS_CAPACITY=${ktRows}）—— 改名或挪位置了？`,
  );

  /* ★ 每行占的高度是精确值（两个整数相加），必须完全相等 */
  assert.equal(
    ktPitch,
    pitchNeed,
    `ROW_PITCH_DP 应为 ${pitchNeed}（行高 ${rowH} + 行距 ${rowGap}），Kotlin 里写的是 ${ktPitch}`,
  );
  /* ★ 固定开销里含两个「字号 × 1.4」的估算项，允许 ±3dp 的余量。
     余量给大了它就变成装饰 —— 谁把内边距从 14 改成 20（差 12dp）必须报错。 */
  assert.ok(
    Math.abs(ktFix - fixNeed) <= 3,
    `FIXED_OVERHEAD_DP=${ktFix}，布局算出来约 ${fixNeed.toFixed(1)}dp，差得太多 —— ` +
      '改了内边距/字号/间距就要同步改 Kotlin 那一条',
  );

  /* ★ 行数上限必须与 JS 侧的快照备货量一致：
     这边比那边大 → 拉大之后多出来的行是空白的；小 → 快照白带了数据 */
  const snapshotSource = readFileSync(rootOf('src/lib/widget/snapshot.ts'), 'utf8');
  const jsRows = Number(/WIDGET_MAX_ROWS\s*=\s*(\d+)/.exec(snapshotSource)?.[1]);
  assert.ok(jsRows > 0, '没解析到 WIDGET_MAX_ROWS —— 改名了？');
  assert.equal(
    ktRows,
    jsRows,
    `MAX_ROWS_CAPACITY(${ktRows}) 与 JS 的 WIDGET_MAX_ROWS(${jsRows}) 不一致 —— 三处说的是同一件事`,
  );

  /* ★ 行数换算必须有**上界**：拉得很高时按除法算出来可能是十几行，
     而快照里只有这么几条备货 —— 多出来的行会画成空白。 */
  assert.match(
    ktAll,
    /coerceIn\(1, MAX_ROWS_CAPACITY\)/,
    'rowsThatFit 没有把结果夹到 MAX_ROWS_CAPACITY —— 拉得很高时会画出空行',
  );

  const info = readFileSync(rootOf('android/app/src/main/res/xml/gewu_widget_info.xml'), 'utf8');
  const minH = Number(/android:minHeight="(\d+)dp"/.exec(info)?.[1]);
  const minRH = Number(/android:minResizeHeight="(\d+)dp"/.exec(info)?.[1]);
  const maxRH = Number(/android:maxResizeHeight="(\d+)dp"/.exec(info)?.[1]);
  assert.ok(minH > 0 && minRH > 0 && maxRH > 0, '没解析到 minHeight / minResizeHeight / maxResizeHeight');

  const rowsNeed = (n) => fixNeed + n * pitchNeed;
  console.log(
    `  [参考] 固定开销 ${fixNeed.toFixed(1)}dp ＋ 每行 ${pitchNeed}dp → ` +
      `1 行 ${rowsNeed(1).toFixed(0)}dp / 3 行 ${rowsNeed(3).toFixed(0)}dp / ` +
      `${ktRows} 行 ${rowsNeed(ktRows).toFixed(0)}dp；` +
      `minHeight=${minH} minResizeHeight=${minRH} maxResizeHeight=${maxRH}`,
  );

  /* ★ 三个尺寸各自要装得下它承诺的行数。任何一条不满足，后果都只是
     **桌面上少一行或空一片**，不会有任何报错：
       · 默认尺寸要装下 3 行（放置时的设计稿就是三行）
       · 最小可拉尺寸要装下 1 行 —— 否则用户拉到最小，卡片看起来像坏了
       · 最大可拉尺寸要装下「备货量」那么多行 —— 否则拉到底也是一片空白 */
  assert.ok(minH >= rowsNeed(3), `minHeight=${minH}dp 装不下三行（要 ${rowsNeed(3).toFixed(0)}dp）`);
  assert.ok(
    minRH >= rowsNeed(1),
    `minResizeHeight=${minRH}dp 连一行都装不下（要 ${rowsNeed(1).toFixed(0)}dp）—— ` +
      '用户拉到最小尺寸会看到一张看起来像坏了的卡片',
  );
  assert.ok(
    maxRH >= rowsNeed(ktRows),
    `maxResizeHeight=${maxRH}dp 装不下 ${ktRows} 行（要 ${rowsNeed(ktRows).toFixed(0)}dp）—— ` +
      '拉到底也是一片空白',
  );
});
