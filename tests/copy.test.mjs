/**
 * 界面文案 · 把两条原则钉成断言
 *
 * 2026-10-17 做了一轮全量文案精简（`docs/copy-plan.html`）：757 条 / 8,526 字 →
 * 760 条 / 7,403 字，破折号 13 处 → 0。但**文案会自己长回去** ——
 * 每次改功能顺手补一句解释、每次被用户问一句就加一个括注，
 * 半年后又变成一篇说明文，而且这件事**不报错**，没人会发现。
 *
 * 所以这里只钉两条最容易退回原样的：
 *   ① 单条文案不许 ≥ 40 字。13px 正文一行约 15～16 字，40 字＝两行半，
 *      超过它的句子用户在手机上会直接跳过。
 *   ② 字符串里不许出现「——」。它是说明文的写法，界面上要转折就断句。
 *
 * 口径：只收 `src/app` + `src/components` 的字符串字面量与 JSX 文本，
 * 外加 `lib/entitlement.ts`（它里面的文案会直接渲染）。**注释先剥掉** ——
 * 代码注释里的破折号是正常的书面语，不该被这条规则管。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const ROOTS = ['src/app', 'src/components'];
/** 会直接把文案渲染出去的非 UI 目录文件 */
const EXTRA = ['src/lib/entitlement.ts'];

/** 单条文案上限。见文件头注释 */
const MAX_CHARS = 40;
/** 例外条目放宽到这里，且必须逐条写明理由 */
const MAX_CHARS_EXEMPT = 60;
/**
 * 「免费档」在界面上的出现次数上限。它是「不买也不亏」这件事的唯一说法，说多了就成了啰嗦。
 *
 * ★ 这个数**等于 2026-10-17 精简后的实测值**，不预留余量：想再加一处，
 *   就得回来看这段注释、有意识地改这个数字 —— 那正是这条断言存在的意义。
 *   （上一版是 54 处，所以「加一处也无所谓」的余地不能给。）
 */
const MAX_FREE_TIER_MENTIONS = 10;

/**
 * 数「免费档」时的三种排除项 —— 它们不是「又一次承诺」，而是标签或别处的专有名词：
 *   ① 列头 `免费档`（对比表左边那一栏的表头）；
 *   ② 固定入口标签「免费档 vs 支持者档」（门控浮层、我的页、说明页各一处，同一个标签）；
 *   ③ 指**模型供应商**的免费额度（DeepSeek 那两家确实免费，与格物自己的档位无关）。
 * ★ 排除项写成具体模式而不是「某文件整页豁免」：整页豁免会把真正的复读一起放过去。
 */
const STRUCTURAL = [/^免费档$/, /免费档 vs 支持者档/, /这家有免费档/];
const TIER_MENTION = /免费档/;

const CJK = /[\u4e00-\u9fa5]/;
const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gs;
/**
 * JSX 文本。
 *
 * ★★ 这里**必须跨行**（`[^<>]+?` + `s` 标志）。上一版用的是 `[^<>{}\n]*`，
 *   于是「独占一行」的说明文字一条都扫不到 —— 实测漏了 142 条，
 *   其中 11 处破折号、20 条超 40 字，还有一句把 `见 ROADMAP 的口径记录`
 *   这样的开发者备注直接渲染给了用户。**扫描器漏检比没有扫描器更危险**：
 *   它会让「破折号 0 处」这种结论显得是查出来的。
 * ★ 代价是要排除代码：`=>`、比较运算、`;`、小括号都会命中 `>` 与 `<`。
 *   先把注释剥掉，再用 `CODEY` 把这些噪声挡在外面。
 */
const JSX_TEXT = />\s*([^<>]+?)\s*</gs;
const CODEY = /[;(){}]|=>|&&|\|\||===|!==/;

/** 双引号 / 单引号 / 反引号三种字面量都可能带转义，长度按**渲染后**的字算 */
function normalize(text) {
  return text.replace(/\$\{[\s\S]*?\}/g, '…').replace(/\s+/g, ' ').trim();
}

