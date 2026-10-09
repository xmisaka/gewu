#!/usr/bin/env node
/**
 * 格物 · 激活码台账审计与撤销名单（完全离线，零第三方依赖）
 *
 * 「发码」之后的问题，这个工具负责。但要先说清它能做什么、不能做什么 ——
 * 本方案刻意没有服务端，所以**没有任何通道把「码被激活了几次/在哪台设备」带回来**。
 * 台账记的是发出端：这个码是谁的、什么时候发的、他拿了几个。仅此而已。
 * 因此「某个码有没有被滥用」不可能是自动结论，只能靠三条间接信号：
 *
 *   1. 台账（这个文件）           —— 码是谁的
 *   2. 公开巡查（人工，见下方提示） —— 码在不在流通
 *   3. 联网上报（本方案不做）      —— 一码几台设备
 *
 * 本工具把第 1 条用尽，并给出第 2 条的入口清单。
 *
 * 子命令：
 *   audit    台账分布视图：谁拿了几个码、走的哪个渠道、哪天发的；标出可疑形态
 *   trace    反查一个码：解码 → 是谁的 → 有没有被撤销（网上看到码时用这条）
 *   revoke   把一个码（或其序号）列入撤销名单
 *   restore  撤销错了，取消一条
 *   export   生成签名后的撤销名单 revoked.txt（要传给 App 的就是这个文件）
 *   status   校验撤销名单的签名，并列出当前生效的撤销项
 *
 * ---------------------------------------------------------------------------
 * 撤销名单的格式与两条硬约定
 *
 *   GWREV1-<Base64URL(载荷 JSON 的 UTF-8 字节)>.<Base64URL(64 字节 Ed25519 签名)>
 *
 *   签名覆盖的消息 = **编码后那一段字符串**的 ASCII 字节（不是载荷 JSON）——
 *   与 license.mjs 同一条原则：签编码后的字符串，验签方不需要重新序列化 JSON，
 *   从根上避开键序/空白导致的「同一份内容两串字节」。
 *
 *   ★ 与激活码的唯一差异：撤销名单**没人手打**，所以用 base64url 而不是 Base32（更短）。
 *     代价是 base64url 大小写敏感，**拉下来时只能剥空白、不能改大小写**。
 *
 *   载荷形态（键序固定 v, u, r；r 内每项固定 n, e, t, w）：
 *     {"v":1,"u":"2026-10-09T06:40:12.000Z","r":[{"n":127,"e":"afdian-8871","t":"...","w":"闲鱼倒卖"}]}
 *
 *   ★ 为什么要签名：名单要从网上拉。不签名的话，被撤销的人把名单换成一份空的
 *     （改 hosts / 中间人 / 本地缓存）就恢复了 —— 撤销就成了摆设。
 *
 *   ★★ App 侧接入时最容易搞反的一条（下一版）：**名单拉不到、验不过，必须 fail-open**，
 *      即「当它里面什么都没有」，绝不能变成「激活失败」。撤销是额外的坏消息，
 *      不是激活的前提；把它做成 fail-closed，一次网络抽风就会锁死所有正版用户。
 *
 * ---------------------------------------------------------------------------
 * 为什么按「序号 n」撤销而不是按整串码
 *
 *   码的载荷 {e,t,d,n} 是**签名保护**的，n 改一位签名就废 —— 也就是说
 *   序号无法被伪造。撤销名单里只放 n 即可，短、可读、对账容易，且一样安全。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  HOME_DIR,
  ensureHomeDir,
  readLedger,
  readKeyFile,
  parseArgs,
  verifyCode,
  bytesToBase64Url,
  base64UrlToBytes,
} from './license.mjs';

export const REVOCATION_PREFIX = 'GWREV1';
export const REVOCATION_VERSION = 1;

/** 撤销操作日志（append-only，可恢复）：每行 {op:'revoke'|'restore', n, subject, at, reason} */
export const REVOKED_LOG_FILE = path.join(HOME_DIR, 'revoked.jsonl');

/** 生成物：签名后的撤销名单，一行文本，直接扔到站点上给 App 拉 */
export const REVOKED_LIST_FILE = path.join(HOME_DIR, 'revoked.txt');

const REVOCATION_RE = new RegExp(`^${REVOCATION_PREFIX}-([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)$`, 'i');
const SIGNATURE_BYTES = 64;

