/**
 * 安卓原生图标资源同步器
 *
 * 为什么不直接跑 `expo prebuild`：
 *   用户正在改别的功能，此时 prebuild --clean 会重建整个 android 目录，
 *   可能冲掉手工改动。本脚本只重写图标相关的资源文件，其余一律不动。
 *
 * 算法来源：@expo/prebuild-config/build/plugins/icons/withAndroidIcons.js
 *   - legacy 基准 48px / adaptive 基准 108px
 *   - 密度倍率 mdpi 1 / hdpi 1.5 / xhdpi 2 / xxhdpi 3 / xxxhdpi 4
 *   - ic_launcher        : 主图标 + iconBackground 底色，resizeMode cover
 *   - ic_launcher_round  : 同图，borderRadius = size * 0.5
 *   - ic_launcher_foreground / monochrome : 透明底，按 adaptive 基准
 *   - splashscreen_logo  : 启动图，drawable-* 各档
 * 本脚本复用 @expo/image-utils 的 generateImageAsync，产出与 prebuild 一致。
 */
const fs = require('fs');
const path = require('path');

const { generateImageAsync } = require('@expo/image-utils');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const IMAGES = path.join(ROOT, 'assets', 'images');

// 与 app.json 保持一致
const APP = require(path.join(ROOT, 'app.json')).expo;
const BG_COLOR = APP.android.adaptiveIcon.backgroundColor; // #F7F4EF

const DPI = [
  { key: 'mdpi', scale: 1 },
  { key: 'hdpi', scale: 1.5 },
  { key: 'xhdpi', scale: 2 },
  { key: 'xxhdpi', scale: 3 },
  { key: 'xxxhdpi', scale: 4 },
];

const LEGACY_BASE = 48;    // ic_launcher / ic_launcher_round
const ADAPTIVE_BASE = 108; // foreground / monochrome

// 启动图基准（Expo splash 插件用 160dp 档位近似，这里沿用现有文件的尺寸关系）
const SPLASH_DPI = {
  mdpi: 288,
  hdpi: 432,
  xhdpi: 576,
  xxhdpi: 864,
  xxxhdpi: 1152,
};

async function gen(src, size, { backgroundColor = 'transparent', borderRadius } = {}) {
  const res = await generateImageAsync(
    { projectRoot: ROOT, cacheType: 'gewu-icon-sync' },
    {
      src,
      width: size,
      height: size,
      resizeMode: 'cover',
      backgroundColor,
      borderRadius,
    }
  );
  return res.source;
}

async function main() {
  const icon = path.join(IMAGES, 'icon.png');
  const fg = path.join(IMAGES, 'android-icon-foreground.png');
  const mono = path.join(IMAGES, 'android-icon-monochrome.png');
  const splash = path.join(IMAGES, 'splash-icon.png');

  for (const f of [icon, fg, mono, splash]) {
    if (!fs.existsSync(f)) throw new Error('缺素材: ' + f);
  }

  console.log('底色 iconBackground ->', BG_COLOR);
  console.log('');

  for (const { key, scale } of DPI) {
    const dir = path.join(RES, `mipmap-${key}`);
    fs.mkdirSync(dir, { recursive: true });

    // 1. legacy 方形图标（圆角由启动器裁切，这里铺满方形）
    const legacySize = Math.round(LEGACY_BASE * scale);
    const legacy = await gen(icon, legacySize, { backgroundColor: BG_COLOR });
    fs.writeFileSync(path.join(dir, 'ic_launcher.webp'), legacy);

    // 2. legacy 圆形图标
    const round = await gen(icon, legacySize, {
      backgroundColor: BG_COLOR,
      borderRadius: legacySize * 0.5,
    });
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.webp'), round);

    // 3. 自适应前景（透明）
    const adSize = Math.round(ADAPTIVE_BASE * scale);
    const advFg = await gen(fg, adSize, { backgroundColor: 'transparent' });
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.webp'), advFg);

    // 4. 主题单色图标（透明）
    const advMono = await gen(mono, adSize, { backgroundColor: 'transparent' });
    fs.writeFileSync(path.join(dir, 'ic_launcher_monochrome.webp'), advMono);

    console.log(
      `  mipmap-${key.padEnd(8)} ic_launcher ${legacySize}px / round ${legacySize}px / fg+mono ${adSize}px`
    );
  }

  // 5. 启动图
  for (const [key, size] of Object.entries(SPLASH_DPI)) {
    const dir = path.join(RES, `drawable-${key}`);
    fs.mkdirSync(dir, { recursive: true });
    const logo = await gen(splash, size, { backgroundColor: 'transparent' });
    fs.writeFileSync(path.join(dir, 'splashscreen_logo.png'), logo);
    console.log(`  drawable-${key.padEnd(8)} splashscreen_logo ${size}px`);
  }

  console.log('\n完成。原生资源已同步为 v3 图标。');
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
