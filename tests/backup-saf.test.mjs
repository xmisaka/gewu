/**
 * 「备份到手机文件夹」（Android SAF）写盘路径的守护测试。
 *
 * 为什么要有它：这条路径**没法在 CI 里跑** —— `src/lib/backup/backup.ts` import 了
 * expo-file-system，node:test 加载不了原生模块；而它偏偏是本项目里唯一一条
 * 「只在真机上才会暴露」的写盘逻辑。2026-10-14 真机报「写入失败」就是这么来的：
 * 代码在类型检查、lint、592 条测试里全绿，到手机上一次都没成功过。
 *
 * 所以这里全部用**源码级断言**：不 import 那个模块，只读文件、剥掉注释、比字符串。
 * 粗，但这几件事本来就只关心「有没有这么写」。四条断言各自对应一个已经踩过的坑，
 * 每一条都反向验证过（把实现改坏 → 红）。
 *
 * 背景（读 `expo-file-system@57.0.7` 源码得出，详见 backup.ts 里 copyIntoDir 的注释）：
 *   `CopyMoveStrategy.SAF.prepareAsDestination()` 在目的地是**已存在的文件**时，
 *   一定会先 `deleteRecursively()`（overwrite=true）或直接抛（overwrite=false）。
 *   → 「先 createFile 建目标、再 copy 进去」这个组合**两头都是死路**。
 *   唯一能跑通的是「copy 到一个**目录**」，由库自己走 isContainer 分支建文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/backup/backup.ts', import.meta.url), 'utf8');

/** 剥掉块注释与行注释 —— 否则「注释里提到 createFile」会被当成真的调用了它 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const code = stripComments(source);

/** 取一个顶层函数的定义体（文件用两空格缩进，所以行首的 `}` 就是它的结尾） */
function bodyOf(name) {
  const match = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`).exec(code);
  assert.ok(match, `在 backup.ts 里找不到 ${name} 的定义`);
  return match[0];
}

const copyIntoDir = bodyOf('copyIntoDir');
const saveBackupToDevice = bodyOf('saveBackupToDevice');

/* ==================== 1. 目的地必须是「目录」，不是「文件」==================== */

test('★★ SAF 写入必须 copy 到**目录** —— copy 到预先 createFile 出来的文件在库里必然失败', () => {
  assert.match(
    copyIntoDir,
    /\.copy\(\s*dir\s*,\s*\{\s*overwrite:\s*true\s*\}\s*\)/,
    'copyIntoDir 没有把「目录」当 copy 目的地。库里的 SAF 覆盖写只有 isContainer 分支能跑通 —— ' +
      '详见 backup.ts 里 copyIntoDir 的注释。',
  );

  /* 这一条是那个真机 bug 的核心：一旦有人「优化」回「先建文件再拷进去」，
     代码依旧类型安全、lint 全绿、测试全过，但在手机上 100% 报「写入失败」。 */
  assert.equal(
    /createFile\(/.test(copyIntoDir),
    false,
    'copyIntoDir 里又出现了 createFile —— 「先建目标文件再 copy 进去」会让库里在拷贝前把目标删掉，' +
      '接着往一个不存在的 document 开输出流，必然 FileNotFoundException',
  );
});

/* ==================== 2. 临时改名必须成对出现 ==================== */

test('★ 拷完必须把源文件的名字还回去（否则这份归档从 cache 列表里消失）', () => {
  assert.match(
    copyIntoDir,
    /source\.rename\(DEVICE_BACKUP_NAME\)/,
    'copyIntoDir 没有把源文件临时改名为固定名 —— 那样目标名会取自 source.fileName，' +
      '时间戳会被带进用户选的文件夹，固定名的意义就没了',
  );

  assert.match(
    copyIntoDir,
    /finally\s*\{[\s\S]*?\.rename\(originalName\)/,
    '改名没有在 finally 里改回去 —— copy 一旦抛错，cache 里那份归档就永远叫「格物-备份.zip」，' +
      '而 listBackupFiles / 保留策略都靠名字里的时间序认它',
  );
});

/* ==================== 3. 失败必须留下证据 ==================== */

test('★ 写盘失败的 catch 必须带错误对象并记下来（这条路径查不了因就只能靠反读库源码）', () => {
  /* 裸 `catch {` 是这次的第二个坑：2026-10-14 那次真机故障，运行时一个字节都没留下，
     定位只能靠反读 expo-file-system 源码。所以要求 catch **绑定了错误对象**且真的打了日志。 */
  assert.match(
    saveBackupToDevice,
    /copyIntoDir\([\s\S]{0,300}?catch\s*\(err\)/,
    'saveBackupToDevice 里 copyIntoDir 的失败没有被 `catch (err)` 接住 —— 裸 catch 拿不到错误对象，' +
      '真机再出问题又只能靠反读库源码',
  );

  assert.match(
    saveBackupToDevice,
    /console\.warn\([\s\S]{0,200}err\)/,
    'saveBackupToDevice 的 catch 没有把错误对象打进日志',
  );
});

/* ==================== 4. 固定名必须真的固定 ==================== */

test('存进手机文件夹的名字里不能有日期（否则会按次往用户的文件夹堆全量包）', () => {
  const match = /const DEVICE_BACKUP_NAME = '([^']+)'/.exec(source);
  assert.ok(match, '找不到 DEVICE_BACKUP_NAME');

  const name = match[1];
  assert.equal(/\d/.test(name), false, `DEVICE_BACKUP_NAME("${name}") 里带了数字 —— 像是时间戳`);
  assert.ok(name.endsWith('.zip'), `DEVICE_BACKUP_NAME("${name}") 不是 .zip`);
});
