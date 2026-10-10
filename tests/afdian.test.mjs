/**
 * 爱发电码池工具链（tools/license-batch.mjs + tools/afdian-stock.mjs）的测试。
 *
 * 覆盖三件事：
 *   ① 标识命名与批次文件：签出来的东西能拼回去、能查重、不落进 git 仓库；
 *   ② 签名与对账的判定规则：官方样例向量、池子去重、件数统计、四种异常形态；
 *   ③ status / restock / who 三条命令**整条链子**跑穿 —— 网络走 setTransport 换的假传输层，
 *      于是「拼请求 → 拆响应 → 对账 → 追加」全程离线、确定、可重复。
 *      ★ 追加那条尤其要测：它是唯一会改线上状态的路径，只能传 append，永远不许 overwrite。
 *
 * ★ 隔离闸：license.mjs 的 HOME_DIR 是**模块加载时**求值的常量，
 *   所以 GEWU_LICENSE_DIR 必须在 import 之前设好。设晚了不会报错，
 *   只会安静地对着真实的 ~/.gewu 跑测试 —— 那是不可逆的污染（会往真台账里塞码）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gewu-afdian-'));
process.env.GEWU_LICENSE_DIR = TMP_ROOT;

const license = await import('../tools/license.mjs');
const batch = await import('../tools/license-batch.mjs');
const stock = await import('../tools/afdian-stock.mjs');

const KEYPAIR = license.makeKeypair();
const FOREIGN_KEYPAIR = license.makeKeypair();
const BATCH_DIR = path.join(TMP_ROOT, 'batches');

/** 官方文档里的样例（token 123 / params {"a":333} / ts 1624339905 / user_id abc）。 */
const DOC_TOKEN = '123';
const DOC_TS = 1624339905;
const DOC_UID = 'abc';

before(() => {
  license.ensureHomeDir();
  fs.writeFileSync(
    license.KEY_FILE,
    JSON.stringify(
      {
        v: 1,
        createdAt: '2026-10-10T00:00:00.000Z',
        publicKey: KEYPAIR.publicKeyB64Url,
        privateJwk: KEYPAIR.privateJwk,
      },
      null,
      2,
    ),
  );
});

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/* ==================== 夹具 ==================== */

function code(subject, seq, date = '2026-10-10', keypair = KEYPAIR) {
  return license.buildCode(license.encodePayload({ subject, date, seq }), keypair.privateJwk);
}

async function capture(fn) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;

  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  process.exitCode = 0;

  try {
    await fn();
    return { output: lines.join('\n'), exitCode: process.exitCode ?? 0 };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
}

/** 假爱发电：把请求路径、参数、请求体都记下来，行为由传入的池子/订单决定。 */
function fakeApi({ poolText = '', orders = [], planId = 'PLAN', skuId = 'SKU', failOn = null } = {}) {
  const calls = [];
  const state = { poolText };

  const handler = async (url, body) => {
    const pathname = new URL(url).pathname;
    const params = JSON.parse(body.params);
    calls.push({ pathname, params, body });

    if (failOn && pathname === failOn) return JSON.stringify({ ec: 400005, em: 'sign validation failed', data: {} });

    switch (pathname) {
      case '/api/open/ping':
        return JSON.stringify({ ec: 200, em: 'pong', data: { uid: body.user_id } });
      case '/api/open/query-plan':
        return JSON.stringify({
          ec: 200,
          em: '',
          data: {
            plan: {
              plan_id: planId,
              name: '格物 · 支持者',
              product_type: 1,
              skus: [{ sku_id: skuId, name: '格物 App（全功能）', reply_random_content: state.poolText }],
            },
          },
        });
      case '/api/open/query-order': {
        const perPage = Number(params.per_page) || 50;
        const page = Number(params.page) || 1;
        const slice = orders.slice((page - 1) * perPage, page * perPage);
        return JSON.stringify({
          ec: 200,
          em: '',
          data: {
            list: slice,
            total_count: orders.length,
            total_page: Math.max(1, Math.ceil(orders.length / perPage)),
          },
        });
      }
      case '/api/open/query-random-reply':
        return JSON.stringify({
          ec: 200,
          em: 'success',
          data: { list: state.replies ?? [] },
        });
      case '/api/open/update-plan-reply':
        state.poolText = `${state.poolText}\n${params.auto_random_reply ?? ''}`;
        return JSON.stringify({ ec: 200, em: '', data: {} });
      default:
        return JSON.stringify({ ec: 404, em: `no such api: ${pathname}`, data: {} });
    }
  };

  return { handler, calls, state };
}