function stripComments(src) {
  const withoutBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlock.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${name.name}`;
    if (name.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(path);
  }
  return out;
}

const FILES = [...ROOTS.flatMap(walk), ...EXTRA];

/**
 * 例外：这些「长」是有理由的，`docs/copy-plan.html` § 5 逐条写过。
 *
 * ★ 刻意按**内容特征**匹配，不按文件或行号：按文件白名单等于给整页开后门，
 *   而 sheetBody 只要还是「一段替用户交代边界的话」就仍然该被豁免。
 */
function exemptionFor(text) {
  if (text.includes('不可撤销')) return '删除 / 导入确认：不可撤销是法律性表述，短了会有人真丢数据';
  if (text.includes('逐张入库') || text.includes('三种版式')) {
    return '门控浮层正文（sheetBody）：要一次讲清「多了什么」与「没少什么」';
  }
  return null;
}

function collect() {
  const rows = [];
  for (const path of FILES) {
    const raw = readFileSync(path, 'utf8');
    /* ★ 注释先剥、再取 JSX 文本：跨行匹配会把 `{/* … *\/}` 里的中文一起抓进来，
       而注释里的破折号与长句是正常的书面语，不该被这两条规则管 */
    const clean = stripComments(raw);
    if (path.endsWith('.tsx')) {
      for (const m of clean.matchAll(JSX_TEXT)) {
        const text = normalize(m[1]);
        if (!CJK.test(text) || CODEY.test(text)) continue;
        rows.push({ path, text, kind: 'jsx' });
      }
    }
    for (const m of clean.matchAll(STRING_LITERAL)) {
      const text = normalize(m[0].slice(1, -1));
      if (CJK.test(text)) rows.push({ path, text, kind: 'string' });
    }
  }
  return rows;
}

const ROWS = collect();

test('扫描器确实扫到了东西（口径失效时不许静默全绿）', () => {
  /* ★ 这条是兜底：正则被改动、目录改名、或 `.tsx` 里全是单引号字符串之外的写法时，
     上面两条断言会因为「一条都没扫到」而**无条件通过** —— 那比红更糟。 */
  assert.ok(ROWS.length > 500, `只扫到 ${ROWS.length} 条，扫描口径可疑`);
  assert.ok(
    new Set(ROWS.map((r) => r.path)).size > 30,
    `只覆盖了 ${new Set(ROWS.map((r) => r.path)).size} 个文件，扫描口径可疑`,
  );
  /* ★★ 单独守 JSX 文本那一路：把 `[^<>]+?` 换回 `[^<>{}\n]*`（不跨行）时，
     总量仍然过 500，前两条照旧全绿，只有下面这一条会响。
     实测不跨行会漏 142 条 —— 包括一句把「见 ROADMAP 的口径记录」渲染给用户的备注。 */
  const jsxRows = ROWS.filter((r) => r.kind === 'jsx').length;
  assert.ok(jsxRows > 140, `JSX 文本只扫到 ${jsxRows} 条，跨行匹配可能已经失效`);
});

test('★ 单条文案不超过 40 字（例外逐条登记，且例外本身也有上限）', () => {
  const long = ROWS.filter((r) => r.text.length > MAX_CHARS);
  const blocked = long.filter((r) => !exemptionFor(r.text));
  assert.deepEqual(
    blocked.map((r) => `${r.path} (${r.text.length} 字): ${r.text}`),
    [],
    `这些文案超过 ${MAX_CHARS} 字，在手机上要占三行以上，用户会直接跳过：\n` +
      '  改法：一句话只说一件事，拆成两行；「为什么这么设计」属于代码注释，不属于屏幕。',
  );

  for (const row of long) {
    assert.ok(
      row.text.length <= MAX_CHARS_EXEMPT,
      `${row.path} 的例外文案长到 ${row.text.length} 字，已经超出「讲清边界」所需：${row.text}`,
    );
  }

  /* 例外清单本身也要有下限：全被删光时说明上面的豁免规则已经和代码脱节 */
  assert.ok(long.length >= 2, '一条超长例外都没有，豁免规则可能已经失效');
});

test('★★ 字符串里不许出现破折号「——」（注释不算）', () => {
  const offenders = ROWS.filter((r) => r.text.includes('——'));
  assert.deepEqual(
    offenders.map((r) => `${r.path}: ${r.text}`),
    [],
    '「——」是说明文的写法：要转折就断句，要补充就删掉。代码注释里可以有，界面上不行。',
  );
});

test('★ 「免费档」在界面上不超过 10 处：这个承诺说过一次就够了', () => {
  /* 上一版 54 处，14 个文件里都在提醒同一件事 —— 用户被挡一次，只需要听一次。
     它真正该出现的地方只有三处：门控浮层、权益说明页、我的页那一行。 */
  const hits = ROWS.filter((r) => TIER_MENTION.test(r.text) && !STRUCTURAL.some((p) => p.test(r.text)));
  assert.ok(
    hits.length <= MAX_FREE_TIER_MENTIONS,
    `「免费档」出现了 ${hits.length} 处（上限 ${MAX_FREE_TIER_MENTIONS}）：\n  ` +
      hits.map((r) => `${r.path}: ${r.text.slice(0, 40)}`).join('\n  '),
  );
  /* 下限兜底：一条都不剩说明扫描口径坏了，而不是文案变好了 */
  assert.ok(hits.length >= 6, `只数到 ${hits.length} 处，扫描口径可疑`);
});