/** 巡查入口清单。写死在输出里，免得每次都要重新想「去哪儿搜」。 */
const PATROL_HINTS = [
  '关键词：格物 激活码 / 格物 会员 / 收纳 App 激活 / GW1-',
  '平台：闲鱼 · 拼多多 · 淘宝 · 贴吧 · 小红书 · QQ 与微信群的公开搜索',
  '命中后用 trace 反查是谁的码，再决定 revoke',
];

/* ==================== 纯函数（可测） ==================== */

/**
 * 从买家标识里取渠道前缀。约定：标识写成 `<渠道>-<订单尾号>[-备注]`，
 * 如 `afdian-8871` / `afdian-8871-xhs`。取不到前缀时返回空串。
 *
 * ★ 这一条不是形式主义：码泄漏后，「是谁」靠台账就能查到，但「哪个渠道泄的」
 *   只有前缀能回答。零成本，只在发码时换个写法。
 */
export function channelOf(subject) {
  const match = /^([A-Za-z][A-Za-z0-9]*)[-_]/.exec(String(subject ?? ''));
  return match ? match[1].toLowerCase() : '';
}

/**
 * 台账统计。只吃数据、不碰磁盘，方便测试直接喂数组。
 * 返回 { total, serials, range, dates, buyers, channels, gaps, duplicates, findings }
 */
export function analyzeLedger(entries) {
  const list = (entries ?? []).filter((e) => e && Number.isFinite(e.n) && typeof e.e === 'string');
  const serials = list.map((e) => e.n).sort((a, b) => a - b);

  const byBuyer = new Map();
  for (const entry of list) {
    if (!byBuyer.has(entry.e)) byBuyer.set(entry.e, []);
    byBuyer.get(entry.e).push(entry);
  }

  const buyers = [...byBuyer.entries()]
    .map(([subject, items]) => ({
      subject,
      count: items.length,
      serials: items.map((i) => i.n).sort((a, b) => a - b),
      dates: [...new Set(items.map((i) => i.d))].sort(),
      lastIssuedAt: items.reduce((acc, i) => (String(i.issuedAt ?? '') > acc ? String(i.issuedAt ?? '') : acc), ''),
      channel: channelOf(subject),
    }))
    .sort((a, b) => b.count - a.count || a.serials[0] - b.serials[0]);

  const channelCounts = new Map();
  for (const entry of list) {
    const key = channelOf(entry.e) || '(未带渠道前缀)';
    channelCounts.set(key, (channelCounts.get(key) ?? 0) + 1);
  }
  const channels = [...channelCounts.entries()].sort((a, b) => b[1] - a[1]);

  const dates = [...new Set(list.map((e) => e.d))].filter(Boolean).sort();

  // 序号断档：正常从 1 起连续递增；断档通常意味着台账被手工改过
  const gaps = [];
  if (serials.length && serials[0] !== 1) gaps.push(`#1 → #${serials[0]} 之间缺 ${serials[0] - 1} 个序号`);
  for (let i = 1; i < serials.length; i++) {
    if (serials[i] !== serials[i - 1] + 1) {
      gaps.push(`#${serials[i - 1]} → #${serials[i]} 之间缺 ${serials[i] - serials[i - 1] - 1} 个序号`);
    }
  }

  // 重复码：同一个码在两个序号下出现过 —— 说明台账被改过或签发流程出了岔子
  const seenCode = new Map();
  const duplicates = [];
  for (const entry of list) {
    if (seenCode.has(entry.code)) duplicates.push({ n: entry.n, firstSeenAt: seenCode.get(entry.code) });
    else seenCode.set(entry.code, entry.n);
  }

  const findings = [];
  for (const buyer of buyers) {
    if (buyer.count >= 6) {
      findings.push(`⚠「${buyer.subject}」累计拿了 ${buyer.count} 个码 —— 转卖或代购的典型形态，发之前先确认`);
    } else if (buyer.count >= 3) {
      findings.push(`·「${buyer.subject}」拿了 ${buyer.count} 个码 —— 可能是分批发或送人，留意`);
    }
    if (!buyer.channel) {
      findings.push(`·「${buyer.subject}」没带渠道前缀 —— 将来这个码泄漏了，查不出走哪个渠道出去的`);
    }
    if (String(buyer.subject).includes('@')) {
      findings.push(`·「${buyer.subject}」像邮箱 —— 码是明文发给买家的，标识里别放邮箱/手机号，用订单尾号`);
    }
  }
  for (const gap of gaps) findings.push(`⚠ 序号断档：${gap}（台账被手工改过？）`);
  for (const dup of duplicates) findings.push(`⚠ 码重复：序号 #${dup.n} 的码与 #${dup.firstSeenAt} 完全相同`);

  return {
    total: list.length,
    serials,
    range: serials.length ? { from: serials[0], to: serials[serials.length - 1] } : null,
    dates,
    buyers,
    channels,
    gaps,
    duplicates,
    findings,
  };
}