function paidOrder(outTradeNo, { skuId = 'SKU', count = 1, planId = 'PLAN', status = 2 } = {}) {
  return {
    out_trade_no: outTradeNo,
    plan_id: planId,
    status,
    total_amount: '36.00',
    sku_detail: [{ sku_id: skuId, count, name: '格物 App' }],
  };
}

const CONFIG = {
  userId: DOC_UID,
  token: DOC_TOKEN,
  planId: 'PLAN',
  skuId: 'SKU',
  channel: 'afdian',
  price: '36',
  lowWater: 10,
  restockSize: 50,
  file: path.join(TMP_ROOT, 'afdian.json'),
};

/** 签一批码（走真命令），返回清单里的码。 */
async function issueBatch(batchName, count, { dir = BATCH_DIR, date = '2026-10-10' } = {}) {
  const result = await capture(() =>
    batch.cmdIssue({ count: String(count), batch: batchName, channel: 'afdian', 'out-dir': dir, date }),
  );
  assert.equal(result.exitCode, 0, result.output);
  const manifest = batch.listManifests(dir).find((m) => m.batch === batchName);
  assert.ok(manifest, `批次 ${batchName} 没落盘`);
  return manifest;
}

/* ==================== 签名 ==================== */

test('签名：对得上官方文档给的样例向量', () => {
  assert.equal(stock.afdianSign(DOC_TOKEN, '{"a":333}', DOC_TS, DOC_UID), 'a4acc28b81598b7e5d84ebdc3e91710c');
});

test('签名：params 原串参与签名，token 只签不传', () => {
  const body = stock.signedBody({ token: 'super-secret-token', userId: DOC_UID, params: { page: 1 }, ts: DOC_TS });

  assert.deepEqual(Object.keys(body).sort(), ['params', 'sign', 'ts', 'user_id']);
  assert.equal(body.params, '{"page":1}');
  // token 一旦混进请求体，就等于把它交给了链路上的每一跳
  assert.ok(!JSON.stringify(body).includes('super-secret-token'));
  assert.equal(body.sign, stock.afdianSign('super-secret-token', body.params, body.ts, body.user_id));
});

test('签名：params 键序变了，签名必须跟着变（签名覆盖的是那一串字节）', () => {
  const a = stock.signedBody({ token: DOC_TOKEN, userId: DOC_UID, params: { page: 1, per_page: 100 }, ts: DOC_TS });
  const b = stock.signedBody({ token: DOC_TOKEN, userId: DOC_UID, params: { per_page: 100, page: 1 }, ts: DOC_TS });
  assert.notEqual(a.sign, b.sign);
  // 但签名与它自己那串 params 永远自洽 —— 这正是「只序列化一次」要保住的
  assert.equal(a.sign, stock.afdianSign(DOC_TOKEN, a.params, DOC_TS, DOC_UID));
  assert.equal(b.sign, stock.afdianSign(DOC_TOKEN, b.params, DOC_TS, DOC_UID));
});

test('响应信封：ec 不等于 200 一律当失败，不静默当空数据', () => {
  assert.equal(stock.readEnvelope('{"ec":200,"em":"","data":{"list":[]}}').ok, true);
  assert.equal(stock.readEnvelope('{"ec":400005,"em":"sign validation failed"}').ok, false);
  assert.equal(stock.readEnvelope('<html>502</html>').reason, 'not-json');
  assert.match(stock.explainEc(400005), /签名/);
  assert.match(stock.explainEc(400002), /ts 过期|时钟/);
});

