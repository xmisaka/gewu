/**
 * 桌面小组件快照纯逻辑测试。
 *
 * 这一层的失败模式**全部是「不报错、数字或措辞悄悄不对」**：
 *   · 拍平顺序错了 → 桌面上第一行不是最要紧的那件，但看起来完全正常
 *   · 忘了跨组去重 → 同一件过期的酱油占掉两行，桌面只剩一格给别的
 *   · 「还有 N 件」把各分组条数直接相加 → 数字比用户点进去看到的行数大
 *   · 胶囊措辞自己另写一份 → 与 App 内不一致，且两边都「看着对」
 *   · 坏 JSON 没兜住 → widget 画出一块白板，看起来像应用坏了
 * 所以断言盯的是**具体文案、具体顺序、具体条数与色调**，不是「不为空」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildWidgetRows,
  buildWidgetSnapshot,
  parseWidgetSnapshot,
  WIDGET_MAX_ROWS,
  WIDGET_SNAPSHOT_VERSION,
  WIDGET_SNAPSHOT_FILE,
} = await import('../src/lib/widget/snapshot.ts');

const { widgetColorsOf } = await import('../src/lib/widget/palette.ts');

/** 造一件物品（只填快照用得到的字段，其余字段运行时用不上） */
function item(patch) {
  return {
    id: patch.id ?? patch.name ?? 'x',
    name: patch.name ?? '物品',
    quantity: patch.quantity ?? null,
    daysToExpiry: patch.daysToExpiry ?? null,
    daysToWarranty: patch.daysToWarranty ?? null,
    cabinetName: patch.cabinetName ?? null,
    locationName: patch.locationName ?? null,
  };
}

function group(key, items) {
  return { key, title: key, items };
}

const COLORS = {
  surface: '#FFFFFF',
  ink: '#2B241F',
  ink3: '#9A8D80',
  ink4: '#C9BEB0',
  line3: '#F1ECE4',
  brand: '#8C5A34',
  clay: '#AA523D',
  clayBg: '#F9EAE5',
  amber: '#926521',
  amberBg: '#FBF1DF',
};

function snapshot(patch) {
  return buildWidgetSnapshot({
    generatedAt: 1_700_000_000_000,
    themeId: 'sujian',
    colors: COLORS,
    attentionCount: 0,
    groups: [],
    totalItems: 0,
    nextExpiry: null,
    ...patch,
  });
}

/* ------------------------------------------------------------ 拍平与顺序 */