/**
 * 把 append-only 的操作日志折叠成「当前生效的撤销集合」。
 * 同一序号后写的操作覆盖先写的：revoke 后 restore 即恢复，再来一次 revoke 又生效。
 */
export function foldRevocations(logEntries) {
  const state = new Map();
  for (const raw of logEntries ?? []) {
    if (!raw || !Number.isFinite(raw.n)) continue;
    if (raw.op === 'revoke') {
      state.set(raw.n, {
        n: raw.n,
        subject: String(raw.subject ?? ''),
        at: String(raw.at ?? ''),
        reason: String(raw.reason ?? ''),
      });
    } else if (raw.op === 'restore') {
      state.delete(raw.n);
    }
  }
  return state;
}

/** 撤销名单载荷。键序固定 v, u, r（r 内 n, e, t, w）—— 序列化必须确定性。 */
export function buildRevocationPayload(entries, updatedAt) {
  const r = [...entries.values()]
    .sort((a, b) => a.n - b.n)
    .map((e) => ({ n: e.n, e: e.subject, t: e.at, w: e.reason }));
  return JSON.stringify({ v: REVOCATION_VERSION, u: updatedAt, r });
}

/** 用私钥 JWK 对撤销名单载荷签出完整的一行文本。 */
export function encodeRevocationList(payloadJson, privateJwk) {
  const segment = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const signature = crypto.sign(null, Buffer.from(segment, 'ascii'), key);
  return `${REVOCATION_PREFIX}-${segment}.${bytesToBase64Url(signature)}`;
}

/** 解析撤销名单：只做形状与编码层检查，不验签。输入容错：剥掉所有空白。 */
export function parseRevocationList(text) {
  const raw = String(text ?? '').replace(/\s+/g, '');
  if (!raw) return { ok: false, reason: 'empty' };

  const match = REVOCATION_RE.exec(raw);
  if (!match) return { ok: false, reason: 'format' };
  const [, segment, signatureText] = match;

  let payloadJson;
  let signature;
  try {
    payloadJson = Buffer.from(base64UrlToBytes(segment)).toString('utf8');
    signature = Buffer.from(base64UrlToBytes(signatureText));
  } catch {
    return { ok: false, reason: 'signature' };
  }
  if (signature.length !== SIGNATURE_BYTES) return { ok: false, reason: 'signature' };

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'payload' };
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.r)) {
    return { ok: false, reason: 'payload' };
  }

  return { ok: true, segment, payloadJson, payload, signature };
}

/** 解析 + 验签。publicKeyB64Url 为 32 字节原始公钥的 base64url（与激活码同一把）。 */
export function verifyRevocationList(text, publicKeyB64Url) {
  const parsed = parseRevocationList(text);
  if (!parsed.ok) return parsed;

  let publicKey;
  try {
    publicKey = base64UrlToBytes(publicKeyB64Url);
  } catch {
    return { ok: false, reason: 'key' };
  }
  if (publicKey.length !== 32) return { ok: false, reason: 'key' };

  let good = false;
  try {
    const keyObject = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyB64Url },
      format: 'jwk',
    });
    good = crypto.verify(null, Buffer.from(parsed.segment, 'ascii'), keyObject, parsed.signature);
  } catch {
    return { ok: false, reason: 'signature' };
  }

  if (!good) return { ok: false, reason: 'signature' };
  return { ok: true, payload: parsed.payload };
}

/**
 * 名单指纹（sha256 前 8 位）。判据只能是它 —— 传输成功不等于内容正确。
 * 比对前先剥掉空白：文件末尾的换行、粘贴时带的空格都不该影响指纹。
 */
export function revocationFingerprint(text) {
  const normalized = String(text ?? '').replace(/\s+/g, '');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 8);
}