/* ==================== 标识与批次文件 ==================== */

test('标识：宽度、零填充、往返解析', () => {
  assert.equal(batch.indexWidth(50), 3);
  assert.equal(batch.indexWidth(1), 3);
  assert.equal(batch.indexWidth(1200), 4);

  assert.equal(batch.formatSubject({ channel: 'afdian', batch: '20261010', index: 7, width: 3 }), 'afdian-20261010-007');
  assert.deepEqual(batch.parseSubject('afdian-20261010-007'), {
    channel: 'afdian',
    batch: '20261010',
    index: 7,
    padded: '007',
  });
  // 老写法（渠道-订单尾号）不硬凑成批次
  assert.equal(batch.parseSubject('afdian-8871'), null);
  assert.equal(batch.parseSubject(''), null);
});

test('标识：渠道名与批次名的字符集先挡住，别让非法字符写进码里', () => {
  assert.equal(batch.validateNaming('afdian', '20261010'), null);
  assert.equal(batch.validateNaming('xhs', 'B1'), null);
  assert.match(batch.validateNaming('afdian-x', '20261010'), /渠道名不合法/);
  assert.match(batch.validateNaming('afdian', '2026-10-10'), /批次名不合法/);
  assert.match(batch.validateNaming('', '20261010'), /渠道名不合法/);
});

test('规划：标识按批次连续、零填充宽度一致', () => {
  const subjects = batch.planSubjects({ count: 3, channel: 'afdian', batch: 'B9', startIndex: 1 });
  assert.deepEqual(subjects, ['afdian-B9-001', 'afdian-B9-002', 'afdian-B9-003']);
});

test('签发：落两个文件、写台账、每枚都能验签', async () => {
  const manifest = await issueBatch('T1', 5);

  assert.equal(manifest.count, 5);
  assert.equal(manifest.fromSerial, 1);
  assert.equal(manifest.toSerial, 5);
  assert.equal(manifest.codes.length, 5);

  const paths = batch.batchPaths(BATCH_DIR, 'afdian', 'T1');
  const text = fs.readFileSync(paths.codesFile, 'utf8');
  assert.ok(text.endsWith('\n'), '码文件要以换行收尾，粘进爱发电不会有半行');
  assert.equal(text.split('\n').filter(Boolean).length, 5);

  // 每枚都验签通过，且标识是 afdian-T1-00x
  for (const code of manifest.codes) {
    const result = license.verifyCode(code, KEYPAIR.publicKeyB64Url);
    assert.equal(result.ok, true, `验签失败：${code}`);
    assert.equal(result.payload.e.startsWith('afdian-T1-'), true);
  }

  // 台账里是 5 条独立记录，而不是一条「某人买了 5 个」
  const entries = license.readLedger().filter((entry) => entry.e.startsWith('afdian-T1-'));
  assert.deepEqual(
    entries.map((entry) => entry.e),
    ['afdian-T1-001', 'afdian-T1-002', 'afdian-T1-003', 'afdian-T1-004', 'afdian-T1-005'],
  );
});

test('签发：同名批次拒绝重签，--force 才放行', async () => {
  const refused = await capture(() =>
    batch.cmdIssue({ count: '5', batch: 'T1', channel: 'afdian', 'out-dir': BATCH_DIR }),
  );
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, /已经签过了/);

  const forced = await capture(() =>
    batch.cmdIssue({ count: '2', batch: 'T1', channel: 'afdian', 'out-dir': BATCH_DIR, force: true, date: '2026-10-11' }),
  );
  assert.equal(forced.exitCode, 0, forced.output);
  // 序号接着台账往下排，不回头覆盖
  assert.match(forced.output, /已签发 2 枚/);
});