test('「更远」整组不进桌面', () => {
  const rows = buildWidgetRows([
    group('overdue', [item({ name: '布洛芬', daysToExpiry: -8 })]),
    group('later', [item({ name: '酱油', daysToExpiry: 200 })]),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '布洛芬');
});

test('按调用方给的组顺序拍平 —— 「该补货了」排在最前时它就是第一行', () => {
  const rows = buildWidgetRows([
    group('low', [item({ name: '鱼油', quantity: 1 })]),
    group('overdue', [item({ name: '洗手液', daysToExpiry: -4 })]),
    group('soon', [item({ name: '感冒灵', daysToExpiry: 12 })]),
  ]);

  assert.deepEqual(
    rows.map((r) => r.name),
    ['鱼油', '洗手液', '感冒灵'],
  );
});

test('快照最多备 WIDGET_MAX_ROWS 条 —— 超出的不丢，由页脚那句「还有 N 件」交代', () => {
  /* ★ 这里测的是**备货上限**，不是「桌面上显示几行」。
     卡片可以长按拖动改尺寸，显示几行由原生按实际高度算
     （`GewuWidgetRender.rowsThatFit`），所以快照必须备足
     「拉到最高时可能用到」的行数，否则拉大了也没东西可画。 */
  const many = Array.from({ length: 12 }, (_, i) =>
    item({ name: `第${i + 1}件`, daysToExpiry: -12 + i }),
  );

  assert.equal(buildWidgetRows([group('overdue', many)]).length, WIDGET_MAX_ROWS);

  const snap = snapshot({ groups: [group('overdue', many)], attentionCount: 12 });
  assert.equal(snap.rows.length, WIDGET_MAX_ROWS, '快照必须备满行数上限');
  assert.equal(snap.rows[0].name, '第1件', '排序仍是「最要紧的在最前」');
});

test('跨组去重：同一件同时「已过期」又「剩 1」时，桌面上只占一行', () => {
  /* 这正是提醒页与桌面的**故意差异**：提醒页要在两个语境里都列出它，
     而桌面只有三格，同一件东西占两行是纯浪费。
     渲染用**先出现的组**（低库存组排最前），所以它以余量的样子出现。 */
  const rows = buildWidgetRows([
    group('low', [item({ name: '酱油', quantity: 0, daysToExpiry: -3 })]),
    group('overdue', [item({ name: '酱油', quantity: 0, daysToExpiry: -3 })]),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].statusText, '用完了');
});

/* ------------------------------------------------------------ 文案与色调 */

test('到期组的胶囊用 describeExpiryTag 的措辞，不是 describeRemaining 的', () => {
  const rows = buildWidgetRows([
    group('overdue', [item({ name: '布洛芬', daysToExpiry: -8 })]),
    group('soon', [item({ name: '感冒灵', daysToExpiry: 6 })]),
  ]);

  /* ★ 「过期 8 天」而不是「已过期 8 天」、「6 天后到期」而不是「还剩 6 天」——
     这两句必须与列表行完全一致，改错了不会报错，只会让桌面与 App 说法不同 */
  assert.equal(rows[0].statusText, '过期 8 天');
  assert.equal(rows[1].statusText, '6 天后到期');
});

test('今天到期与到期当天的话术', () => {
  const rows = buildWidgetRows([group('soon', [item({ name: '酸奶', daysToExpiry: 0 })])]);
  assert.equal(rows[0].statusText, '今天到期');
});

test('色调：已过期/用完了是砖红，将到期/将见底是琥珀', () => {
  /* 显式放宽行数上限：这一条测的是**色调映射**，不是截断 ——
     用默认的 3 行会让第 4 件被截掉，然后断言失败的样子看起来像色调算错了 */
  const rows = buildWidgetRows(
    [
      group('low', [
        item({ name: '用完的', quantity: 0 }),
        item({ name: '见底的', quantity: 1 }),
      ]),
      group('overdue', [item({ name: '过期了', daysToExpiry: -2 })]),
      group('soon', [item({ name: '快到了', daysToExpiry: 5 })]),
    ],
    10,
  );

  assert.deepEqual(
    rows.map((r) => r.tone),
    ['clay', 'amber', 'clay', 'amber'],
  );
});

test('补货组的胶囊说余量，不说剩几天', () => {
  const rows = buildWidgetRows([
    group('low', [item({ name: '鱼油', quantity: 1, daysToExpiry: 6 })]),
  ]);

  /* 它同时快到期又说得出余量，但在「该补货了」这一组里，重点是**余量**
     （这一组的名字就是这个意思）。天数留给点进去以后的详情页。 */
  assert.equal(rows[0].statusText, '剩 1');
});

test('保修组的胶囊说**保修**，绝不能说成「N 天后到期」', () => {
  /* ★ 这一条守的是最容易犯的那个错：保修与保质期共用一套分组 UI，
     顺手把 `describeExpiryTag` 用上去不会报错 —— 只会让桌面上写着
     「6 天后到期」，而用户去处理时发现保质期其实还早得很。
     注意这件的 daysToExpiry 是 null（压根没填保质期）：真串了的话，
     胶囊会变成空串，那是更隐蔽的一种错。 */
  const rows = buildWidgetRows([group('warranty', [item({ name: '电水壶', daysToWarranty: 6 })])]);

  assert.equal(rows[0].statusText, '保修还剩 6 天');
  assert.equal(rows[0].tone, 'amber', '界面稿定的：复用琥珀，不新增色');
});

test('保修组排到最后时，桌面那几行仍按组顺序走', () => {
  const rows = buildWidgetRows([
    group('overdue', [item({ name: '布洛芬', daysToExpiry: -3 })]),
    group('warranty', [item({ name: '电水壶', daysToWarranty: 6 })]),
  ]);

  assert.deepEqual(
    rows.map((r) => r.name),
    ['布洛芬', '电水壶'],
  );
});

/* ------------------------------------------------------------ 位置短语 */

test('位置短语柜子名与格位名相同时只说一次', () => {
  const rows = buildWidgetRows([
    group('overdue', [
      item({ name: 'A', daysToExpiry: -1, cabinetName: '药箱', locationName: '药箱' }),
      item({ name: 'B', daysToExpiry: -1, cabinetName: '厨房吊柜', locationName: '第三层' }),
      item({ name: 'C', daysToExpiry: -1 }),
    ]),
  ]);

  assert.equal(rows[0].place, '药箱');
  assert.equal(rows[1].place, '厨房吊柜 第三层');
  assert.equal(rows[2].place, null);
});

/* ------------------------------------------------------------ 「还有 N 件」 */

test('页脚那句的「还有 N 件」用去重后的总数减**实际画出来的行数**', () => {
  /* 3 件东西、5 个分组条目（酱油在两处出现）。
     attentionCount 是**去重口径**（与标签栏角标一致）= 3。
     画满 3 行时应该是「还有 0 件」；把分组条数相加会算出 5 − 3 = 2。 */
  const groups = [
    group('low', [item({ name: '酱油', quantity: 0 })]),
    group('overdue', [item({ name: '酱油', quantity: 0 }), item({ name: '洗手液', daysToExpiry: -4 })]),
    group('soon', [item({ name: '感冒灵', daysToExpiry: 9 })]),
  ];

  const snap = snapshot({ groups, attentionCount: 3 });

  assert.deepEqual(
    snap.rows.map((r) => r.name),
    ['酱油', '洗手液', '感冒灵'],
  );
  assert.match(snap.footLeftByShownToday[3], /^还有 0 件 · /);
});

test('「还有 N 件」不会算成负数（数据在两查之间变动时也不能写出「还有 -1 件」）', () => {
  /* 原生取的**下标**是它自己算出来的行数，可能比快照里的行数大
     （用户把卡片拉得很高、而期间数据被删掉了几件）。
     那些档位也必须是一句说得通的句子 —— 写出「还有 -2 件」不会报错，
     只会在桌面上静静显示一个荒谬的数字。 */
  const groups = [group('overdue', [item({ name: 'A', daysToExpiry: -1 })])];
  const snap = snapshot({ groups, attentionCount: 0 });

  assert.equal(snap.footLeftByShownToday.length, WIDGET_MAX_ROWS + 1);
  for (const line of snap.footLeftByShownToday) {
    assert.match(line, /^还有 \d+ 件 · /, `出现了负数或畸形句子：${line}`);
  }
});

/* ------------------------------------------------------------ 整份快照 */

test('快照带上版本、时刻、主题与色值 —— 原生侧不做任何判断', () => {
  const snap = snapshot({ attentionCount: 2, totalItems: 31 });

  assert.equal(snap.v, WIDGET_SNAPSHOT_VERSION);
  assert.equal(snap.generatedAt, 1_700_000_000_000);
  assert.equal(snap.themeId, 'sujian');
  assert.equal(snap.colors.clay, '#AA523D');
  assert.equal(snap.totalItems, 31);
  assert.equal(snap.attentionCount, 2);
  assert.equal(WIDGET_SNAPSHOT_FILE, 'widget-snapshot.json');
});

/* ------------------------------------------------ 文案在 JS 拼完（原生零拼接） */

test('正常态的页脚是**整句**，含分隔符 —— 同日/隔日两套、每一档都在', () => {
  const snap = snapshot({
    groups: [group('overdue', [item({ name: 'A', daysToExpiry: -1 })])],
    attentionCount: 1,
  });

  /* ★ 断言的是完整句式而不是「包含『还有 1 件』」：
     原生侧只做 setText，它拿到什么就显示什么。少一个「 · 」、
     或者把「还有」写成「剩余」，都不会报错，只会在桌面上显示一句
     与 App 内不一致的话。这里把整句形状钉死。 */
  assert.equal(snap.footLeftByShownToday.length, WIDGET_MAX_ROWS + 1);
  assert.equal(snap.footLeftByShownDated.length, WIDGET_MAX_ROWS + 1);

  assert.match(snap.footLeftByShownToday[1], /^还有 0 件 · 截至今天 \d{2}:\d{2}$/);
  assert.match(snap.footLeftByShownDated[1], /^还有 0 件 · 截至 \d+ 月 \d+ 日 \d{2}:\d{2}$/);

  /* ★★ 这一条是本次改动的**核心断言**：下标 = 卡片上实际画出来的行数，
     所以第 k 档的 N 必须是「去重总数 − k」。
     写反了（比如每一档都等于总数）不会报错 —— 桌面上会一直写着
     「还有 1 件」，而下面明明画了三行。卡片拉高一行、这个数就该减一。 */
  for (let shown = 0; shown <= WIDGET_MAX_ROWS; shown += 1) {
    assert.match(
      snap.footLeftByShownToday[shown],
      new RegExp(`^还有 ${Math.max(0, 1 - shown)} 件 · `),
      `第 ${shown} 档的「还有 N 件」算错了`,
    );
  }
});

test('时间戳不许在生成时写死「今天」—— 隔日版本必须自带绝对日期', () => {
  /* 注意要有待办：空态的页脚两个版本都是空串（那一格让给「下一件」），
     拿空库来测这一条会「通过」得毫无意义 */
  const snap = snapshot({
    groups: [group('overdue', [item({ name: 'A', daysToExpiry: -1 })])],
    attentionCount: 1,
  });
  /* 快照会在磁盘上躺到明天，那时「今天」就是假话。
     两个版本的分工：Today 用词，Dated 用绝对日期。 */
  assert.notEqual(snap.footLeftByShownToday[1], snap.footLeftByShownDated[1]);
  assert.match(snap.stampToday, /^截至今天 \d{2}:\d{2}$/);
  assert.match(snap.stampDated, /^截至 \d+ 月 \d+ 日 \d{2}:\d{2}$/);
});

test('空态用的两句话与正常态不共用槽位 —— 页脚左句为空，改由「下一件」占位', () => {
  const snap = snapshot({
    attentionCount: 0,
    totalItems: 31,
    nextExpiry: { itemId: 'm1', name: '感冒灵颗粒', date: '2026-11-03', days: 20 },
  });

  assert.equal(snap.countLabel, '0 件');
  assert.equal(snap.emptyLead, '都还好，没有要处理的');
  assert.equal(snap.emptySub, '在看着 31 件 · 30 天内没有要到期的');
  assert.match(snap.emptyNext, /^下一件 · 感冒灵颗粒 · \d+ 月 \d+ 日$/);
  /* 空态不画「还有 N 件」—— 那会与主句「都还好」互相打脸。
     ★ 整条分档数组都是空串：空态下卡片不管被拉到多高，页脚那一格都该是空的
       （那一格让给「下一件」）。只清一档、漏了其余档位不会报错，
       只会在用户把卡片拉高之后突然冒出一句「还有 0 件」。 */
  assert.deepEqual(snap.footLeftByShownToday, new Array(WIDGET_MAX_ROWS + 1).fill(''));
  assert.deepEqual(snap.footLeftByShownDated, new Array(WIDGET_MAX_ROWS + 1).fill(''));
  /* 但时间戳照常带着：空态也要能看出这是哪一刻的数据 */
  assert.match(snap.stampToday, /^截至今天 \d{2}:\d{2}$/);
});

test('一件保质期都没录过时，空态副句换成「怎么才有用」而不是报一个 30 天', () => {
  const snap = snapshot({ attentionCount: 0, totalItems: 7, nextExpiry: null });

  assert.equal(snap.emptySub, '在看着 7 件 · 录入时填上保质期，这里就有用了');
  assert.equal(snap.emptyNext, '');
});

test('正常态的 countLabel 与角标同口径（去重后的件数），不是行数', () => {
  /* 5 个分组条目、3 件东西 → 角标 3，桌面上写「共 3 件」而不是「共 5 件」 */
  const groups = [
    group('low', [item({ name: '酱油', quantity: 0 })]),
    group('overdue', [item({ name: '酱油', quantity: 0 }), item({ name: '洗手液', daysToExpiry: -4 })]),
    group('soon', [item({ name: '感冒灵', daysToExpiry: 9 })]),
  ];
  const snap = snapshot({ groups, attentionCount: 3 });

  assert.equal(snap.countLabel, '共 3 件');
  assert.equal(snap.attentionCount, 3);
  assert.equal(snap.rows.length, 3);
});

test('原始数字照带一份，供「说 22 件却只画了 3 行」这类反馈先分诊', () => {
  /* 上屏的是 countLabel，但原始 attentionCount 与 rows 也带着 ——
     用来分辨「取数没取全」还是「取全了但只画了几行」，两种修法完全不同。
     ★ 2026-10-14 那次真机反馈（「22 条待办只显示 3 条」）
       就是靠这一对数字先排除了「数据没查全」：
       attentionCount=22 而 rows.length 顶到上限，说明取数是好的，
       问题在渲染层把行数写死了。 */
  const groups = [
    group(
      'overdue',
      Array.from({ length: 22 }, (_, i) => item({ name: `第${i + 1}件`, daysToExpiry: -22 + i })),
    ),
  ];
  const snap = snapshot({ groups, attentionCount: 22, totalItems: 40 });

  assert.equal(snap.countLabel, '共 22 件');
  assert.equal(snap.rows.length, WIDGET_MAX_ROWS, '备货必须够拉到最高时用');
  assert.equal(snap.attentionCount, 22);
  assert.equal(snap.totalItems, 40);
});

/* ------------------------------------------------------------ 调色板映射 */

test('widget 用色从主题令牌原样搬过来，不做任何推导', () => {
  /* 造一份「七套主题里随便一套」的令牌。这里只需要被用到的那 10 个，
     但真令牌是 27 个 —— 多出来的部分不该影响映射结果。 */
  const tokens = {
    ...COLORS,
    paper: '#F7F4EF',
    canvas: '#FBF9F6',
    inset: '#F2EDE5',
    ink2: '#6B6055',
    line: '#E3DCD1',
    line2: '#EBE5DB',
    sage: '#5F7355',
    sageBg: '#EDF1E9',
    brandDeep: '#6B4224',
    brandBg: '#F3E9DE',
  };

  const colors = widgetColorsOf(tokens);

  assert.deepEqual(colors, COLORS);
  /* 语义色不许跟着品牌色走：brand 是暖棕，clay 依旧是砖红 */
  assert.equal(colors.clay, '#AA523D');
  assert.notEqual(colors.clay, colors.brand);
});

test('映射只带 widget 真正用得到的那 10 个色值，一个不多', () => {
  /* 多带一个色值不是「顺便」而是负担：它会被写进磁盘上的快照、
     躺到下一次刷新，而没有任何东西会读它 —— 将来主题改名时
     这个僵尸字段不会报错，只会静默留在 JSON 里。 */
  const colors = widgetColorsOf({ ...COLORS, paper: '#000', inset: '#111' });
  assert.deepEqual(Object.keys(colors).sort(), Object.keys(COLORS).sort());
});

test('空态：没有任何待办时 rows 为空，但总数与下一个到期日照常带着', () => {
  const snap = snapshot({
    groups: [group('overdue', []), group('soon', []), group('later', [item({ name: '酱油', daysToExpiry: 90 })])],
    attentionCount: 0,
    totalItems: 31,
    nextExpiry: { itemId: 'm1', name: '感冒灵颗粒', date: '2026-11-03', days: 20 },
  });

  assert.deepEqual(snap.rows, []);
  assert.equal(snap.totalItems, 31);
  assert.equal(snap.nextExpiry.name, '感冒灵颗粒');
  assert.equal(snap.nextExpiry.days, 20);
});

/* ------------------------------------------------------------ 解析兜底 */

test('坏快照一律当成「还没有」—— 绝不能让 widget 画出一块白板', () => {
  assert.equal(parseWidgetSnapshot(null), null);
  assert.equal(parseWidgetSnapshot(''), null);
  assert.equal(parseWidgetSnapshot('{截断的'), null);
  assert.equal(parseWidgetSnapshot('[]'), null);
  assert.equal(parseWidgetSnapshot('null'), null);

  /* ★★ 下面每一份残件都从**一份正常的快照**改出来，绝不手写字面量版本号。
     2026-10-14 踩过一次：这些断言原本写的是 `{ v: 1, ... }`，
     而版本号正好升到了 2 —— 于是它们全部被「版本对不上」那一条拦下，
     **仍然全绿，但测的东西已经悄悄变了**（在测版本检查，而不是字段校验）。
     这类失效没有症状，只有下一次真出问题时不报警。 */
  const good = snapshot({ attentionCount: 2, totalItems: 5, groups: [] });

  /* 版本对不上：格式改了两侧必须同版本发布，不做兼容 */
  assert.equal(parseWidgetSnapshot(JSON.stringify({ ...good, v: 99 })), null);
  /* 缺了 rows / colors 的残件同样拒收（`undefined` 会被 JSON 直接丢掉键） */
  assert.equal(parseWidgetSnapshot(JSON.stringify({ ...good, rows: undefined })), null);
  assert.equal(parseWidgetSnapshot(JSON.stringify({ ...good, colors: undefined })), null);

  /* ★ 其余字段都在，但**文案字段缺了** —— 也要拒收。
     这种残件最像「坏得刚刚好」：原生拿不到 countLabel 就会 setText(null)，
     桌面上会出现一行空白，看起来像样式出错，而其实是这一份文件没写完。
     宁可整块退回「还没有快照」的提示态，也不要画一半。 */
  for (const key of ['countLabel', 'emptyLead', 'emptySub', 'emptyNext', 'stampToday', 'stampDated']) {
    const broken = { ...good };
    delete broken[key];
    assert.equal(parseWidgetSnapshot(JSON.stringify(broken)), null, `缺了 ${key} 竟然被收下了`);
  }

  /* ★★ 页脚分档数组的三类坏法，逐条钉住：
     · 字段缺了     → 原生一档都取不到，页脚空一格
     · 空数组       → 同上，而且「长度存在」会让它看起来像好的
     · 混进非字符串 → Kotlin 侧 setText 收到一个空值，同样是页脚空一格
     三种都不抛异常，只让桌面上少一句话 —— 看起来像排版坏了。 */
  for (const key of ['footLeftByShownToday', 'footLeftByShownDated']) {
    const missing = { ...good };
    delete missing[key];
    assert.equal(parseWidgetSnapshot(JSON.stringify(missing)), null, `${key} 缺了竟然被收下`);
    assert.equal(parseWidgetSnapshot(JSON.stringify({ ...good, [key]: [] })), null, `${key} 是空数组竟然被收下`);
    assert.equal(
      parseWidgetSnapshot(JSON.stringify({ ...good, [key]: ['还有 2 件 · 截至今天 09:12', 42] })),
      null,
      `${key} 里混进了非字符串竟然被收下`,
    );
    /* 反面必须配正面：正常的那一份要读得回来，
       否则上面三条只是在测一个永远返回 null 的函数 */
    assert.notEqual(parseWidgetSnapshot(JSON.stringify(good)), null, `${key} 正常却读不回来`);
  }

  /* ★ 但**不能**要求 nextExpiry 存在 —— 库里一件带保质期的都没有是完全正常的，
     那种快照必须能读回来，否则空库用户的 widget 永远白屏。 */
  const noExpiry = snapshot({ totalItems: 3 });
  assert.equal(noExpiry.nextExpiry, null);
  assert.notEqual(parseWidgetSnapshot(JSON.stringify(noExpiry)), null);
});

test('正常快照能原样读回来', () => {
  const snap = snapshot({
    groups: [group('overdue', [item({ name: '布洛芬', daysToExpiry: -8 })])],
    attentionCount: 1,
    totalItems: 31,
  });

  const back = parseWidgetSnapshot(JSON.stringify(snap));
  assert.deepEqual(back, snap);
});