/* ==================== 本地文件 ==================== */

function readRevocationLog() {
  if (!fs.existsSync(REVOKED_LOG_FILE)) return [];
  return fs
    .readFileSync(REVOKED_LOG_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendRevocationLog(entry) {
  ensureHomeDir();
  fs.appendFileSync(REVOKED_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

/** 从本机密钥文件取公钥（trace/revoke 要解别人贴过来的码，只能用本机公钥自检）。 */
function requirePublicKey() {
  const keyFile = readKeyFile();
  if (!keyFile || !keyFile.publicKey) {
    console.error('本机没有密钥文件（~/.gewu/license_key.json）——解不开码，也没法签名。');
    console.error('先跑 `node tools/license.mjs keygen`，或把密钥文件放回去。');
    process.exitCode = 1;
    return null;
  }
  return keyFile;
}

/** 解析「要处理哪个码」：--code / --serial / 位置参数三种写法都接。 */
function resolveTarget(flags, positional) {
  const codeFlag = typeof flags.code === 'string' ? flags.code : null;
  const serialFlag = flags.serial !== undefined && flags.serial !== true ? Number.parseInt(String(flags.serial), 10) : null;
  const loose = positional[0] ? positional[0] : null;

  if (codeFlag) return { kind: 'code', code: codeFlag };
  if (loose && /^gw1-/i.test(loose)) return { kind: 'code', code: loose };
  if (serialFlag !== null && Number.isFinite(serialFlag)) return { kind: 'serial', serial: serialFlag };
  if (loose && /^\d+$/.test(loose)) return { kind: 'serial', serial: Number.parseInt(loose, 10) };
  return null;
}

/** 把码或序号统一解成 { serial, subject, issuedAt }；序号走台账查码。 */
function resolveIdentity(target, keyFile) {
  if (target.kind === 'code') {
    const result = verifyCode(target.code, keyFile.publicKey);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, serial: result.payload.n, subject: result.payload.e, issuedAt: result.payload.d, code: target.code };
  }

  const entry = readLedger().find((e) => e.n === target.serial);
  if (!entry) return { ok: false, reason: 'ledger-miss' };
  const result = verifyCode(entry.code, keyFile.publicKey);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, serial: result.payload.n, subject: result.payload.e, issuedAt: result.payload.d, code: entry.code };
}

/* ==================== 子命令 ==================== */

function cmdAudit(flags) {
  const ledger = readLedger();
  if (!ledger.length) {
    console.log('台账为空 —— 还没有发过码。');
    console.log(`台账文件：${readLedgerPath()}`);
    return;
  }

  const report = analyzeLedger(ledger);

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`台账：${readLedgerPath()}\n`);

  console.log('概览');
  console.log(`  码总数\t\t${report.total}`);
  console.log(`  序号范围\t\t#${report.range.from} – #${report.range.to}`);
  console.log(`  签发日期\t\t${report.dates[0]} → ${report.dates[report.dates.length - 1]}`);
  console.log(`  买家标识\t\t${report.buyers.length} 个`);

  console.log('\n按渠道');
  for (const [channel, count] of report.channels) console.log(`  ${channel}\t${count}`);

  console.log('\n按买家（码数多的排前面）');
  console.log('  标识\t码数\t序号\t签发日期');
  for (const buyer of report.buyers) {
    const serials = buyer.serials.map((n) => `#${n}`).join(' ');
    console.log(`  ${buyer.subject}\t${buyer.count}\t${serials}\t${buyer.dates.join(' ')}`);
  }

  const revoked = foldRevocations(readRevocationLog());
  if (revoked.size) {
    console.log('\n已撤销');
    for (const item of [...revoked.values()].sort((a, b) => a.n - b.n)) {
      console.log(`  #${item.n}\t${item.subject}\t${item.reason || '(未写理由)'}`);
    }
  }

  console.log('\n结论');
  if (report.findings.length) {
    for (const line of report.findings) console.log(`  ${line}`);
  } else {
    console.log('  没有异常形态。');
  }

  console.log('\n提示：台账只记录「码发给了谁」，不包含任何使用信息。');
  console.log('     「某个码是否在流通」要靠公开巡查 ——');
  for (const hint of PATROL_HINTS) console.log(`       ${hint}`);
}

function cmdTrace(flags, positional) {
  const keyFile = requirePublicKey();
  if (!keyFile) return;

  const target = resolveTarget(flags, positional);
  if (!target) {
    console.error('用法：node tools/license-audit.mjs trace --code GW1-... （或 --serial 7）');
    process.exitCode = 1;
    return;
  }

  const identity = resolveIdentity(target, keyFile);
  if (!identity.ok) {
    if (identity.reason === 'ledger-miss') {
      console.error(`台账里没有序号 #${target.serial} 这条记录。`);
    } else {
      console.error(`这个码没通过校验：${identity.reason}`);
      console.error('不是本机私钥签出去的码 —— 要么抄错了，要么根本不是你的码。');
    }
    process.exitCode = 1;
    return;
  }

  const ledgerEntry = readLedger().find((e) => e.n === identity.serial);
  const revoked = foldRevocations(readRevocationLog()).get(identity.serial);

  console.log(`标识\t\t${identity.subject}`);
  console.log(`序号\t\t#${identity.serial}`);
  console.log(`签发日期\t${identity.issuedAt}`);
  console.log(`台账签发\t${ledgerEntry ? ledgerEntry.issuedAt : '(台账里没有这条)'}`);
  console.log(`渠道\t\t${channelOf(identity.subject) || '(未带渠道前缀)'}`);
  console.log(`撤销状态\t${revoked ? `已撤销 · ${revoked.reason || '未写理由'} · ${revoked.at}` : '未撤销'}`);
  console.log(`\n码串\t\t${identity.code}`);
}

function cmdRevoke(flags, positional) {
  const keyFile = requirePublicKey();
  if (!keyFile) return;

  const target = resolveTarget(flags, positional);
  if (!target) {
    console.error('用法：node tools/license-audit.mjs revoke --code GW1-... --reason "闲鱼倒卖"');
    console.error('      node tools/license-audit.mjs revoke --serial 7 --reason "..."');
    process.exitCode = 1;
    return;
  }

  const identity = resolveIdentity(target, keyFile);
  if (!identity.ok) {
    if (identity.reason === 'ledger-miss') console.error(`台账里没有序号 #${target.serial} 这条记录，拒绝撤销。`);
    else console.error(`这个码没通过校验（${identity.reason}）—— 不是本机私钥签出去的码，拒绝撤销。`);
    process.exitCode = 1;
    return;
  }

  const current = foldRevocations(readRevocationLog());
  if (current.has(identity.serial)) {
    console.log(`#${identity.serial}（${identity.subject}）已经在撤销名单里了，没有重复追加。`);
    return;
  }

  const entry = {
    op: 'revoke',
    n: identity.serial,
    subject: identity.subject,
    at: new Date().toISOString(),
    reason: typeof flags.reason === 'string' ? flags.reason : '',
  };
  appendRevocationLog(entry);

  console.log(`已撤销 #${identity.serial}（${identity.subject}）${entry.reason ? ` · ${entry.reason}` : ''}`);
  console.log(`生效条数：${current.size + 1}`);
  console.log('\n下一步：跑 `node tools/license-audit.mjs export` 生成 revoked.txt，再上传到站点。');
  console.log('★ 上传后要核对线上文件的指纹一致 —— 传输成功不等于内容正确。');
}

function cmdRestore(flags, positional) {
  const keyFile = requirePublicKey();
  if (!keyFile) return;

  const target = resolveTarget(flags, positional);
  if (!target || target.kind !== 'serial') {
    console.error('用法：node tools/license-audit.mjs restore --serial 7');
    console.error('（恢复要按序号，避免拿一个码反推出错的序号）');
    process.exitCode = 1;
    return;
  }

  const current = foldRevocations(readRevocationLog());
  if (!current.has(target.serial)) {
    console.log(`#${target.serial} 当前不在撤销名单里（可能本来就没撤，或者已经恢复过）。`);
    return;
  }

  const entry = {
    op: 'restore',
    n: target.serial,
    subject: current.get(target.serial).subject,
    at: new Date().toISOString(),
    reason: typeof flags.reason === 'string' ? flags.reason : '',
  };
  appendRevocationLog(entry);

  console.log(`已恢复 #${target.serial}（${entry.subject}）`);
  console.log(`生效条数：${current.size - 1}`);
  console.log('\n记得重新 export 并上传。');
}

function cmdExport(flags) {
  const keyFile = requirePublicKey();
  if (!keyFile) return;

  const effective = foldRevocations(readRevocationLog());
  const updatedAt = new Date().toISOString();
  const payloadJson = buildRevocationPayload(effective, updatedAt);
  const listText = encodeRevocationList(payloadJson, keyFile.privateJwk);

  const outPath = typeof flags.out === 'string' ? flags.out : REVOKED_LIST_FILE;
  fs.writeFileSync(outPath, listText + '\n', 'utf8');

  console.log(`已生成撤销名单：${outPath}`);
  console.log(`  生效条目\t${effective.size}`);
  console.log(`  更新时间\t${updatedAt}`);
  console.log(`  指纹\t\t${revocationFingerprint(listText)}  (sha256 前 8 位)`);

  if (effective.size) {
    console.log('\n  序号\t标识\t理由');
    for (const item of [...effective.values()].sort((a, b) => a.n - b.n)) {
      console.log(`  #${item.n}\t${item.subject}\t${item.reason || '(未写理由)'}`);
    }
  }

  console.log('\n下一步：把 revoked.txt 放到站点上（与 version.json 同源），App 侧下一版接入后生效。');
  console.log('★ 上传后用服务器侧 curl 取回、比对指纹 —— 传输成功不等于内容正确。');
}

function cmdStatus(flags) {
  const filePath = typeof flags.file === 'string' ? flags.file : REVOKED_LIST_FILE;
  if (!fs.existsSync(filePath)) {
    console.log(`还没有生成过撤销名单：${filePath}`);
    console.log('跑 `node tools/license-audit.mjs export` 生成。');
    return;
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const keyFile = readKeyFile();
  const result = verifyRevocationList(text, keyFile ? keyFile.publicKey : '');

  console.log(`名单文件：${filePath}`);
  console.log(`指纹\t\t${revocationFingerprint(text.replace(/\s+/g, ''))}`);

  if (!result.ok) {
    console.error(`验签失败：${result.reason}`);
    console.error('★ App 侧遇到这种情况必须当「名单为空」处理（fail-open），绝不能因此拒绝激活。');
    process.exitCode = 1;
    return;
  }

  console.log(`验签通过\tv${result.payload.v} · 更新于 ${result.payload.u} · ${result.payload.r.length} 条`);
  if (result.payload.r.length) {
    console.log('\n  序号\t标识\t理由');
    for (const item of result.payload.r) console.log(`  #${item.n}\t${item.e}\t${item.w || '(未写理由)'}`);
  }
}

function readLedgerPath() {
  return HOME_DIR ? path.join(HOME_DIR, 'license_ledger.jsonl') : '(未知)';
}

const HELP = `格物 · 激活码台账审计与撤销

  node tools/license-audit.mjs audit [--json]            台账分布视图 + 可疑形态
  node tools/license-audit.mjs trace --code GW1-...      反查一个码是谁的（或 --serial 7）
  node tools/license-audit.mjs revoke --serial 7 --reason "闲鱼倒卖"
  node tools/license-audit.mjs restore --serial 7        撤销错了，恢复
  node tools/license-audit.mjs export [--out file]       生成签名后的 revoked.txt
  node tools/license-audit.mjs status [--file file]      验签并列出当前撤销项

先说清楚：台账只记录「码发给了谁」，不包含任何使用信息。
「某个码有没有被滥用」只能靠三条间接信号 —— 台账 / 公开巡查 / 联网上报（本方案不做）。`;

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  switch (command) {
    case 'audit':
      cmdAudit(flags);
      break;
    case 'trace':
      cmdTrace(flags, positional.slice(1));
      break;
    case 'revoke':
      cmdRevoke(flags, positional.slice(1));
      break;
    case 'restore':
      cmdRestore(flags, positional.slice(1));
      break;
    case 'export':
      cmdExport(flags);
      break;
    case 'status':
      cmdStatus(flags);
      break;
    default:
      console.log(HELP);
      if (command) process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

// 命令函数导出给测试用。★ 为什么不 spawn 子进程跑 CLI：
//   在 Windows + 本机的文件系统 shim 下，`execFileSync(process.execPath, …)`
//   会报 `spawnSync node.exe EBUSY`（同一份 node.exe 被当前进程占着）。
//   所以测试走进程内调用，另在本地手工跑一次真命令行做冒烟。
export { cmdAudit, cmdTrace, cmdRevoke, cmdRestore, cmdExport, cmdStatus };