test('签发：拒绝对着 git 仓库写码（码就是钱，提交了就进历史）', async () => {
  const repo = path.join(TMP_ROOT, 'gitrepo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.equal(batch.findGitRoot(repo), repo);

  const result = await capture(() =>
    batch.cmdIssue({ count: '1', batch: 'T2', channel: 'afdian', 'out-dir': repo }),
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /拒绝把激活码写进 git 仓库/);
  assert.equal(fs.existsSync(path.join(repo, 'codes-afdian-T2.txt')), false);
});

test('签发：--dry-run 不落盘、不写台账，也不需要私钥', async () => {
  const before = license.readLedger().length;
  const result = await capture(() =>
    batch.cmdIssue({ count: '200', batch: 'T3', channel: 'afdian', 'out-dir': BATCH_DIR, 'dry-run': true }),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /afdian-T3-001/);
  assert.match(result.output, /afdian-T3-200/);
  assert.equal(license.readLedger().length, before);
  assert.equal(fs.existsSync(path.join(BATCH_DIR, 'codes-afdian-T3.txt')), false);
});

test('批次：list 与 show 都能读出已签的批次', async () => {
  const listed = await capture(() => batch.cmdList({ dir: BATCH_DIR }));
  assert.match(listed.output, /afdian-T1/);

  const shown = await capture(() => batch.cmdShow({ dir: BATCH_DIR, batch: 'T1', channel: 'afdian' }));
  assert.match(shown.output, /afdian-T1-001/);
  // show 打印的是码本身（要能直接复制）
  assert.match(shown.output, /GW1-[A-Z2-7]+\./);

  const missing = await capture(() => batch.cmdShow({ dir: BATCH_DIR, batch: 'NOTHERE', channel: 'afdian' }));
  assert.equal(missing.exitCode, 1);
});

/* ==================== 码池与统计 ==================== */

test('码池：剥空白、按「真身」去重、脏行单独报出来', () => {
  const a = code('afdian-T1-001', 1);
  const b = code('afdian-T1-002', 2);
  // 载荷段改成小写 —— 是同一个码的另一种写法，不该算两枚
  const aLower = `gw1-${a.slice(4, a.indexOf('.')).toLowerCase()}${a.slice(a.indexOf('.'))}`;

  const pool = stock.parsePool(`\r\n  ${a}  \r\n${b}\r\n${aLower}\r\n这不是码\r\n\r\n`);

  assert.equal(pool.codes.length, 2);
  assert.equal(pool.duplicates.length, 1);
  assert.deepEqual(pool.malformed, ['这不是码']);
  assert.equal(pool.lines, 4);
});

test('码池：逐枚验签分得出「本机的码」与「陌生码」', () => {
  const mine = code('afdian-T1-001', 1);
  const foreign = code('someone-else-001', 1, '2026-10-10', FOREIGN_KEYPAIR);

  const { valid, foreign: strangers } = stock.classifyPool([mine, foreign], KEYPAIR.publicKeyB64Url);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].serial, 1);
  assert.equal(strangers.length, 1);
  assert.equal(strangers[0].code, foreign);

  // 没有公钥时不能假装验过了
  assert.equal(stock.classifyPool([mine], '').valid.length, 0);
});

test('重复追加守卫：新签的码只要有一枚已经在池子里，就判定为「上次其实成功了」', () => {
  const entries = [{ code: code('afdian-T9-001', 101) }, { code: code('afdian-T9-002', 102) }];
  const poolWithOne = [code('afdian-T9-002', 102)];
  assert.equal(stock.overlapWithPool(entries, poolWithOne).length, 1);
  assert.equal(stock.overlapWithPool(entries, []).length, 0);
  // 载荷段大小写不同也是同一枚
  const poolLower = [`GW1-${code('afdian-T9-001', 101).slice(4, code('afdian-T9-001', 101).indexOf('.')).toLowerCase()}${code('afdian-T9-001', 101).slice(code('afdian-T9-001', 101).indexOf('.'))}`];
  assert.equal(stock.overlapWithPool(entries, poolLower).length, 1);
});

