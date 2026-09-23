#!/usr/bin/env node
/**
 * 格物 · 主题与样式守护脚本
 *
 * 两条规则，都是「漏了不报错、但界面会悄悄坏掉」的那一类：
 *
 *   1. 色值只能来自 src/constants/theme.ts
 *      硬编码色值不会让 tsc 报错，但换肤时那一处不会跟着变 ——
 *      在四套浅色主题下就是一块刺眼的、不属于任何主题的颜色。
 *
 *   2. 定义了 makeStyles 的文件必须调用 useStyles()
 *      漏了同样不报错，只是那个组件永远停在某个主题上。
 *
 * 例外用行内注释 `theme-color-ok` 显式豁免（例如 'transparent' 这类
 * 不携带颜色语义的占位值），豁免必须写出来，不能靠脚本猜。
 *
 * 用法：node tools/audit-theme-colors.mjs
 * 退出码：0 = 干净，1 = 有违例
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, posix, relative, sep } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/** 主题表的唯一定义处，允许出现色值（统一用正斜杠比较，避开 Windows 的反斜杠） */
const COLOR_SOURCE = 'src/constants/theme.ts';

/** 形如 #rgb / #rrggbb / #rrggbbaa，或 rgb()/rgba()/hsl()/hsla() 函数式写法 */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/;

/** 豁免标记 */
const ESCAPE = 'theme-color-ok';

/** 需要排除的路径片段（构建产物、备份等） */
const SKIP_DIRS = new Set(['node_modules', '.expo', 'android', 'ios', 'build', '.git']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 相对工程根、统一用正斜杠，便于跨平台输出与比较 */
function rel(full) {
  return relative(ROOT, full).split(sep).join(posix.sep);
}

const problems = [];

for (const file of walk(SRC)) {
  const path = rel(file);
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  /* ---- 规则 1：色值来源 ---- */
  if (path !== COLOR_SOURCE) {
    lines.forEach((line, i) => {
      if (!COLOR_LITERAL.test(line)) return;
      if (line.includes(ESCAPE)) return;
      // 注释里提到色值不算违例（文档常常要举例说明改了什么）
      const code = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
      if (!COLOR_LITERAL.test(code)) return;
      problems.push({
        rule: 'hardcoded-color',
        path,
        line: i + 1,
        detail: line.trim(),
      });
    });
  }

  /* ---- 规则 2：makeStyles 必须配 useStyles() ---- */
  const definesStyles = /\bmakeStyles\s*\(/.test(text);
  const usesStyles = /\buseStyles\s*\(\s*\)/.test(text);
  if (definesStyles && !usesStyles) {
    problems.push({
      rule: 'missing-useStyles',
      path,
      line: lines.findIndex((l) => /\bmakeStyles\s*\(/.test(l)) + 1,
      detail: '定义了 makeStyles 却没有调用 useStyles()，该组件不会换肤',
    });
  }
}

if (problems.length === 0) {
  console.log('主题守护：通过（无硬编码色值，makeStyles 均已配对 useStyles()）');
  process.exit(0);
}

const byRule = new Map();
for (const p of problems) {
  if (!byRule.has(p.rule)) byRule.set(p.rule, []);
  byRule.get(p.rule).push(p);
}

const TITLE = {
  'hardcoded-color': '硬编码色值（应改从 theme.ts 取令牌）',
  'missing-useStyles': 'makeStyles 未配 useStyles()',
};

console.error('主题守护：发现 ' + problems.length + ' 处问题\n');
for (const [rule, list] of byRule) {
  console.error(`【${TITLE[rule] ?? rule}】`);
  for (const p of list) console.error(`  ${p.path}:${p.line}\n    ${p.detail}`);
  console.error('');
}
console.error(`如需豁免，在行尾加注释 ${ESCAPE}（仅在确实不携带颜色语义时使用）。`);
process.exit(1);
