/**
 * 撤销名单（tools/license-audit.mjs）的签名互操作与台账审计测试。
 *
 * 这里只覆盖工具侧：签 → 验的往返、篡改必须失败、台账统计的判定规则、以及
 * audit/trace/revoke/export/status 这条链子在隔离目录里真跑一遍。
 * App 侧的名单验签是下一版的事，届时要在 license.test.mjs 里补一条跨实现用例。
 *
 * ★ 第一条是「隔离闸」：license.mjs 的 HOME_DIR 是**模块加载时**求值的常量，
 *   所以 GEWU_LICENSE_DIR 必须在 import 之前设好。设晚了不会报错，
 *   只会安静地对着真实的 ~/.gewu 跑测试 —— 那是不可逆的污染。
 *
 * ★ 命令函数走**进程内调用**，不 spawn 子进程：Windows + 本机文件系统 shim 下
 *   `execFileSync(process.execPath, …)` 会报 `spawnSync node.exe EBUSY`。
 *   真命令行的冒烟在本地手工跑（见 tools/license-audit.mjs 末尾的注释）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gewu-lic-audit-'));
process.env.GEWU_LICENSE_DIR = TMP_ROOT;

const audit = await import('../tools/license-audit.mjs');
const license = await import('../tools/license.mjs');

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/* ==================== 夹具 ==================== */

const KEYPAIR = license.makeKeypair();

function issueCode(subject, seq, date = '2026-10-09') {
  const payloadJson = license.encodePayload({ subject, date, seq });
  return license.buildCode(payloadJson, KEYPAIR.privateJwk);
}

function ledgerEntry(subject, seq, date = '2026-10-09') {
  return { n: seq, e: subject, d: date, issuedAt: `${date}T06:00:00.000Z`, code: issueCode(subject, seq, date) };
}

function signedList(entries, updatedAt = '2026-10-09T06:40:12.000Z') {
  const payloadJson = audit.buildRevocationPayload(entries, updatedAt);
  return audit.encodeRevocationList(payloadJson, KEYPAIR.privateJwk);
}

/** 换掉一个字符，但保证换完仍在同一字符集里（长度不变）。 */
function mutateChar(text, index, alphabet) {
  const original = text[index];
  const replacement = alphabet.split('').find((c) => c !== original);
  return text.slice(0, index) + replacement + text.slice(index + 1);
}