test('件数统计：只认交易成功，按型号算，一件多份算多件', () => {
  const orders = [
    paidOrder('o1'),
    paidOrder('o2', { count: 2 }),
    paidOrder('o3', { status: 1 }), // 未支付
    paidOrder('o4', { skuId: 'OTHER' }), // 别的型号
    paidOrder('o5', { planId: 'OTHERPLAN' }), // 别的方案
    { out_trade_no: 'o6', status: 2, plan_id: 'PLAN', sku_detail: [] }, // 没有型号明细
  ];
  const sold = stock.countSold(orders, { planId: 'PLAN', skuId: 'SKU' });

  assert.equal(sold.orderCount, 2);
  assert.equal(sold.units, 3);
  assert.equal(sold.skippedStatus, 1);
  assert.equal(sold.skippedSku, 1);
  assert.equal(sold.skippedPlan, 1);
  assert.equal(sold.noSkuDetail, 1);
});

/* ==================== 对账判定 ==================== */

test('对账：池子 − 消耗 − 已售 三边对齐时判 ok', () => {
  const manifestCodes = Array.from({ length: 50 }, (_, i) => code(`afdian-T4-${String(i + 1).padStart(3, '0')}`, i + 1));
  const report = stock.reconcile({
    poolCodes: manifestCodes.slice(5),
    manifestCodes,
    ledgerEntries: manifestCodes.map((c, i) => ({ n: i + 1, code: c })),
    sold: { units: 5, orderCount: 5 },
  });

  assert.equal(report.level, 'ok');
  assert.equal(report.poolCount, 45);
  assert.equal(report.consumed, 5);
  assert.equal(report.drift, 0);
});

test('对账：池子里混进陌生码 = alert（买到的人激活不了）', () => {
  const report = stock.reconcile({
    poolCodes: [code('afdian-T4-001', 1)],
    foreignCodes: [code('someone-else-001', 1, '2026-10-10', FOREIGN_KEYPAIR)],
    manifestCodes: [code('afdian-T4-001', 1)],
    sold: { units: 0, orderCount: 0 },
  });
  assert.equal(report.level, 'alert');
  assert.match(report.notes.join('\n'), /不是本机私钥签发/);
});

test('对账：池子空了 = alert（还在卖就是收了钱发不出码）', () => {
  const report = stock.reconcile({ poolCodes: [], manifestCodes: [], sold: { units: 0, orderCount: 0 } });
  assert.equal(report.level, 'alert');
  assert.match(report.notes.join('\n'), /池子是空的/);
});

test('对账：卖出的比消耗的多 = warn（有单没拿到码，或池子被覆盖过）', () => {
  const manifestCodes = Array.from({ length: 50 }, (_, i) => code(`afdian-T5-${String(i + 1).padStart(3, '0')}`, i + 101));
  const report = stock.reconcile({
    poolCodes: manifestCodes.slice(2), // 只消耗了 2 枚
    manifestCodes,
    ledgerEntries: manifestCodes.map((c, i) => ({ n: i + 101, code: c })),
    sold: { units: 5, orderCount: 5 }, // 却卖了 5 件
  });

  assert.equal(report.drift, -3);
  assert.equal(report.level, 'warn');
  assert.match(report.notes.join('\n'), /没拿到码|覆盖/);
});

test('对账：低于水位就提示补货，水位线以上不提', () => {
  const many = Array.from({ length: 20 }, (_, i) => code(`afdian-T6-${String(i + 1).padStart(3, '0')}`, i + 201));
  const low = stock.reconcile({ poolCodes: many.slice(0, 4), manifestCodes: many, ledgerEntries: many.map((c, i) => ({ n: i + 201, code: c })), sold: { units: 16, orderCount: 16 }, lowWater: 10, restockSize: 50 });
  assert.equal(low.level, 'warn');
  assert.match(low.notes.join('\n'), /建议补 50 枚/);

  const high = stock.reconcile({ poolCodes: many, manifestCodes: many, ledgerEntries: many.map((c, i) => ({ n: i + 201, code: c })), sold: { units: 0, orderCount: 0 }, lowWater: 10 });
  assert.equal(high.level, 'ok');
  assert.match(stock.formatReconcile(high), /池存量\s+20 枚/);
});

/* ==================== 三条命令整条链子 ==================== */

test('status：拉池子 × 拉订单 × 台账 × 批次清单，对出「还能卖多少」', async () => {
  // 单独一个批次目录：对账里的「本机批次清单」是**目录级**的，混进别的测试批次会让消耗数对不上
  const statusDir = path.join(TMP_ROOT, 'statusdir');
  const manifest = await issueBatch('S1', 50, { dir: statusDir });
  const fake = fakeApi({
    poolText: manifest.codes.slice(5).join('\n') + '\n',
    orders: Array.from({ length: 5 }, (_, i) => paidOrder(`202610100000000000000000${i + 1}`)),
  });
  stock.setTransport(fake.handler);

  try {
    const result = await capture(() => stock.cmdStatus({ dir: statusDir }, CONFIG));

    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /线上池存量\t\t45 枚/);
    assert.match(result.output, /线上已售\t\t5 件/);
    assert.match(result.output, /本批已消耗\t\t5 枚/);
    assert.match(result.output, /没有异常/);

    // 拉订单要分页、每页 100
    const orderCalls = fake.calls.filter((call) => call.pathname === '/api/open/query-order');
    assert.equal(orderCalls.length, 1);
    assert.equal(orderCalls[0].params.per_page, 100);

    // 每个请求都带着合法签名
    for (const call of fake.calls) {
      assert.equal(call.body.sign, stock.afdianSign(CONFIG.token, call.body.params, call.body.ts, CONFIG.userId));
      assert.ok(!JSON.stringify(call.body).includes(CONFIG.token));
    }
  } finally {
    stock.setTransport(null);
  }
});

test('who：按订单号查出这单实际发出去的那枚码，并报出批次', async () => {
  const statusDir = path.join(TMP_ROOT, 'statusdir');
  const manifest = batch.listManifests(statusDir).find((m) => m.batch === 'S1');
  const issued = manifest.codes[7];

  const fake = fakeApi({ poolText: '' });
  fake.state.replies = [{ out_trade_no: '20261010000000000000001', content: issued }];
  stock.setTransport(fake.handler);

  try {
    const result = await capture(() => stock.cmdWho({ order: '20261010000000000000001' }, CONFIG));
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /标识 afdian-S1-008/);
    assert.match(result.output, /渠道 afdian｜批次 S1｜批内第 8 枚/);
  } finally {
    stock.setTransport(null);
  }
});

test('restock：默认只演练 —— 不追加、不落盘、不写台账', async () => {
  const fake = fakeApi({ poolText: '' });
  stock.setTransport(fake.handler);
  const ledgerBefore = license.readLedger().length;

  try {
    const result = await capture(() => stock.cmdRestock({ count: '30', batch: 'R0' }, CONFIG));
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /这是演练（dry-run）/);
    assert.equal(fake.calls.some((call) => call.pathname === '/api/open/update-plan-reply'), false);
    assert.equal(license.readLedger().length, ledgerBefore);
    assert.equal(fs.existsSync(path.join(BATCH_DIR, 'codes-afdian-R0.txt')), false);
  } finally {
    stock.setTransport(null);
  }
});