/** 跑一个命令函数并把它写到 stdout/stderr 的东西收上来。 */
function capture(fn) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;

  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  process.exitCode = 0;

  try {
    fn();
    return { output: lines.join('\n'), exitCode: process.exitCode ?? 0 };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 命令行那几条测试要的落盘夹具（密钥 + 台账），全部在临时目录里。 */
before(() => {
  fs.writeFileSync(
    path.join(TMP_ROOT, 'license_key.json'),
    JSON.stringify({ v: 1, createdAt: '2026-10-09T00:00:00.000Z', publicKey: KEYPAIR.publicKeyB64Url, privateJwk: KEYPAIR.privateJwk }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(TMP_ROOT, 'license_ledger.jsonl'),
    [ledgerEntry('afdian-8871', 1), ledgerEntry('afdian-8871', 2), ledgerEntry('xhs-5520', 3)]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
    'utf8',
  );
});

/* ==================== 0. 隔离闸 ==================== */

test('★ 隔离闸：HOME_DIR 必须落在临时目录，否则测试会写真实的 ~/.gewu', () => {
  assert.equal(license.HOME_DIR, TMP_ROOT);
  assert.equal(audit.REVOKED_LOG_FILE, path.join(TMP_ROOT, 'revoked.jsonl'));
  assert.equal(audit.REVOKED_LIST_FILE, path.join(TMP_ROOT, 'revoked.txt'));
});

/* ==================== 1. 渠道前缀 ==================== */

test('渠道前缀：取标识的第一段，中文标识与数字开头都算「没带前缀」', () => {
  assert.equal(audit.channelOf('afdian-8871'), 'afdian');
  assert.equal(audit.channelOf('afdian-8871-xhs'), 'afdian');
  assert.equal(audit.channelOf('AFDIAN_9'), 'afdian');
  assert.equal(audit.channelOf('张三'), '');
  assert.equal(audit.channelOf('123-abc'), '', '数字开头不是渠道名');
  assert.equal(audit.channelOf(''), '');
  assert.equal(audit.channelOf(null), '');
});

/* ==================== 2. 台账统计 ==================== */

test('台账概览：总数、序号范围、日期跨度、买卖家与渠道分布', () => {
  const report = audit.analyzeLedger([
    ledgerEntry('afdian-8871', 1),
    ledgerEntry('afdian-8871', 2),
    ledgerEntry('afdian-8872', 3),
    ledgerEntry('xhs-5520', 4, '2026-10-10'),
  ]);

  assert.equal(report.total, 4);
  assert.deepEqual(report.range, { from: 1, to: 4 });
  assert.deepEqual(report.dates, ['2026-10-09', '2026-10-10']);
  assert.equal(report.buyers.length, 3);
  assert.equal(report.buyers[0].subject, 'afdian-8871', '码数多的排前面');
  assert.equal(report.buyers[0].count, 2);
  assert.deepEqual(report.buyers[0].serials, [1, 2]);
  assert.deepEqual(report.channels, [
    ['afdian', 3],
    ['xhs', 1],
  ]);
});

test('一人多码要提示：2 个不吵人、≥3 提示、≥6 升级为警告', () => {
  const few = audit.analyzeLedger([ledgerEntry('a-1', 1), ledgerEntry('a-1', 2)]);
  assert.equal(few.findings.length, 0, '两个码还属于正常范围，不吵人');

  const some = audit.analyzeLedger([ledgerEntry('a-1', 1), ledgerEntry('a-1', 2), ledgerEntry('a-1', 3)]);
  assert.ok(some.findings.some((f) => f.includes('拿了 3 个码')));

  const many = audit.analyzeLedger(Array.from({ length: 6 }, (_, i) => ledgerEntry('afdian-8871', i + 1)));
  assert.ok(many.findings.some((f) => f.startsWith('⚠') && f.includes('6 个码')));
});

test('没带渠道前缀 / 标识像邮箱，都要单独提示', () => {
  const report = audit.analyzeLedger([ledgerEntry('张三', 1), ledgerEntry('buyer@outlook.com', 2)]);

  assert.ok(report.findings.some((f) => f.includes('没带渠道前缀')));
  assert.ok(report.findings.some((f) => f.includes('像邮箱')), '码是明文，标识里不该出现邮箱');
});

test('序号断档要抓出来（台账被手工改过的信号）', () => {
  const report = audit.analyzeLedger([ledgerEntry('a-1', 1), ledgerEntry('a-2', 2), ledgerEntry('a-3', 5)]);
  assert.equal(report.gaps.length, 1);
  assert.ok(report.gaps[0].includes('缺 2 个序号'));

  const fromTwo = audit.analyzeLedger([ledgerEntry('a-1', 2)]);
  assert.ok(fromTwo.gaps[0].includes('#1 → #2'));
});

test('同一个码挂在两个序号下要报警', () => {
  const duplicated = ledgerEntry('a-1', 1);
  const report = audit.analyzeLedger([duplicated, { ...duplicated, n: 2 }]);

  assert.equal(report.duplicates.length, 1);
  assert.ok(report.findings.some((f) => f.includes('码重复')));
});

/* ==================== 3. 撤销日志折叠 ==================== */

test('撤销状态按「后写覆盖先写」折叠：revoke → restore → revoke', () => {
  assert.equal(audit.foldRevocations([]).size, 0);

  const once = audit.foldRevocations([{ op: 'revoke', n: 7, subject: 'a-1', at: 'T1', reason: '倒卖' }]);
  assert.equal(once.size, 1);
  assert.equal(once.get(7).reason, '倒卖');

  const restored = audit.foldRevocations([
    { op: 'revoke', n: 7, subject: 'a-1', at: 'T1', reason: '倒卖' },
    { op: 'restore', n: 7, at: 'T2' },
  ]);
  assert.equal(restored.size, 0, 'restore 之后就不该再生效');

  const again = audit.foldRevocations([
    { op: 'revoke', n: 7, at: 'T1' },
    { op: 'restore', n: 7, at: 'T2' },
    { op: 'revoke', n: 7, at: 'T3' },
  ]);
  assert.equal(again.get(7).at, 'T3');
});

/* ==================== 4. 名单载荷与签名 ==================== */

test('载荷的键序是确定的（v, u, r / n, e, t, w）—— 序列化不确定签名就没法复现', () => {
  const entries = audit.foldRevocations([
    { op: 'revoke', n: 2, subject: 'b-2', at: 'T2', reason: 'w2' },
    { op: 'revoke', n: 1, subject: 'a-1', at: 'T1', reason: 'w1' },
  ]);
  const payloadJson = audit.buildRevocationPayload(entries, '2026-10-09T06:40:12.000Z');

  assert.ok(payloadJson.startsWith('{"v":1,"u":"2026-10-09T06:40:12.000Z","r":['));
  const payload = JSON.parse(payloadJson);
  assert.deepEqual(Object.keys(payload), ['v', 'u', 'r']);
  assert.deepEqual(Object.keys(payload.r[0]), ['n', 'e', 't', 'w']);
  assert.deepEqual(
    payload.r.map((i) => i.n),
    [1, 2],
    '按序号升序，输出稳定',
  );
});

test('签出来的名单能被自己的公钥验通，且载荷原样取回', () => {
  const entries = audit.foldRevocations([{ op: 'revoke', n: 127, subject: 'afdian-8871', at: 'T', reason: '闲鱼倒卖' }]);
  const text = signedList(entries);

  assert.match(text, /^GWREV1-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const result = audit.verifyRevocationList(text, KEYPAIR.publicKeyB64Url);
  assert.equal(result.ok, true);
  assert.equal(result.payload.v, 1);
  assert.equal(result.payload.r.length, 1);
  assert.deepEqual(result.payload.r[0], { n: 127, e: 'afdian-8871', t: 'T', w: '闲鱼倒卖' });
});

test('同一载荷与同一私钥必须产出同一份名单（签名确定性）', () => {
  const entries = audit.foldRevocations([{ op: 'revoke', n: 1, subject: 'a-1', at: 'T', reason: '' }]);
  assert.equal(signedList(entries), signedList(entries));
});

/* ==================== 5. 篡改与错配 ==================== */

test('★ 改签名段第一个字符 → 必须验不过（改末尾不算：base64 末尾几位解码时本就会丢）', () => {
  const text = signedList(audit.foldRevocations([{ op: 'revoke', n: 1, at: 'T' }]));
  const [body, signature] = text.slice('GWREV1-'.length).split('.');
  const broken = mutateChar(signature, 1, B64URL);

  assert.notEqual(broken, signature);
  assert.equal(audit.verifyRevocationList(`GWREV1-${body}.${broken}`, KEYPAIR.publicKeyB64Url).ok, false);
});

test('★ 改载荷段第一个字符 → 必须验不过（改了内容就不能还算数）', () => {
  const text = signedList(audit.foldRevocations([{ op: 'revoke', n: 1, at: 'T' }]));
  const [body, signature] = text.slice('GWREV1-'.length).split('.');
  const broken = mutateChar(body, 1, B64URL);

  assert.equal(audit.verifyRevocationList(`GWREV1-${broken}.${signature}`, KEYPAIR.publicKeyB64Url).ok, false);
});

test('换一把公钥 → 必须验不过（名单来自 A、公钥来自 B）', () => {
  const text = signedList(audit.foldRevocations([{ op: 'revoke', n: 1, at: 'T' }]));
  const stranger = license.makeKeypair();

  assert.equal(audit.verifyRevocationList(text, stranger.publicKeyB64Url).ok, false);
});

test('全零或长度不对的公钥一律不放行', () => {
  const text = signedList(audit.foldRevocations([{ op: 'revoke', n: 1, at: 'T' }]));
  const zeroKey = Buffer.from(new Uint8Array(32)).toString('base64url');

  assert.equal(audit.verifyRevocationList(text, zeroKey).ok, false);
  assert.equal(audit.verifyRevocationList(text, '').ok, false);
  assert.equal(audit.verifyRevocationList(text, 'AAAA').ok, false);
});

/* ==================== 6. 解析容错 ==================== */

test('名单是可粘贴的文本：剥掉空白照常通过，前缀大小写不敏感', () => {
  const text = signedList(audit.foldRevocations([{ op: 'revoke', n: 3, at: 'T', reason: 'x' }]));
  const wrapped = `${text.slice(0, 60)}\n  ${text.slice(60, 120)}\r\n${text.slice(120)}`;

  assert.equal(audit.verifyRevocationList(wrapped, KEYPAIR.publicKeyB64Url).ok, true);
  assert.equal(
    audit.verifyRevocationList(text.replace('GWREV1-', 'gwrev1-'), KEYPAIR.publicKeyB64Url).ok,
    true,
    '前缀大小写是手抄/转录的正常差异',
  );
});

test('空串、形状不对、载荷不是 JSON、签名长度不对，各有明确的原因码', () => {
  assert.equal(audit.parseRevocationList('').reason, 'empty');
  assert.equal(audit.parseRevocationList('乱七八糟').reason, 'format');
  assert.equal(audit.parseRevocationList('GWREV1-AAAAAAAA').reason, 'format');

  const bogusSegment = Buffer.from('不是 JSON', 'utf8').toString('base64url');
  const shortSig = Buffer.from(new Uint8Array(10)).toString('base64url');
  assert.equal(audit.parseRevocationList(`GWREV1-${bogusSegment}.${shortSig}`).reason, 'signature');

  const jsonSegment = Buffer.from('{"v":1,"u":"T"}', 'utf8').toString('base64url');
  const realSig = signedList(audit.foldRevocations([])).split('.')[1];
  assert.equal(audit.parseRevocationList(`GWREV1-${jsonSegment}.${realSig}`).reason, 'payload', '缺 r 数组');
});

test('空名单也是合法的：0 条撤销照样签得出来、验得过去', () => {
  const result = audit.verifyRevocationList(signedList(audit.foldRevocations([])), KEYPAIR.publicKeyB64Url);

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.r, []);
});

/* ==================== 7. 指纹 ==================== */

test('指纹稳定、对内容敏感，且忽略空白（同一份名单换行粘贴后指纹不变）', () => {
  const text = signedList(audit.foldRevocations([{ op: 'revoke', n: 1, at: 'T' }]));
  // 改**中间**的字符：改末尾可能落在 base64 的填充位上，文本变了而解码结果没变
  const changed = mutateChar(text, 10, B64URL);

  assert.notEqual(changed, text);
  assert.equal(audit.revocationFingerprint(text), audit.revocationFingerprint(text));
  assert.equal(audit.revocationFingerprint(text), audit.revocationFingerprint(`  ${text}\n`));
  assert.notEqual(audit.revocationFingerprint(text), audit.revocationFingerprint(changed));
  assert.match(audit.revocationFingerprint(text), /^[0-9a-f]{8}$/);
});

/* ==================== 8. 命令链（进程内跑一遍，落在隔离目录） ==================== */

test('端到端：audit → trace → revoke → export → status 全流程走通', () => {
  const auditOut = capture(() => audit.cmdAudit({}));
  assert.equal(auditOut.exitCode, 0);
  assert.ok(auditOut.output.includes('afdian-8871'), 'audit 要列出买家');
  assert.ok(auditOut.output.includes('只记录'), 'audit 要带上「台账不含使用信息」的提示');

  const traceBefore = capture(() => audit.cmdTrace({ serial: '3' }, []));
  assert.ok(traceBefore.output.includes('xhs-5520'));
  assert.ok(traceBefore.output.includes('未撤销'));

  const revoke = capture(() => audit.cmdRevoke({ serial: '3', reason: '闲鱼倒卖' }, []));
  assert.equal(revoke.exitCode, 0);
  assert.ok(revoke.output.includes('已撤销 #3'));

  const traceAfter = capture(() => audit.cmdTrace({ serial: '3' }, []));
  assert.ok(traceAfter.output.includes('已撤销'), '撤销后 trace 要看得出来');

  const exported = capture(() => audit.cmdExport({}));
  assert.ok(exported.output.includes('生效条目\t1'));

  const status = capture(() => audit.cmdStatus({}));
  assert.equal(status.exitCode, 0);
  assert.ok(status.output.includes('验签通过'));
  assert.ok(status.output.includes('#3'));

  const onDisk = fs.readFileSync(path.join(TMP_ROOT, 'revoked.txt'), 'utf8');
  assert.equal(audit.verifyRevocationList(onDisk, KEYPAIR.publicKeyB64Url).ok, true);

  // 落盘的东西必须都在隔离目录里（真实 ~/.gewu 一个字节都不该被碰）
  assert.ok(fs.existsSync(path.join(TMP_ROOT, 'revoked.jsonl')));
  assert.ok(fs.statSync(path.join(TMP_ROOT, 'revoked.jsonl')).size > 0, '撤销日志要有内容');
});

test('restore 能把撤销收回来，名单随之变空', () => {
  const restored = capture(() => audit.cmdRestore({ serial: '3' }, []));
  assert.ok(restored.output.includes('已恢复 #3'));

  capture(() => audit.cmdExport({}));
  const status = capture(() => audit.cmdStatus({}));
  assert.ok(status.output.includes('0 条'));
});

test('撤销不存在的序号要被拒绝（退出码非 0），且不写坏撤销日志', () => {
  const before = fs.readFileSync(path.join(TMP_ROOT, 'revoked.jsonl'), 'utf8');
  const result = capture(() => audit.cmdRevoke({ serial: '9999' }, []));

  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes('没有序号 #9999'));
  assert.equal(fs.readFileSync(path.join(TMP_ROOT, 'revoked.jsonl'), 'utf8'), before, '拒绝时不能留下半条记录');
});

test('trace 一个别人的码要拒绝，并说清不是本机签出去的', () => {
  const stranger = license.makeKeypair();
  const payloadJson = license.encodePayload({ subject: 'someone-else', date: '2026-10-09', seq: 500 });
  const strangerCode = license.buildCode(payloadJson, stranger.privateJwk);

  const result = capture(() => audit.cmdTrace({ code: strangerCode }, []));
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes('没通过校验'));
});