test('restock：--yes 才真追加，且永远只传 append、从不 overwrite', async () => {
  const manifest = await issueBatch('R1', 5);
  const fake = fakeApi({ poolText: manifest.codes.join('\n') + '\n' });
  stock.setTransport(fake.handler);

  try {
    const result = await capture(() => stock.cmdRestock({ count: '7', batch: 'R2', yes: true }, CONFIG));
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /已追加到线上码池/);

    const appendCalls = fake.calls.filter((call) => call.pathname === '/api/open/update-plan-reply');
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].params.sku_id, CONFIG.skuId);
    assert.equal(appendCalls[0].params.update_random_reply_type, 'append');
    assert.equal(fake.calls.some((call) => call.params?.update_random_reply_type === 'overwrite'), false);

    // 追加的正是新签的那 7 枚
    const pushed = stock.parsePool(appendCalls[0].params.auto_random_reply);
    assert.equal(pushed.codes.length, 7);

    // 落到线上的码 = 池子里的 5 枚 + 新追加的 7 枚
    assert.equal(stock.parsePool(fake.state.poolText).codes.length, 12);

    // 本地也留了凭据，并标了「已推送」
    const written = batch.listManifests(BATCH_DIR).find((m) => m.batch === 'R2');
    assert.ok(written);
    assert.equal(written.count, 7);
    assert.equal(written.pushed.mode, 'append');
    assert.ok(license.readLedger().some((entry) => entry.e === 'afdian-R2-001'));
  } finally {
    stock.setTransport(null);
  }
});

test('restock：码已经签好但推送失败时，本地照样落盘（不白签），只是不标已推送', async () => {
  const fake = fakeApi({ poolText: '', failOn: '/api/open/update-plan-reply' });
  stock.setTransport(fake.handler);

  try {
    const result = await capture(() => stock.cmdRestock({ count: '3', batch: 'R3', yes: true }, CONFIG));
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /追加失败/);
    assert.match(result.output, /本地照样落盘/);

    const written = batch.listManifests(BATCH_DIR).find((m) => m.batch === 'R3');
    assert.ok(written, '推送失败也必须留下码文件，否则这 3 枚码就白签了');
    assert.equal(written.pushed, undefined);
    assert.ok(fs.existsSync(path.join(BATCH_DIR, 'codes-afdian-R3.txt')));
  } finally {
    stock.setTransport(null);
  }
});

test('restock：上一次追加其实成功了 → 再签同一批必须停手（追加不能重放）', async () => {
  const fake = fakeApi({ poolText: '' });
  stock.setTransport(fake.handler);

  try {
    // 先演练一次拿到「将要签的码」（Ed25519 签名是确定性的，演练与实际签出完全一致）
    const dry = await capture(() => stock.cmdRestock({ count: '4', batch: 'R4' }, CONFIG));
    const firstCode = /首枚\s+(GW1-\S+)/.exec(dry.output)?.[1];
    assert.ok(firstCode, `演练输出里没找到首枚码：\n${dry.output}`);

    // 模拟「这枚码其实已经躺在线上了」
    fake.state.poolText = `${firstCode}\n`;
    const blocked = await capture(() => stock.cmdRestock({ count: '4', batch: 'R4', yes: true }, CONFIG));

    assert.equal(blocked.exitCode, 1);
    assert.match(blocked.output, /已经在线上池子里/);
    assert.equal(fake.calls.some((call) => call.pathname === '/api/open/update-plan-reply'), false);
    assert.equal(fs.existsSync(path.join(BATCH_DIR, 'codes-afdian-R4.txt')), false);
  } finally {
    stock.setTransport(null);
  }
});

test('配置：token 打码后再输出，任何地方都不打印原文', () => {
  assert.equal(stock.maskToken(''), '(未配置)');
  assert.equal(stock.maskToken('abc'), '***');
  const masked = stock.maskToken('0123456789abcdef');
  assert.ok(!masked.includes('456789ab'));
  assert.ok(masked.startsWith('012'));
  assert.ok(masked.endsWith('def'));
});

test('配置：saveConfig 写 600，loadConfig 读回来', async () => {
  const saved = stock.saveConfig({ ...CONFIG, file: path.join(TMP_ROOT, 'cfg.json') });
  const loaded = stock.loadConfig(saved);
  assert.equal(loaded.userId, DOC_UID);
  assert.equal(loaded.skuId, 'SKU');
  assert.equal(loaded.lowWater, 10);
  assert.equal(loaded.restockSize, 50);
});
